const urlUtil = require('url'),
	{ build } = require('schemapack'),
	toBuffer = require('blob-to-buffer'),
	uuid = require('uuid'),
	WebSocket = require('./websocket'),
	isNode = require('detect-node');

// Symbols to keep the class properties somewhat private
const schemaMap = Symbol('schemaMap'),
	ws = Symbol('websocket'),
	wsc = Symbol('wsClient'),
	id = Symbol('id'),
	ci = Symbol('ci'),
	ps = Symbol('pubSub'),
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
 * Stub pub/sub
 */

const stubPubSub = {
	publish(subject, msg, exclude) {
		if(!this.listeners[`paulrevere.${subject}`]) return;

		this.listeners[`paulrevere.${subject}`].forEach(cb => cb(msg, exclude));
	},

	subscribe(subject, cb) {
		if(!this.listeners[`paulrevere.${subject}`]) this.listeners[`paulrevere.${subject}`] = [];

		this.listeners[`paulrevere.${subject}`].push(cb);
	},

	listeners: {}
};

/**
 * Schema class handles its own tranmission and reception of data
 */
class Schema {
	constructor(builtSchema, schemaIndex, websocket, clientId, pubSub) {
		this[si] = schemaIndex;
		this[bs] = builtSchema;
		this[ws] = websocket;
		this[ci] = clientId;
		this[ps] = pubSub;
		this[rb] = buff => {
			const msg = this[bs].decode(buff);

			this[om](msg);
		};

		// Default to noop
		this[om] = () => {};

		// Subscribe to broadcasts
		if(isNode && this[ps]) {
			this[ps].subscribe(String(this[si]), (msg, exclude) => {

				this[ws].clients.forEach(c => {

					// Exclude a specific client
					// Check for argument existence to avoid accidental `undefined === undefined === true`
					if(exclude && exclude === c.__uuid) return;

					// Set the schema index
					msg.__schema = this[si];
					// Set the client id
					msg.__uuid = this[ci];

					c.send(this[bs].encode(msg));
				});
			});
		}
	}

	onMessage(cb) {
		this[om] = cb;
	}

	send(msg = {}) {
		// Set the schema index
		msg.__schema = this[si];
		// Set the client id
		msg.__uuid = this[ci];

		this[ws].send(this[bs].encode(msg));
	}

	/**
	 * Broadcast a message to all clients, and optionally exclude one
	 * @param {Object} msg - Message to broadcast. Must follow the rules set in the schema
	 * @param {Client} [exclude] - Client to exclude from the broadcast
	 */
	broadcast(msg = {}, exclude = {}) {
		if(!isNode || !this[ps]) throw Error('Cannot broadcast from single client');

		this[ps].publish(String(this[si]), msg, exclude.__uuid);
	}
}

class Client {
	constructor(uwsClient, builtSchemas) {
		this.__uuid = uwsClient.__uuid;
		this.upgradeReq = uwsClient.upgradeReq;
		this[wsc] = uwsClient;
		this[schemaMap] = new Map();

		let i = 0;
		builtSchemas.forEach((builtSchema, key) => {
			const schema = new Schema(builtSchema, i, this[wsc], this.__uuid);

			this[schemaMap].set(i, schema);

			// Set a public property for the consumer to use
			this[key] = schema;
			i++;
		});

		this[wsc].on('message', m => {
			parseMessage(m, this[schemaMap])
				.then(({schema, buff}) => schema[rb](buff))
				.catch(e => console.error(e));
		});
	}

	close() {
		this[wsc].close();
	}

	onClose(cb) {
		this[wsc].on('close', cb);
	}
}

class PaulRevere {
	constructor(schemas = {message: {payload: 'string', meta: {timestamp: 'varuint'}}}, { url, queryParams = {}, server, pubSub = stubPubSub } = {}) {
		if(url && typeof url !== 'string') throw new TypeError('Remote url must be a string');
		if(url && server) throw new Error('Remote and Server cannot both be defined');

		this[schemaMap] = new Map();
		this[id] = uuid.v4();

		// Switch between client and server websocket
		let query;
		switch(true) {
			case !!url:
				query = Object.assign({}, queryParams, {clientId: this[id]});
				this[ws] = new WebSocket(url + urlUtil.format({query}));
				break;

			case !!server:
				if(!isNode) throw new Error('Cannot create WebSocket server in browser environment');

				this[ws] = new WebSocket.Server({server});
				break;

			default:
				throw new Error('Remote or Server must be defined');
		}

		// Local reference of the schemapack schemas for Clients to use
		let builtSchemas = new Map();

		// Map all of the Schemas to an index
		Object.keys(schemas).forEach((key, i) => {
			const builtSchema = build(Object.assign({
				// Adding this parameter to a schema allows us to parse it later as a buffer
				// so the receipient does not need to know what type of information was sent
				__schema: 'uint8',
				__uuid: 'string'
			}, schemas[key]));

			const schema = new Schema(builtSchema, i, this[ws], this[id], pubSub);

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

			this.onClose = cb => {
				this[ws].onclose = cb;
			};
		}

		// For servers, bind a connection listener and return a Client
		if(typeof remote !== 'string') {
			this.onConnection = cb => {
				this[ws].on('connection', (c, req) => {
					// Add the connection request to the client
					c.upgradeReq = req;

					c.__uuid = urlUtil.parse(c.upgradeReq.url, true).query.clientId || uuid.v4();

					const client = new Client(c, builtSchemas);

					cb(client);
				});

				return this;
			};
		}
	}

	get rawClients() {
		return this[ws].clients;
	}

	close() {
		this[ws].close();
	}
}

module.exports = PaulRevere;
