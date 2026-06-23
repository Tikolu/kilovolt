const storagePath = Deno.env.get("STORAGE_PATH") || "db"
const instances = {}

function parseKey(key) {
	if(Array.isArray(key)) {
		return [...key]
	} else if(typeof key == "string") {
		if(key.includes("//")) throw new Error("Invalid key: contains empty segments")
		if(key !== "/") {
			if(key.startsWith("/")) throw new Error("Invalid key: starts with /")
			if(key.endsWith("/")) throw new Error("Invalid key: ends with /")
		}
		return key.split("/").filter(Boolean)
	} else {
		throw new Error("Invalid key type")
	}
}

function formatKey(key) {
	if(Array.isArray(key)) {
		return key.join("/")
	} else if(typeof key == "string") {
		return key
	} else {
		throw new Error("Invalid key type")
	}
}


export class KilovoltDB {
	static async init(dbName, verbose = false) {
		const instance = instances[dbName]
		if(instance) {
			instance.verbose = verbose
			return instance
		} else {
			const instance = new KilovoltDB(dbName, verbose)
			instances[dbName] = instance
			try {
				await instance.open()
			} catch (error) {
				delete instances[dbName]
				throw error
			}
			return instance
		}
	}

	static async closeAll() {
		for(const instance of Object.values(instances)) {
			await instance.close()
			delete instances[instance.dbName]
		}
	}

	constructor(dbName, verbose = false) {
		this.kv = null
		this.dbName = dbName
		this.verbose = verbose
		this.active = false
	}

	async open() {
		if(this.verbose) console.log("open", this.dbName)

		// Create db directory if it doesn't exist
		try {
			await Deno.mkdir(storagePath, {recursive: true})
		} catch {}

		this.kv = await Deno.openKv(`${storagePath}/${this.dbName}`)
		this.active = true
	}

	async close() {
		if(this.verbose) console.log("close", this.dbName)
		await this.kv.close()
		this.kv = null
	}

	async getIndex(key) {
		if(this.verbose) console.log(this.dbName, "get index", formatKey(key))
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)

		if(key.at(-1) != "_kvdb_index") {
			key.push("_kvdb_index")
		}

		const {value} = await this.kv.get(key)
		return value?._kvdb_index
	}

	async setIndex(key, index, recursive = false) {
		if(this.verbose) console.log(this.dbName, "set index", formatKey(key), index)
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)

		if(key.at(-1) != "_kvdb_index") {
			key.push("_kvdb_index")
		}

		if(!(index instanceof Set)) {
			throw new Error("Index must be a Set")
		}

		await this.kv.set(key, {_kvdb_index: index})

		if(recursive && key.length > 1) {
			const parentKey = key.slice(0, -2)
			const parentIndex = await this.getIndex(parentKey) || new Set()
			parentIndex.add(key.at(-2))
			await this.setIndex(parentKey, parentIndex, parentIndex.size == 1)
		}
	}

	async mergeParts(result) {
		const values = await Array.fromAsync(this.kv.list({
			prefix: [...result.key, `_kvdb_part`],
			limit: result.value._kvdb_split
		}))
		if(result.value._kvdb_type == "binary") {
			const totalLength = values.reduce((sum, v) => sum + v.value?.length || 0, 0)
			const merged = new Uint8Array(totalLength)
			let offset = 0
			for(const v of values) {
				merged.set(v.value, offset)
				offset += v.value.length
			}
			result.value = merged
		} else {
			result.value = values.map(v => v.value).join("")
		}
		return result
	}

	async get(key) {
		if(this.verbose) console.log(this.dbName, "get", formatKey(key))
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)
		let result = await this.kv.get(key)
		if(result.value?._kvdb_split) result = await this.mergeParts(result)
		return result.value
	}

	async set(key, value) {
		if(this.verbose) console.log(this.dbName, "set", formatKey(key))
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)

		// Split value into parts if it's too large
		if(value?.length > 65530 && (typeof value == "string" || value instanceof Uint8Array)) {
			const splitValues = []
			for(let i = 0; i < value.length; i += 65530) {
				splitValues.push(value.slice(i, i + 65530))
			}
			for(const [index, splitValue] of splitValues.entries()) {
				await this.kv.set([...key, "_kvdb_part", index], splitValue)
			}
			value = {
				_kvdb_split: splitValues.length,
				_kvdb_type: value instanceof Uint8Array ? "binary" : "text"
			}
		}
		const result = await this.kv.set(key, value).catch(error => {
			console.log(value, value.length)
			throw new Error("Failed to set key: " + error.message)
		})
		
		// Add key to index
		const indexKey = key.slice(0, -1)
		const index = await this.getIndex(indexKey) || new Set()
		index.add(key.at(-1))
		await this.setIndex(indexKey, index, index.size == 1)

		return result
	}

	async delete(key, removeFromIndex = true) {
		if(this.verbose) console.log(this.dbName, "delete", formatKey(key))
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)

		// Check if multiple parts exist
		const {value} = await this.kv.get(key)
		if(value?._kvdb_split) {
			for(let i = 0; i < value._kvdb_split; i++) {
				await this.kv.delete([...key, "_kvdb_part", i])
			}
		}

		// Delete key
		const result = await this.kv.delete(key)

		// Remove key from index
		if(removeFromIndex) {
			const indexKey = key.slice(0, -1)
			const index = await this.getIndex(indexKey) || new Set()
			index.delete(key.at(-1))
			await this.setIndex(indexKey, index)
		}

		return result
	}

	async exists(key) {
		if(this.verbose) console.log(this.dbName, "exists", formatKey(key))
		if(!this.active) throw new Error("Database is not open")

		key = parseKey(key)

		const {value} = await this.kv.get(key)
		return value !== null
	}

	async deleteSubtree(key, deleteSelf = true) {
		if(this.verbose) console.log(this.dbName, "delete subtree", formatKey(key))
		if(!this.active) throw new Error("Database is not open")
			
		key = parseKey(key)

		const index = await this.getIndex(key)

		for(const child of index || []) {
			await this.deleteSubtree([...key, child], false)
			await this.delete([...key, child], false)
		}

		if(index) await this.delete([...key, "_kvdb_index"], false)
	}
}