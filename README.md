# Kilovolt DB
File-system style database built on top of [Deno KV](https://docs.deno.com/api/deno/~/Deno.Kv).

## KV flag 
As of Deno 2.8, the `--unstable-kv` flag is required for Deno KV to work.

## Direct usage
```js
// Import KilovoltDB
import { KilovoltDB } from "./db.js"

// Create and initialise the database
const db = await KilovoltDB.init("main")

// Set a value
await db.set("users/123/details", {name: "Tikolu"})

// Get a value
const value = await db.get("users/123/details")
console.log(value) // {name: "Tikolu"}

// List all values at an index
const users = await db.getIndex("users/123")
console.log(users) // ["details", "friends", ...]

// Delete a value
await db.delete("users/123/friends")

// Recursively delete an index's entire subtree
await db.deleteSubtree("users/123")
```

## API
Use `api.js` to host a simple API for interacting with the database. Default host and port is `localhost:1000`, use `--host` and `--port` parameters to customise this.
```bash
deno --unstable-kv api.js --host=<host> --port=<port>
```
Supported actions: `get`, `set`, `index`, and `delete`. Example JSON POST request body:
```json
{"action": "set", "key": "users/123/details", "value": {"name": "Tikolu"}}
```

WebSocket connections are also supported and follow the same syntax.

## Binary storage
Binary data can be written using WebSocket connections. Omit the `value` field of the `set` action and send raw binary data in a subsequent message. Binary data is returned from the API directly, without any encapsulation.

KilovoltDB automatically splits large data into 65kb chunks to not exceed Deno KV's limits.

## Configuration
Use the `STORAGE_PATH` environment variable to change the default data storage directory. Default is `./db/`.

To secure the API, provide the `KEY_HASH` environment variable with a SHA-256 hash of the desired API key. Then pass the key in each request using the `Authorization` header with the format `Basic <key>`.