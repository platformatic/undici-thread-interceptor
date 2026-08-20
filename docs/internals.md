# Internals

This document describes the implementation and the internal message protocol of
`undici-thread-interceptor` v2. It is intended for maintainers and integrations
that need to reason about lifecycle, routing, or shutdown behavior.

The package is ESM-only and its runtime entry point is `dist/index.js`. The
protocol is an internal v2 protocol. A coordinator, interceptor, and server
participating in one mesh should use compatible package versions.

## Architecture

The module has three roles:

- **Coordinator**: owns membership and publishes immutable mesh snapshots.
- **Server**: registers one target for one origin and serves requests delivered
  through peer ports.
- **Interceptor**: composes with Undici, selects mesh targets, and forwards
  requests to servers.

There are two target modes:

- **Thread mode**: `server` is an in-process handler or server object. Requests
  cross a `MessagePort` to the thread that owns the target.
- **TCP mode**: `server` is a string or `URL`. The target is advertised in the
  mesh, but the interceptor dispatches directly to its address through Undici.

The coordinator and members communicate through worker-thread messages and
transferred `MessagePort`s. Thread-mode request traffic uses a separate,
lazily-created peer port for each `serverId` and origin pair.

## Public Roles

`src/index.ts` exports:

- `createCoordinator()` and `Coordinator`.
- `createServer()` and `Server`.
- `createInterceptor()` and `Interceptor`.
- `NoAvailableTargetError` and `ConnectTimeoutError`.
- Mesh and server type definitions.

The interceptor function returned by `createInterceptor()` also exposes:

- `interceptorId`.
- `ready`.
- `close()`.
- `updateMetadata()`.
- `getMesh()`.
- `createUpgradeAgent()`.

## Origins and Mesh State

Origins are normalized by `normalizeOrigin()`:

- `api.local` becomes `http:api.local`.
- `http://api.local/path` becomes `http:api.local`.
- `https://api.local` becomes `https:api.local`.
- Host names are lowercased and paths are discarded.

Server domains must not include a protocol. The interceptor's `domain` option
is a case-insensitive hostname suffix such as `.local`.

A mesh contains:

```ts
interface Mesh {
  meshId: string
  version: number
  servers: Record<string, MeshServer>
  origins: Record<string, MeshOrigin>
  interceptors: Record<string, MeshInterceptor>
}
```

`origins` is a derived index from normalized origin to server IDs. It includes
servers that are paused or closed until the corresponding membership record is
removed. Every publication increments `version`. Interceptors ignore snapshots
whose version is not newer than their current snapshot and clear their
round-robin cursors when a newer snapshot arrives.

Thread servers have this shape:

```ts
interface ThreadServer {
  serverId: string
  threadId: number
  origin: string
  state: State
  mode: 'thread'
  metadata?: unknown
  capabilities?: { upgrade: boolean }
}
```

TCP servers additionally have `mode: 'tcp'` and an `address`.

Server states are:

- `available`: eligible for normal selection.
- `paused`: remains in the mesh but is skipped by selection.
- `closing`: reserved by the protocol type but not used by the current server
  close path.
- `closed`: no longer eligible and being drained or removed.

## Coordinator Lifecycle

Creating a coordinator registers it process-wide by `meshId`. A second
coordinator with the same ID throws. The coordinator installs a process
`workerMessage` listener and starts with an empty mesh.

Members connect by sending `COORDINATOR_CONNECT` with a transferred port and a
unique `operationId`. The coordinator validates the role and required identity
fields, records the member, starts the port, and inserts its initial server or
interceptor record. The operation completes only after relevant interceptors
acknowledge the resulting snapshot.

Member port closure removes membership. Server and interceptor removal rebuilds
the origin index and publishes a new snapshot.

Coordinator methods:

- `close(serverId)` sends `CLOSE` to the selected server. It does not wait for
  server drain completion.
- `close()` closes all member ports, clears membership, and resets the mesh. It
  is idempotent and can be followed by `restart()`.
- `restart()` reopens a non-destroyed coordinator with a fresh mesh.
- `destroy()` closes members, unregisters the coordinator from the process-wide
  registry, and removes the process listener. It is idempotent.
- `getMesh()` returns a structured clone of the current mesh.

The coordinator's `onMesh` callback receives a clone. State-specific callbacks
are emitted for server and interceptor availability, pause, resume, updates,
and closure.

