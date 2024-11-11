# undici-thread-interceptor

An Undici agent that routes requests to a worker thread.

Supports:

- load balancing (round robin)
- mesh networking between the worker threads

## Installation

```bash
npm install undici undici-thread-interceptor
```

## Usage

### Main (main.js)

```javascript
import { Worker } from "node:worker_threads";
import { join } from "node:path";
import { createThreadInterceptor } from "undici-thread-interceptor";
import { Agent, request } from "undici";

const worker = new Worker(join(import.meta.dirname, "worker.js"));

const interceptor = createThreadInterceptor({
  domain: ".local", // The prefix for all local domains
});
interceptor.route("myserver", worker);

const agent = new Agent().compose(interceptor);

const { statusCode, body } = await request("http://myserver.local", {
  dispatcher: agent,
});

console.log(statusCode, await body.json());

// worker.terminate()
```

### Worker (worker.js)

#### Generic node HTTP application

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";

function app(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ hello: "world" }));
}

// App can optionally be a string in the form `http://HOST:PORT`. In that case the interceptor
// will use the network to perform the request.
wire({ server: app, port: parentPort });
```

#### Fastify

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";
import fastify from "fastify";

const app = fastify();

app.get("/", (req, reply) => {
  reply.send({ hello: "world" });
});

wire({ server: app, port: parentPort });
```

#### Express

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";
import express from "express";

const app = express();

app.get("/", (req, res) => {
  res.send({ hello: "world" });
});

wire({ server: app, port: parentPort });
```

#### Koa

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";
import Koa from "koa";

const app = new Koa();

app.use((ctx) => {
  ctx.body = { hello: workerData?.message || "world" };
});

wire({ server: app.callback(), port: parentPort });
```

#### Replace the server at runtime

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";
import fastify from "fastify";

const app1 = fastify();

app1.get("/", (req, reply) => {
  reply.send({ hello: "this is app 1" });
});

const app2 = fastify();

app2.get("/", (req, reply) => {
  reply.send({ hello: "this is app 2" });
});

const { replaceServer } = wire({ server: app1, port: parentPort });

setTimeout(() => {
  replaceServer(app2);
}, 5000);
```

#### Gracefully close the worker thread

If you want to gracefully close the worker thread, remember to call the `close` function of the interceptor.

```javascript
import { wire } from "undici-thread-interceptor";

// ...

const { interceptor } = wire({ server: app, port: parentPort });

// ...

interceptor.close();
```

## API

### Hooks

It's possible to set some simple **synchronous** functions as hooks:

- `onServerRequest(req, cb)`
- `onServerResponse(req, res)`
- `onServerError(req, res, error)`
- `onClientRequest(req, clientCtx)`
- `onClientResponse(req, res, clientCtx)`
- `onClientError(req, res, clientCtx, error)`

The `clientCtx` is used to pass through hooks calls objects which cannot be set on request
(which is then sent through `postMessage`, so it might be not serializable).

On `onServerRequest`, the `cb` is not supposed to be called by the hook, but the hook can
wrap/decorate it.

#### Client hooks

These are se on the agent dispatcher. It's possible to pass a function or an array of functions
(in the latter case, the hooks are executed in order)

```javascript
const interceptor = createThreadInterceptor({
  domain: ".local",
  onClientRequest: (req) => console.log("onClientRequest called", req),
});
interceptor.route("myserver", worker);

const agent = new Agent().compose(interceptor);

const { statusCode } = await request("http://myserver.local", {
  dispatcher: agent,
});
```

#### Server hooks

These can be passed to the `wire` function in workers. e.g. with Fastify:

```javascript
import { wire } from "undici-thread-interceptor";
import { parentPort } from "node:worker_threads";
import fastify from "fastify";

const app = fastify();

app.get("/", (req, reply) => {
  reply.send({ hello: "world" });
});

wire({
  server: app,
  port: parentPort,
  onServerRequest: (req) => console.log("onServerRequest called", req),
});
```

## License

MIT
