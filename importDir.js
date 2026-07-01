import { KilovoltDB } from "./db.js"
import { parseArgs } from "jsr:@std/cli/parse-args"

const args = parseArgs(Deno.args, {
	string: ["db", "dir"],
	boolean: ["verbose"]
})

const db = await KilovoltDB.init(args.db || "main", args.verbose)

const textDecoder = new TextDecoder("utf-8", {fatal: true})

async function importDir(dir, key=[]) {
	console.log("importing", dir)

	for await (const entry of Deno.readDir(dir)) {
		if(entry.isFile) {
			let value = await Deno.readFile(`${dir}/${entry.name}`)

			await db.set([...key, entry.name], value)
			if(args.verbose) {
				console.log("imported", [...key, entry.name].join("/"), "\n")
			}
		} else if(entry.isDirectory) {
			await importDir(`${dir}/${entry.name}`, [...key, entry.name])
		}
	}
}

if(args.dir) {
	await importDir(args.dir)
	console.log("Import complete")
	db.close()
} else {
	console.log("No directory specified for import")
}