## Server Lifecycle

`createServer()` normalizes hooks, creates a coordinator port, registers the
server, and exposes `ready` for registration completion. A server ID is
generated when one is not provided.

`pause()` and `resume()` update the advertised state and publish
`SERVER_UPDATE`. Their promises resolve after mesh convergence. Calls after
close and redundant state changes are ignored.

`replaceServer()` replaces the thread-mode target and republishes its upgrade
capability. A nullish replacement is ignored for TCP targets and rejected for
thread targets. `updateMetadata()` republishes metadata; both return convergence
promises.

Upgrade capability is advertised when any of the following is true:

- The target is TCP.
- An explicit `upgrade` handler was supplied.
- The target has an `upgrade` emitter with a listener.
- The target has a Fastify-style `.server` emitter with an upgrade listener.

Capability means that a target may handle an upgrade. A capable target with no
listener at the time the upgrade arrives returns `501 Not Implemented`.

## Interceptor Selection

The interceptor delegates to the next Undici dispatcher when:

- The request has no origin.
- The hostname does not match the configured domain suffix.
- The normalized origin is absent from the mesh.

If the origin exists but no target can be selected, it throws
`NoAvailableTargetError`. `CONNECT` requests to mesh targets are rejected as
unsupported.

Selection uses a per-origin cursor. The first cursor is randomized; subsequent
selection is round-robin. Only `available` servers are eligible. Upgrade
selection additionally requires `capabilities.upgrade !== false`.

`allowTarget` hooks run in order for each candidate. Returning `false` skips
that candidate and continues selection. Any other return value allows it.

TCP targets are dispatched directly using the target address. They do not use
peer ports or synthetic thread-mode request diagnostics.

## Coordinator and Peer Protocol

The protocol constants are defined in `src/protocol.ts`.

### Coordinator messages

| Message               | Direction                  | Purpose                                                            |
| --------------------- | -------------------------- | ------------------------------------------------------------------ |
| `COORDINATOR_CONNECT` | member to coordinator      | Registers a member and transfers its coordinator port.             |
| `INTERCEPTOR_UPDATE`  | interceptor to coordinator | Updates interceptor metadata.                                      |
| `INTERCEPTOR_LEAVE`   | interceptor to coordinator | Removes an interceptor.                                            |
| `SERVER_UPDATE`       | server to coordinator      | Publishes server state, metadata, mode, address, and capabilities. |
| `SERVER_LEAVE`        | server to coordinator      | Removes a server from mesh membership.                             |
| `GET_MESH`            | member to coordinator      | Requests a current mesh snapshot.                                  |
| `MESH`                | coordinator to member      | Publishes a mesh snapshot.                                         |
| `PAUSE`               | coordinator to server      | Requests server pause.                                             |
| `RESUME`              | coordinator to server      | Requests server resume.                                            |
| `CLOSE`               | coordinator to server      | Requests server shutdown.                                          |

Mesh mutations carry a unique `operationId`. The coordinator snapshots the
current interceptor ports when publishing `MESH { operationId, ...mesh }` and
tracks acknowledgements independently for each operation. Interceptors install
the snapshot before sending `MESH_ACK { operationId }`. The coordinator replies
to the mutation initiator with `MESH_APPLIED { operationId }` after every
snapshot recipient acknowledges, or with `OPERATION_ERROR { operationId, error }`
when the mutation fails. An interceptor joining later is not added to an
existing operation, and disconnected recipients are removed from pending sets.

### Peer messages

| Message           | Direction                    | Purpose                                                          |
| ----------------- | ---------------------------- | ---------------------------------------------------------------- |
| `PEER_CONNECT`    | interceptor to server thread | Transfers the shared peer port to a server.                      |
| `PEER_DISCONNECT` | either peer                  | Requests or reports peer teardown.                               |
| `PEER_DRAIN`      | server to interceptor        | Stops new dispatches on a peer and requests a delivery boundary. |
| `PEER_DRAIN_ACK`  | interceptor to server        | Reports the last dispatch index sent before draining.            |
| `REQUEST`         | interceptor to server        | Carries a normal HTTP request.                                   |
| `RESPONSE`        | server to interceptor        | Carries response headers and an inline or streamed body.         |
| `UPGRADE`         | interceptor to server        | Transfers an HTTP upgrade socket port and request metadata.      |
| `ERROR`           | server to interceptor        | Carries a server-side request or handler error.                  |

