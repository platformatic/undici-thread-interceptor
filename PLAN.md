# v2 API And Protocol Plan

## Goal

Replace the current v1 protocol with a simpler v2 protocol based on a coordinator-published mesh and direct interceptor-to-server dispatch.

The coordinator is mandatory and owns only the control plane. It can run on any thread, tracks participants, maintains the mesh snapshot, and publishes full topology updates to interceptors and servers.

Interceptors own request assignment. They use the latest mesh snapshot to select eligible targets with strict round robin and dispatch requests directly to the selected server or TCP target. The coordinator is not on the request path.

Thread-mode request and response transmission keeps the current protocol behavior, including inline body transfer and `bodyPort` transfer.

## Public API

```js
import {
  createCoordinator,
  createServer,
  createInterceptor,
  NoTargetError,
  NoAvailableTargetError,
  ConnectTimeoutError,
} from "undici-thread-interceptor";
```

### `createCoordinator()`

Runs on any thread. One coordinator may exist for a given `meshId` in a process.

```js
const coordinator = createCoordinator({
  meshId,
  onMesh,
  onInterceptorAvailable,
  onInterceptorClosed,
  onServerAvailable,
  onServerUnavailable,
  onServerPaused,
  onServerResumed,
  onServerClosed,
  onServerUpdate,
  onError,
});
```

Methods:

```js
coordinator.getMesh();
coordinator.pause(serverId);
coordinator.resume(serverId);
coordinator.close(serverId);
coordinator.close();
```

Responsibilities:

- maintain the mesh snapshot for one `meshId`
- accept coordinator `MessageChannel`s from interceptors and servers
- track interceptor and server participation
- track server state, metadata, origins, target modes, TCP addresses, and thread ids
- publish full mesh snapshots after every participant update
- send fire-and-forget `PAUSE`, `RESUME`, and `CLOSE` commands to servers by `serverId`

### `createServer()`

Runs in a server worker/thread and registers one origin in one mesh. The mesh format supports multiple origins for future expansion, but the v2 public API accepts a single origin.

```js
const server = createServer({
  meshId,
  serverId,
  origin,
  server,
  paused,
  metadata,
  coordinatorThreadId,
  bootstrapTimeout,
  onRequest,
  onResponse,
  onError,
});
```

Methods:

```js
server.pause();
server.resume();
server.close();
server.replaceServer(server);
server.updateMetadata(metadata);
```

Responsibilities:

- infer its `threadId` from `node:worker_threads`
- generate a random `serverId` when omitted
- open a coordinator channel with `postMessageToThread(coordinatorThreadId)`
- register itself with the coordinator
- receive peer channels opened by interceptors with `postMessageToThread(threadId)`
- serve direct thread-mode requests over peer channels
- preserve current request and response body transfer behavior
- publish metadata and state updates through the coordinator channel
- support starting paused with `paused: true`

Pause is reversible. `pause()` makes the target unavailable in the mesh and returns HTTP `503` for direct requests that cannot be served. `resume()` makes the target available again. `close()` pauses first, drains local work, unregisters from the coordinator, and closes coordinator and peer channels.

If a `server` option is a TCP address, it must be a full `protocol://host:port` URL.

`coordinatorThreadId` controls which thread receives the coordinator bootstrap message. The default is `0`.

`bootstrapTimeout` controls initial coordinator channel setup. The default is `100` ms.

### `createInterceptor()`

Creates the interceptor-side Undici interceptor.

```js
const interceptor = createInterceptor({
  meshId,
  interceptorId,
  domain,
  connectTimeout,
  coordinatorThreadId,
  bootstrapTimeout,
  metadata,
  onRequest,
  onResponse,
  onResponseEnd,
  onError,
});
```

Responsibilities:

- infer its `threadId` from `node:worker_threads`
- generate a random `interceptorId` when omitted
- open a coordinator channel with `postMessageToThread(coordinatorThreadId)`
- keep the latest mesh snapshot and ignore stale snapshots
- maintain strict round-robin cursors by `meshId` and origin
- randomize initial and reset round-robin cursor positions to avoid always starting from server `0`
- open and reuse peer channels to thread targets with `postMessageToThread(serverThreadId)`
- keep one persistent peer `MessageChannel` per `serverId` and origin
- dispatch requests directly to selected thread or TCP targets
- preserve current inline body and `bodyPort` transfer behavior
- receive thread-mode responses and errors over peer channels

`connectTimeout` covers coordinator bootstrap, peer channel setup, and direct dispatch until a response or dispatch failure is known. The default should match the current timeout default, `5000` ms.

`coordinatorThreadId` controls which thread receives the coordinator bootstrap message. The default is `0`.

`bootstrapTimeout` controls initial coordinator channel setup. The default is `100` ms.

## Coordinator Channel Bootstrap

Interceptors and servers open a `MessageChannel` to the coordinator using `postMessageToThread(coordinatorThreadId)`. The coordinator channel must be established before setup completes.

If coordinator bootstrap fails or times out, setup fails.

The bootstrap message transfers one port to the coordinator thread:

