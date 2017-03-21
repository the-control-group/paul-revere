[![npm version](https://badge.fury.io/js/paul-revere.svg)](https://badge.fury.io/js/paul-revere)

# Paul Revere

Paul Revere is a lightweight wrapper for server-client WebSocket communication. It uses [schemapack](https://github.com/phretaddin/schemapack) to encode buffers from JavaScript objects and delivers a smaller payload and faster parsing than traditional JSON messaging. On the browser, it wraps a vanilla WebSocket object, and on the server it wraps the ultra-fast [µWebSockets](https://github.com/uWebSockets/uWebSockets) package.

Paul Revere also accepts pub/sub adapters to allows for horizontal server scaling.

## Server Usage

Paul Revere can be used with any Node server, though this example shows Express.

```JavaScript
const express = require('express'),
	PaulRevere = require('paul-revere'),
	schemas = require('../shared/schemas'); // same module as client

/**
* Example schemas.js
* Follow schema rules found at https://github.com/phretaddin/schemapack

 exports.chat = {
 	payload: {
 		message: 'string',
 		user: 'string'
 	},
 	meta: {
 		timestamp: 'string'
 	}
 };
 */

const app = express();

// Get Node server instance
const server = app.listen(3000, () => app.log.info('Paul Revere App listening on port 3000'));

// Pass your schemas and a Node server to start a Paul Revere WebSocket server
const paul = new PaulRevere(schemas, {server});

// Bind a client connection handler
paul.onConnection(client => {

	// The server exposes your schemas to broadcast messages to all clients
	// Pass a client as the second argument to exclude it from the broadcast
	paul.chat.broadcast({
		payload: {
			message: 'New user joined!',
			user: 'ChatBot'
		},
		meta: {
			timestamp: String(Date.now())
		}
	}, client); // Don't send this message to the client that just joined

	// Each client has its own schema instance to send messages directly to that client...
	client.chat.send({
		payload: {
			message: 'Welcome to Chat!',
			user: 'ChatBot'
		},
		meta: {
			timestamp: String(Date.now())
		}
	});

	// And also listen for messages from that client
	client.chat.onMessage(message => {
		// Broadcasting the message to all clients simplifies front end rendering and listeners
		// and is fast enough for non-optimistic updates
		paul.chat.broadcast(message);
	});
});
```


## Client Usage

Paul Revere is supported on all browsers that support native WebSockets. http://caniuse.com/#feat=websockets

```JavaScript
import PaulRevere from 'paul-revere';
import schemas from '../shared/schemas'; // same module as server

// Pass your schemas and a WebSocket address to connect to a Paul Revere server
const paul = new PaulRevere(schemas, {url: 'ws://localhost:3000'}),

// The client exposes your schemas to send messages to the server
paul.chat.send({
	payload: {
		message: 'Hello!',
		user: 'ClientBot'
	},
	meta: {
		timestamp: String(Date.now())
	}
});


// And also listen to messages from the server
paul.chat.onMessage(m => {
	console.log(m);
});
```

## Server Adapters

In order to support horizontal server scaling, Paul Revere servers internally run off a pub/sub model for broadcasting messages. The default is nothing more than a stub function firing callbacks (see below). Custom adapters can be written and passed as the option `pubSub` when instantiating a server, and Paul Revere will use that instead. There is an official NATS adapter at [paul-revere-nats-adapter](https://github.com/the-control-group/paul-revere-nats-adapter).

### Adapter API

Paul Revere servers need publicly accessible `publish(subject, msg, exclude)` and `subscribe(subject, cb)` methods. Nothing else is required to be exposed.

```JavaScript
const pubSubAdapter = {
	// subject will always be an integer unique to a schema type, msg will always be a plain object, and exclude may be undefined or a string id
	publish(subject, msg, exclude) {
		// listeners are namespaced with 'paulrevere' just to ensure string keys
		// Your subject can be anything, so long as it is unique for every schema
		if(!this.listeners[`paulrevere.${subject}`]) return;

		this.listeners[`paulrevere.${subject}`].forEach(cb => cb(msg, exclude));
	},

	// subscriber callbacks expect a plain object msg, and also an exclude string id if passed in the schema.broadcast() method
	subscribe(subject, cb) {
		if(!this.listeners[`paulrevere.${subject}`]) this.listeners[`paulrevere.${subject}`] = [];

		this.listeners[`paulrevere.${subject}`].push(cb);
	},

	listeners: {}
};

const paul = new PaulRevere(schemas, {server, pubSub: pubSubAdapter});
```