Coordinator membership ports and request peer ports are separate. Closing one
does not itself close the other.

## Request and Response Flow

For a thread-mode HTTP request:

1. The interceptor runs `onRequest` hooks and selects a server.
2. It lazily creates or reuses the server peer.
3. It creates a pending entry, assigns a per-peer `dispatchIndex`, and sends a
   `REQUEST` message.
4. The server admits the message to its fair request queue.
5. The server creates a light-my-request-compatible request and dispatches it
   to the registered target.
6. The server runs server-side request hooks and serializes the response.
7. The interceptor publishes response headers, runs response hooks, and feeds
   the response body to Undici's handler.
8. The pending entry is removed when the response completes or fails.

Request headers are sanitized before transfer. The `host` header is set to the
target host and hop-by-hop `connection` and `transfer-encoding` headers are
removed. Query data is transferred separately.

Server targets may be:

- A function handler.
- An object with an `inject()` method.
- An HTTP-style emitter with a `request` event surface.
- A Fastify-style application/server.

Server response failures become `ERROR` messages. The interceptor invokes
`onError` hooks and the dispatch handler's `onResponseError` callback.

## Bodies and MessagePort Streams

`MAX_BODY` is `32 * 1024` bytes.

Small, known-length response bodies are transferred inline in `RESPONSE.body`.
Unknown-length or larger bodies use a transferred `bodyPort`.

Request and response streams use the stream classes in
`src/message-port-streams.ts`. Their control messages are:

- `chunks`: data available for reading.
- `more`: the consumer grants more write/read credit.
- `fin`: end-of-stream.
- `err`: stream failure.

The stream implementation uses explicit credit to avoid unbounded buffering.
Closing or destroying one side propagates termination to the other side and
releases its port.

`MessagePortDuplex` is used for upgraded sockets. It provides bidirectional
streaming and does not represent a TCP socket itself.

## Dispatch Index and Shutdown Boundary

Every normal request and upgrade sent over a peer has a monotonically increasing
`dispatchIndex`. The counter is local to that peer and shared by HTTP requests
and upgrades. It is an ordering marker, not a globally unique request ID; the
message `id` remains the request identity.

When a server starts closing:

1. It sends `SERVER_LEAVE` while remaining operational.
2. It waits for `MESH_APPLIED` so stale interceptors have converged.
3. It marks itself closed and keeps the coordinator port open.
4. It sends `PEER_DRAIN` to every connected peer.
5. The interceptor marks that peer as draining and replies with its current
   `lastDispatchIndex`.
6. The server uses that value as the peer's admission boundary.

Messages at or below the boundary were sent before the peer entered draining
and are admitted. Messages above the boundary are treated as post-shutdown
messages and receive the normal shutdown response (`503 Service Unavailable`).

This barrier exists because a request can be selected and posted by an
interceptor while its `MessagePort` callback has not yet run in the server
thread. Waiting only for the server queue would miss that message.

Requests delivered during shutdown wait for the peer drain barrier before the
server decides whether they are admitted. Upgrade messages bypass the normal
HTTP queue, so they are held separately until the same boundary is known.

If a peer does not acknowledge within the internal one-second drain wait, the
server releases the waiters and continues cleanup. The peer is then closed by
the normal final cleanup path. Current package peers implement the drain
acknowledgement protocol.

## Server Close Ordering

`Server.close()` is idempotent and concurrent callers receive the same promise.
The close sequence is:

1. Publish `SERVER_LEAVE` without closing the coordinator port.
2. Wait for mesh convergence while accepting requests from stale snapshots.
3. Set `#closed`, `#draining`, and state `closed`.
4. Establish peer drain barriers.
4. Admit or reject pending upgrades using their dispatch boundaries.
5. Wait for the request queue and active request handlers.
6. Wait for established upgrade sockets up to `upgradeDrainTimeout`.
7. Destroy remaining sockets with a server-closed error.
8. Send `PEER_DISCONNECT` and close peer ports.
9. Close the coordinator port and remove the process worker-message listener.

The request queue waits for the handler promise, not merely for the callback to
start. This makes queue drain completion include active request work.

Established WebSockets are never migrated to another target. New upgrades are
rejected once the target is unavailable. The default socket drain timeout is
30 seconds; `0` destroys established sockets immediately.