```js
COORDINATOR_CONNECT {
  meshId,
  role: 'interceptor' | 'server',
  interceptorId?,
  serverId?,
  threadId,
  port
}
```

All regular control messages for that participant are sent over the transferred port.

## Required Identity

- `meshId` is required by coordinator, servers, and interceptors.
- `threadId` is inferred from `node:worker_threads`.
- `serverId` is optional for servers and generated randomly when omitted.
- `interceptorId` is optional for interceptors and generated randomly when omitted.
- `origin` is required by servers.
- Request `id` values are unique only within one interceptor-to-server peer channel.

## Origin Keys

Origin keys are normalized lowercase values in this form:

```txt
scheme:host
```

Examples:

```txt
http:api.local
https:api.local
```

Ports are not part of the origin key. TCP targets carry their own full address.

## Mesh Snapshot

The coordinator publishes the full mesh after every participant update:

```js
MESH {
  meshId,
  version,
  servers,
  origins,
  interceptors
}
```

`version` is monotonically increased by the coordinator. Interceptors and servers ignore stale snapshots.

Shape:

```js
{
  meshId,
  version: 1,
  servers: {
    [serverId]: {
      serverId,
      threadId,
      state: 'available' | 'paused' | 'closing' | 'closed',
      metadata,
      targets: [
        {
          mode: 'thread',
          origin,
          serverId,
          threadId,
          state: 'available' | 'paused' | 'closing' | 'closed',
          metadata
        },
        {
          mode: 'tcp',
          origin,
          address,
          state: 'available' | 'paused' | 'closing' | 'closed',
          metadata
        }
      ]
    }
  },
  origins: {
    [origin]: {
      origin,
      targets: [
        {
          mode: 'thread',
          origin,
          serverId,
          threadId,
          state: 'available' | 'paused' | 'closing' | 'closed',
          metadata
        },
        {
          mode: 'tcp',
          origin,
          address,
          state: 'available' | 'paused' | 'closing' | 'closed',
          metadata
        }
      ]
    }
  },
  interceptors: {
    [interceptorId]: {
      interceptorId,
      threadId,
      metadata
    }
  }
}
```

`servers` is the authoritative participant view. `origins` is a derived dispatch index for interceptors.

## Mesh Solicitation

Any participant may request the latest mesh:

```js
GET_MESH {
  meshId
}
```

The coordinator replies with a full `MESH` message.

## Control Messages

Servers register, update, and unregister through their coordinator channel:

```js
SERVER_JOIN {
  meshId,
  serverId,
  threadId,
  state: 'available' | 'paused',
  metadata?,
  targets: [
    {
      mode: 'thread' | 'tcp',
      origin,
      address?,
      state: 'available' | 'paused',
      metadata?
    }
  ]
}
```

```js
SERVER_UPDATE {
  meshId,
  serverId,
  state?,
  metadata?,
  targets?
}
```

```js
SERVER_LEAVE {
  meshId,
  serverId
}
```

Interceptors register, update, and unregister through their coordinator channel:

```js
INTERCEPTOR_JOIN {
  meshId,
  interceptorId,
  threadId,
  metadata?
}
```

```js
INTERCEPTOR_UPDATE {
  meshId,
  interceptorId,
  metadata?
}
```

```js
INTERCEPTOR_LEAVE {
  meshId,
  interceptorId
}
```

Coordinator commands target a `serverId` in one mesh and are fire-and-forget:

```js
PAUSE { meshId, serverId }
RESUME { meshId, serverId }
CLOSE { meshId, serverId }
```

Pause and resume affect all origins registered by that server. Origin-specific pausing is not part of the v2 public API.

## Interceptor-To-Server Channel Bootstrap

For thread targets, the interceptor opens a direct peer channel to the selected server thread with `postMessageToThread(serverThreadId)`.

```js
PEER_CONNECT {
  meshId,
  origin,
  interceptorId,
  serverId,
  port
}
```

The interceptor owns peer channels and reuses one persistent `MessageChannel` per `serverId` and origin. The server does not need to track interceptors by `interceptorId`; it only tracks channel disconnection enough to stop serving responses on that channel.

If a peer channel closes or fails, the interceptor treats the selected dispatch as failed and rejects the request to Undici.

## Request Dispatch

The interceptor uses the latest mesh snapshot to dispatch matching requests.

If the request origin is absent from the mesh, the interceptor does not handle the request and delegates to regular Undici.

If the origin exists but has no available targets, the interceptor fails with `NoAvailableTargetError`.

A target is eligible when:

```txt
target.state === 'available'
```

For thread targets, the owning server must also be available:

```txt
server.state === 'available' && target.state === 'available'
```

The interceptor keeps a strict round-robin cursor per `meshId` and origin. The initial cursor is randomized so interceptors do not always start with server `0`. The cursor is reset to a new random position when a newer mesh snapshot is accepted. Every request selects one target and advances the cursor once.

The interceptor does not retry another target after selection. Retries, when desired, are handled by Undici or user code outside this interceptor.

## Thread-Mode Request And Response Protocol

Requests are sent directly from interceptor to server over the peer channel:

