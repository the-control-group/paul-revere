const { build } = require('schemapack'),
	toBuffer = require('blob-to-buffer'),
	WebSocket = require('./websocket'),
	isNode = require('detect-node');

// Symbols to keep the class properties somewhat private
const schemaMap = Symbol('schemaMap'),
	ws = Symbol('websocket'),
	uwsc = Symbol('uwsClient'),
	bs = Symbol('builtSchema'),
	si = Symbol('schemaIndex'),
	rb = Symbol('receiveBuffer'),
	om = Symbol('onMessage');

/**
 * Universal message parser
 * @param {(Blob|Buffer|ArrayBuffer)} b - Schemapack message
 * @return {Promise} Resolves to Buffer and matching Schema
 */
function parseMessage(b, sMap) {
	return new Promise((res, rej) => {

		// Handle blobs
		if (typeof Blob !== 'undefined' && b instanceof Blob) {
			toBuffer(b, (err, buff) => {
				if(err) rej(err);

				const schema = sMap.get(buff[0]);

				res({schema, buff});
			});
		}

		// Handle Buffer/ArrayBuffer
		else {
			let buff = b;
			// Convert ArrayBuffer so we can parse the first byte for the right schema
			if(typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) buff = Buffer.from(b);

			try {
				const schema = sMap.get(buff[0]);

				res({schema, buff});
			} catch (e) {
				rej(e);
			}
		}
	});
}

/**
 * Schema class handles its own tranmission and reception of data
 */
class Schema {
	constructor(builtSchema, schemaIndex, websocket) {
		this[si] = schemaIndex;
		this[bs] = builtSchema;
		this[ws] = websocket;
		this[rb] = buff => {
			const msg = this[bs].decode(buff);

			delete msg.__schema;

			this[om](msg);
		};

		// Default to noop
		this[om] = () => {};
	}

	onMessage(cb) {
		this[om] = cb;
	}

	send(data = {}) {
		// Set the schema index
		data.__schema = this[si];
		this[ws].send(this[bs].encode(data));
	}

	broadcast(data = {}, exclude) {
		if(!this[ws].clients) throw Error('Cannot broadcast from single client');

		this[ws].clients.forEach(c => {
			// Exclude a specific client
			if(exclude && c === exclude[uwsc]) return;

			// Set the schema index
			data.__schema = this[si];

			c.send(this[bs].encode(data));
		});
	}
}

class Client {
	constructor(uwsClient, builtSchemas) {
		this[uwsc] = uwsClient;
		this[schemaMap] = new Map();

		let i = 0;
		builtSchemas.forEach((builtSchema, key) => {
			const schema = new Schema(builtSchema, i, this[uwsc]);

			this[schemaMap].set(i, schema);

			// Set a public property for the consumer to use
			this[key] = schema;
			i++;
		});

		this[uwsc].on('message', m => {
			parseMessage(m, this[schemaMap])
				.then(({schema, buff}) => schema[rb](buff))
				.catch(e => console.error(e));
		});
	}

	onClose(cb) {
		this[uwsc].on('close', cb);
	}
}

class PaulRevere {
	constructor(schemas = {}, remote) {
		if(!remote) throw new TypeError('Must pass a url or http server to connect to');

		this[schemaMap] = new Map();

		// Switch between client and server websocket
		if(typeof remote === 'string') {
			this[ws] = new WebSocket(remote);
		} else {
			if(!isNode) throw new Error('Cannot create WebSocket server in browser environment');

			this[ws] = new WebSocket.Server({server: remote});
		}

		// Local reference of the schemapack schemas for Clients to use
		let builtSchemas = new Map();

		// Map all of the Schemas to an index
		Object.keys(schemas).forEach((key, i) => {
			const builtSchema = build(Object.assign({
				// Adding this parameter to a schema allows us to parse it later as a buffer
				// so the receipient does not need to know what type of information was sent
				__schema: 'uint8'
			}, schemas[key]));

			const schema = new Schema(builtSchema, i, this[ws]);

			this[schemaMap].set(i, schema);
			builtSchemas.set(key, builtSchema);

			// Set a public property for the consumer to use
			this[key] = schema;
		});

		// Set up listeners
		if(isNode) {
			this[ws].on('message', m => {
				parseMessage(m, this[schemaMap])
					.then(({schema, buff}) => schema[rb](buff))
					.catch(e => console.error(e));
			});
		} else {
			this[ws].onmessage = m => {
				parseMessage(m.data, this[schemaMap])
					.then(({schema, buff}) => schema[rb](buff))
					.catch(e => console.error(e));
			};
		}

		// For servers, bind a connection listener and return a Client
		if(typeof remote !== 'string') {
			this.onConnection = cb => {
				this[ws].on('connection', c => {
					const client = new Client(c, builtSchemas);

					cb(client);
				});

				return this;
			};
		}
	}

	close() {
		this[ws].close();
	}
}

module.exports = PaulRevere;