## Upgrade Routing

### Undici upgrade dispatch

The Undici path creates a dedicated `MessageChannel` for each upgrade. The
socket port is transferred in an `UPGRADE` message.

The server reconstructs request headers and creates a `FakeSocket`. It invokes
the explicit upgrade handler, the target's `upgrade` emitter, or a Fastify
`.server` emitter.

The server's raw handshake bytes return through the socket port:

- `101` establishes a duplex tunnel.
- A non-`101` response is replayed as a normal HTTP response.
- A connection close before the response head is an error.

Paused or unavailable targets return an in-band `503`. A capable target with no
upgrade listener returns `501`.

### `createUpgradeAgent()`

`createUpgradeAgent()` adapts the mesh to `node:http` clients such as `ws` and
`@fastify/http-proxy`. It intercepts matching upgrade requests and falls back
to real TCP for other hosts.

For a thread target, it transfers the client socket port to the server. For a
TCP target, it connects directly to the target address and splices the local
and remote sockets.

The agent is for upgrades only. Regular HTTP requests through it receive
`501`; use the Undici interceptor for normal HTTP traffic. This direct byte-pipe
path does not emit interceptor response hooks or interceptor upgrade-established
and upgrade-rejected diagnostics.

Mesh WebSocket URLs must use `ws://`/`http:` origins. There is no TLS inside the
mesh. `wss://` is delegated to normal Undici dispatch.

## Queue Fairness

Server requests use `fastq` with a concurrency limit of eight. After eight
dispatches in the same event-loop iteration, the queue yields with an
unreferenced `setImmediate()`.

The yield allows timers, close messages, and peer-management messages to run
under synchronous application load. It affects responsiveness, not request
ordering.

Queue callback failures are isolated so one failed request does not strand
later requests. `drained()` resolves only after queued and running callbacks
are idle.

## Errors and Timeouts

The public errors are:

```text
NoAvailableTargetError  code: UND_TI_NO_AVAILABLE_TARGET
ConnectTimeoutError     code: UND_TI_CONNECT_TIMEOUT
```

`connectTimeout` applies to peer creation, normal thread-mode responses,
Undici upgrade handshakes, and the upgrade-agent handshake path. A value of
zero disables the response wait timeout.

Late responses with no pending consumer have their response body ports closed
so the server can release buffered data.

Hooks may be a function or an array of functions. Hooks are synchronous; async
hooks are rejected during construction. Interceptor hooks receive request,
response, context, or error data according to their phase. Server hooks receive
the synthetic request and response/error values.

## Diagnostics

Diagnostics use `node:diagnostics_channel`.

Undici-compatible channels:

- `undici:request:create`
- `undici:request:headers`
- `undici:request:trailers`
- `undici:request:error`

Server channels:

- `http.server.request.start`
- `http.server.response.finish`

Mesh and peer channels:

- `undici-thread-interceptor:mesh:update`
- `undici-thread-interceptor:peer:connect`
- `undici-thread-interceptor:peer:disconnect`

Interceptor upgrade channels:

- `undici-thread-interceptor:upgrade:start`
- `undici-thread-interceptor:upgrade:established`
- `undici-thread-interceptor:upgrade:rejected`
- `undici-thread-interceptor:upgrade:closed`

Server upgrade channels:

- `undici-thread-interceptor:server:upgrade:start`
- `undici-thread-interceptor:server:upgrade:reject`
- `undici-thread-interceptor:server:upgrade:closed`

Synthetic Undici request diagnostics are emitted for thread-mode dispatch.
TCP requests use ordinary Undici networking and diagnostics.

## Cleanup Invariants

The implementation relies on these invariants:

- A closed server is never selected as a new target.
- A paused server remains visible but is never selected.
- A request dispatched before the peer drain boundary is not reset by server
  shutdown.
- A request delivered after the boundary receives `503` rather than hanging.
- The queue does not report drained before active request handlers finish.
- Established upgrade tunnels are either drained or explicitly destroyed.
- Closing a peer rejects pending interceptor operations and destroys tunnels.
- Closing a server closes all peer ports, its coordinator port, and its process
  worker-message listener.
- `close()` is safe to call repeatedly and concurrent callers share completion.

Protocol changes should be treated as coordinated internal changes. When a
message shape or lifecycle handshake changes, all members of a mesh should be
upgraded together.
