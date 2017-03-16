'use strict';

var _createClass = function () { function defineProperties(target, props) { for (var i = 0; i < props.length; i++) { var descriptor = props[i]; descriptor.enumerable = descriptor.enumerable || false; descriptor.configurable = true; if ("value" in descriptor) descriptor.writable = true; Object.defineProperty(target, descriptor.key, descriptor); } } return function (Constructor, protoProps, staticProps) { if (protoProps) defineProperties(Constructor.prototype, protoProps); if (staticProps) defineProperties(Constructor, staticProps); return Constructor; }; }();

function _classCallCheck(instance, Constructor) { if (!(instance instanceof Constructor)) { throw new TypeError("Cannot call a class as a function"); } }

var url = require('url'),
    _require = require('schemapack'),
    build = _require.build,
    toBuffer = require('blob-to-buffer'),
    uuid = require('uuid'),
    WebSocket = require('./websocket'),
    isNode = require('detect-node');

// Symbols to keep the class properties somewhat private
var schemaMap = Symbol('schemaMap'),
    ws = Symbol('websocket'),
    uwsc = Symbol('uwsClient'),
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
	return new Promise(function (res, rej) {

		// Handle blobs
		if (typeof Blob !== 'undefined' && b instanceof Blob) {
			toBuffer(b, function (err, buff) {
				if (err) rej(err);

				var schema = sMap.get(buff[0]);

				res({ schema: schema, buff: buff });
			});
		}

		// Handle Buffer/ArrayBuffer
		else {
				var buff = b;
				// Convert ArrayBuffer so we can parse the first byte for the right schema
				if (typeof ArrayBuffer !== 'undefined' && b instanceof ArrayBuffer) buff = Buffer.from(b);

				try {
					var schema = sMap.get(buff[0]);

					res({ schema: schema, buff: buff });
				} catch (e) {
					rej(e);
				}
			}
	});
}

/**
 * Stub pub/sub
 */

var stubPubSub = {
	publish: function publish(subject, msg, exclude) {
		if (!this.listeners['paulrevere.' + subject]) return;

		this.listeners['paulrevere.' + subject].forEach(function (cb) {
			return cb(msg, exclude);
		});
	},
	subscribe: function subscribe(subject, cb) {
		if (!this.listeners['paulrevere.' + subject]) this.listeners['paulrevere.' + subject] = [];

		this.listeners['paulrevere.' + subject].push(cb);
	},


	listeners: {}
};

/**
 * Schema class handles its own tranmission and reception of data
 */

var Schema = function () {
	function Schema(builtSchema, schemaIndex, websocket, clientId, pubSub) {
		var _this = this;

		_classCallCheck(this, Schema);

		this[si] = schemaIndex;
		this[bs] = builtSchema;
		this[ws] = websocket;
		this[ci] = clientId;
		this[ps] = pubSub;
		this[rb] = function (buff) {
			var msg = _this[bs].decode(buff);

			_this[om](msg);
		};

		// Default to noop
		this[om] = function () {};

		// Subscribe to broadcasts
		if (isNode && this[ps]) {
			this[ps].subscribe(String(this[si]), function (msg, exclude) {

				_this[ws].clients.forEach(function (c) {

					// Exclude a specific client
					// Check for argument existence to avoid accidental `undefined === undefined === true`
					if (exclude && exclude === c.__uuid) return;

					// Set the schema index
					msg.__schema = _this[si];
					// Set the client id
					msg.__uuid = _this[ci];

					c.send(_this[bs].encode(msg));
				});
			});
		}
	}

	_createClass(Schema, [{
		key: 'onMessage',
		value: function onMessage(cb) {
			this[om] = cb;
		}
	}, {
		key: 'send',
		value: function send() {
			var msg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

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

	}, {
		key: 'broadcast',
		value: function broadcast() {
			var msg = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};
			var exclude = arguments.length > 1 && arguments[1] !== undefined ? arguments[1] : {};

			if (!isNode || !this[ps]) throw Error('Cannot broadcast from single client');

			this[ps].publish(String(this[si]), msg, exclude.__uuid);
		}
	}]);

	return Schema;
}();

