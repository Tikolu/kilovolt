import { KilovoltDB } from "./db.js"
import { parseArgs } from "jsr:@std/cli/parse-args"
import { hash } from "node:crypto"

const args = parseArgs(Deno.args, {
	string: ["host", "port"],
	boolean: ["verbose"]
})

const keyHash = Deno.env.get("KEY_HASH")

if(!keyHash) {
	console.warn("KEY_HASH env not set, API is unprotected!")
}

async function action(body, db, socket=null) {
	if(!body.action) return {error: "Action is required"}

	if(!body.key) return {error: "Key is required"}

	if(body.action == "get") {
		return await db.get(body.key)

	} else if(body.action == "set") {
		if(body.base64) {
			if(body.value) return {error: "Cannot specify both value and base64"}
			body.value = Uint8Array.fromBase64(body.base64)
		}
		if(body.value === undefined) {
			if(!socket) return {error: "Value is required"}
			socket.hook = async data => {
				socket.hook = null
				if(!(data instanceof ArrayBuffer)) {
					return {error: "Expected binary data"}
				}
				return await db.set(body.key, new Uint8Array(data))
			}
			return {message: "Waiting for binary data"}
		}
		return await db.set(body.key, body.value)

	} else if(body.action == "delete") {
		return await db.delete(body.key)

	} else if(body.action == "deleteSubtree") {
		return await db.deleteSubtree(body.key)

	} else if(body.action == "index") {
		const index = await db.getIndex(body.key)
		return Array.from(index || [])

	} else {
		return {error: "Invalid action"}
	}
}

async function handleRequest(request) {
	const url = new URL(request.url)
	const path = url.pathname.split("/")

	// Authentication
	if(keyHash) {
		const auth = request.headers.get("authorization")?.split(" ")[1] || ""
		const authHash = hash("sha256", auth)
		if(authHash !== keyHash) {
			return createResponse({error: "Invalid authorization"}, 401)
		}
	}

	if(!path[1]) {
		return createResponse({error: "Database name not specified"}, 400)
	}

	// WebSocket mode
	if(request.headers.get("upgrade") == "websocket") {
		const {socket, response} = Deno.upgradeWebSocket(request)
		let dbPromise

		socket.onopen = () => {
			dbPromise = KilovoltDB.init(path[1], args.verbose)
		}

		socket.onmessage = async event => {
			let result = {}

			if(socket.hook) result = await socket.hook(event.data)

			else {
				try {
					const body = JSON.parse(event.data)
					const db = await dbPromise
					result = await action(body, db, socket)
				} catch (error) {
					console.error(error)
					result = {error: error.message}
				}
			}

			socket.send(
				result instanceof Uint8Array ? result :
				JSON.stringify(result)
			)
		}

		return response

	} else {
		if(request.method != "POST") {
			return createResponse({error: "Only POST requests are allowed"}, 405)
		}
		const body = await request.json()
		const db = await KilovoltDB.init(path[1], args.verbose)

		const result = await action(body, db)
		// Return raw binary data
		if(result instanceof Uint8Array) {
			return new Response(result, {
				headers: {
					"Content-Type": "application/octet-stream"
				}
			})
		}
		// Return JSON response
		return createResponse(result, result?.error ? 400 : 200)
	}
}

function createResponse(data, status = 200) {
	if(data instanceof Response) {
		return data
	}

	data = JSON.stringify(data)
	return new Response(data, {
		headers: {
			"Content-Type": "application/json"
		},
		status
	})
}

Deno.serve({
	hostname: args.host || "localhost",
	port: Number(args.port || 1000)
}, async (request) => {
	const response = await handleRequest(request).catch(error => {
		console.error(error)
		return createResponse({error: error.message}, 500)
	})
	return createResponse(response)
})