```js
REQUEST {
  id,
  meshId,
  interceptorId,
  origin,
  path,
  method,
  headers,
  body?,
  bodyPort?
}
```

If neither `body` nor `bodyPort` is present, the request has no body. If both are present, it is a protocol error.

Responses are sent directly from server to interceptor over the same peer channel:

```js
RESPONSE {
  id,
  statusCode,
  headers,
  statusMessage,
  body?,
  bodyPort?
}
```

Small bodies may be sent inline. Larger or streaming bodies use `bodyPort`. If both are present, it is a protocol error.

Errors use:

```js
ERROR {
  id,
  error
}
```

Cancellation uses:

```js
CANCEL {
  id,
  reason
}
```

Request header cleanup removes `connection` and `transfer-encoding` before forwarding thread-mode requests.

## Channel Failure During Dispatch

If a thread peer channel fails before or during dispatch, the interceptor rejects the request to Undici with the channel or dispatch error. It does not try another target.

## TCP Mode

TCP targets remain part of v2. If the selected target has `mode: 'tcp'`, the interceptor dispatches directly over TCP using the target `address` from the mesh and does not establish a `MessageChannel`.

TCP target failures map to normal Undici connection and response behavior.

## Error Semantics

```js
NoAvailableTargetError {
  code: 'UND_TI_NO_AVAILABLE_TARGET'
}
```

```js
ConnectTimeoutError {
  code: 'UND_TI_CONNECT_TIMEOUT'
}
```

Fast-fail and dispatch behavior:

- origin absent from mesh: delegate to regular Undici dispatch
- origin present but no available targets: fail with `NoAvailableTargetError`
- peer channel setup or dispatch does not complete before `connectTimeout`: fail with `ConnectTimeoutError`
- selected target fails before response: reject the request to Undici with the dispatch error
- selected target returns HTTP `503`: deliver the response as-is
- coordinator bootstrap does not complete before `bootstrapTimeout`: setup fails

## Hooks

### Coordinator Hooks

```js
createCoordinator({
  onMesh(mesh) {},
  onInterceptorAvailable(interceptor) {},
  onInterceptorClosed(interceptor) {},
  onServerAvailable(server) {},
  onServerUnavailable(server) {},
  onServerPaused(server) {},
  onServerResumed(server) {},
  onServerClosed(server) {},
  onServerUpdate(server) {},
  onError(error) {},
});
```

### Interceptor Hooks

```js
createInterceptor({
  onRequest(req, ctx) {},
  onResponse(req, res, ctx) {},
  onResponseEnd(req, res, ctx) {},
  onError(req, res, ctx, error) {},
});
```

### Server Hooks

```js
createServer({
  onRequest(req, next) {},
  onResponse(req, res) {},
  onError(req, res, error) {},
});
```

## Current Behavior To Preserve

- request header cleanup removes `connection` and `transfer-encoding` before forwarding thread-mode requests
- current error serialization behavior is preserved
- hook timing remains aligned with request, response, response end, and error lifecycles
- request body transfer keeps the current inline-vs-port behavior
- response body transfer keeps the current inline-vs-port behavior
- non-replayable request resources are not transferred before the target is selected and dispatch begins

## Removed v1 Concepts

These concepts are removed or replaced in v2:

- `createThreadInterceptor`
- `wire`
- `route` / `addRoute`
- `unroute` / `removeRoute`
- `pauseWorker` / `resumeWorker`
- `setAccepting`
- `canAccept`
- `onChannelCreation`
- `meshTimeout`
- `offerTimeout`
- `backlogLimit`
- `BackpressureError`
- fallback claim path
- server-side request claims
- `CLAIM`
- `CLAIM_ACCEPTED`
- `CLAIM_REJECTED`
- `PULL`
- `PUSH`
- `OFFER`
- `ACCEPT`
- `REJECT`
- `HANDOFF`
- `attemptId`
- `onAccept`
- `onReject`
- `onTimeout`

This is a breaking change. No compatibility wrapper is required for v2.

## Terminology

Use these message names consistently:

```txt
COORDINATOR_CONNECT: interceptor/server bootstrap to coordinator
INTERCEPTOR_JOIN: interceptor registers with coordinator
INTERCEPTOR_UPDATE: interceptor updates coordinator metadata
INTERCEPTOR_LEAVE: interceptor unregisters from coordinator
SERVER_JOIN: server registers targets with coordinator
SERVER_UPDATE: server updates state, metadata, or targets
SERVER_LEAVE: server unregisters from coordinator
GET_MESH: participant requests latest mesh
MESH: coordinator publishes full topology
PAUSE: coordinator command to pause a server
RESUME: coordinator command to resume a server
CLOSE: coordinator command to close a server
PEER_CONNECT: interceptor opens direct thread target channel
REQUEST: interceptor -> server peer channel
RESPONSE: server -> interceptor peer channel
ERROR: server -> interceptor peer channel
CANCEL: peer-channel request cancellation
```

## Future Upgrade Support

WebSocket and HTTP upgrade support is not part of the initial implementation. The protocol should remain compatible by keeping peer channels as control channels and using dedicated ports or direct handoff paths for future upgraded connections.