var Client = function () {
	function Client(uwsClient, builtSchemas) {
		var _this2 = this;

		_classCallCheck(this, Client);

		this.__uuid = uwsClient.__uuid;
		this[uwsc] = uwsClient;
		this[schemaMap] = new Map();

		var i = 0;
		builtSchemas.forEach(function (builtSchema, key) {
			var schema = new Schema(builtSchema, i, _this2[uwsc], _this2.__uuid);

			_this2[schemaMap].set(i, schema);

			// Set a public property for the consumer to use
			_this2[key] = schema;
			i++;
		});

		this[uwsc].on('message', function (m) {
			parseMessage(m, _this2[schemaMap]).then(function (_ref) {
				var schema = _ref.schema,
				    buff = _ref.buff;
				return schema[rb](buff);
			}).catch(function (e) {
				return console.error(e);
			});
		});
	}

	_createClass(Client, [{
		key: 'onClose',
		value: function onClose(cb) {
			this[uwsc].on('close', cb);
		}
	}]);

	return Client;
}();

var PaulRevere = function () {
	function PaulRevere() {
		var schemas = arguments.length > 0 && arguments[0] !== undefined ? arguments[0] : {};

		var _this3 = this;

		var remote = arguments[1];
		var pubSub = arguments.length > 2 && arguments[2] !== undefined ? arguments[2] : stubPubSub;

		_classCallCheck(this, PaulRevere);

		if (!remote) throw new TypeError('Must pass a url or http server to connect to');

		this[schemaMap] = new Map();
		this[id] = uuid.v4();

		// Switch between client and server websocket
		if (typeof remote === 'string') {
			this[ws] = new WebSocket(remote + '?clientId=' + this[id]);
		} else {
			if (!isNode) throw new Error('Cannot create WebSocket server in browser environment');

			this[ws] = new WebSocket.Server({ server: remote });
		}

		// Local reference of the schemapack schemas for Clients to use
		var builtSchemas = new Map();

		// Map all of the Schemas to an index
		Object.keys(schemas).forEach(function (key, i) {
			var builtSchema = build(Object.assign({
				// Adding this parameter to a schema allows us to parse it later as a buffer
				// so the receipient does not need to know what type of information was sent
				__schema: 'uint8',
				__uuid: 'string'
			}, schemas[key]));

			var schema = new Schema(builtSchema, i, _this3[ws], _this3[id], pubSub);

			_this3[schemaMap].set(i, schema);
			builtSchemas.set(key, builtSchema);

			// Set a public property for the consumer to use
			_this3[key] = schema;
		});

		// Set up listeners
		if (isNode) {
			this[ws].on('message', function (m) {
				parseMessage(m, _this3[schemaMap]).then(function (_ref2) {
					var schema = _ref2.schema,
					    buff = _ref2.buff;
					return schema[rb](buff);
				}).catch(function (e) {
					return console.error(e);
				});
			});
		} else {
			this[ws].onmessage = function (m) {
				parseMessage(m.data, _this3[schemaMap]).then(function (_ref3) {
					var schema = _ref3.schema,
					    buff = _ref3.buff;
					return schema[rb](buff);
				}).catch(function (e) {
					return console.error(e);
				});
			};

			this.onClose = function (cb) {
				_this3[ws].onclose = cb;
			};
		}

		// For servers, bind a connection listener and return a Client
		if (typeof remote !== 'string') {
			this.onConnection = function (cb) {
				_this3[ws].on('connection', function (c) {

					c.__uuid = url.parse(c.upgradeReq.url, true).query.clientId || uuid.v4();

					var client = new Client(c, builtSchemas);

					cb(client);
				});

				return _this3;
			};
		}
	}

	_createClass(PaulRevere, [{
		key: 'close',
		value: function close() {
			this[ws].close();
		}
	}]);

	return PaulRevere;
}();

module.exports = PaulRevere;