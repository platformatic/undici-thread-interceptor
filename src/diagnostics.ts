import diagnosticsChannel from 'node:diagnostics_channel'

export const kWrappedRequest = Symbol('undici-thread-interceptor.wrappedRequest')

export const channels = {
  requestCreate: diagnosticsChannel.channel('undici:request:create'),
  requestHeaders: diagnosticsChannel.channel('undici:request:headers'),
  requestTrailers: diagnosticsChannel.channel('undici:request:trailers'),
  requestError: diagnosticsChannel.channel('undici:request:error'),
  serverRequestStart: diagnosticsChannel.channel('http.server.request.start'),
  serverResponseFinish: diagnosticsChannel.channel('http.server.response.finish'),
  meshUpdate: diagnosticsChannel.channel('undici-thread-interceptor:mesh:update'),
  peerConnect: diagnosticsChannel.channel('undici-thread-interceptor:peer:connect'),
  peerDisconnect: diagnosticsChannel.channel('undici-thread-interceptor:peer:disconnect'),
  upgradeStart: diagnosticsChannel.channel('undici-thread-interceptor:upgrade:start'),
  upgradeEstablished: diagnosticsChannel.channel('undici-thread-interceptor:upgrade:established'),
  upgradeRejected: diagnosticsChannel.channel('undici-thread-interceptor:upgrade:rejected'),
  upgradeClosed: diagnosticsChannel.channel('undici-thread-interceptor:upgrade:closed'),
  serverUpgradeStart: diagnosticsChannel.channel('undici-thread-interceptor:server:upgrade:start'),
  serverUpgradeReject: diagnosticsChannel.channel('undici-thread-interceptor:server:upgrade:reject'),
  serverUpgradeClosed: diagnosticsChannel.channel('undici-thread-interceptor:server:upgrade:closed')
}

export interface UpgradeDiagnosticsPayload {
  meshId: string
  origin: string
  interceptorId: string
  serverId: string
  method: string
  path: string
  statusCode?: number
}

export interface PeerDiagnosticsPayload {
  meshId: string
  origin: string
  interceptorId: string
  serverId: string
  role: 'interceptor' | 'server'
  threadId: number
}

export function getWrappedRequest (request: any, context: Record<PropertyKey, unknown>): any {
  if (context[kWrappedRequest]) {
    return context[kWrappedRequest]
  }

  const headers: Array<string | number> = []
  for (const [key, value] of Object.entries(request.headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.push(key, item)
      }
    } else if (value !== undefined) {
      headers.push(key, value as string | number)
    }
  }

  const origin = request.origin instanceof URL ? request.origin.toString() : String(request.origin)
  const originUrl = new URL(origin)

  context[kWrappedRequest] = {
    origin,
    method: request.method ?? 'GET',
    path: request.path,
    headers,
    host: request.headers?.host ?? originUrl.host,
    addHeader (name: string, value: string) {
      headers.push(name, value)
      request.headers ??= {}
      request.headers[name] = value
    },
    completed: false,
    aborted: false,
    idempotent: ['GET', 'HEAD', 'OPTIONS'].includes(request.method ?? 'GET'),
    contentLength: request.headers?.['content-length'] ?? null,
    contentType: request.headers?.['content-type'] ?? null,
    body: request.body ?? null
  }

  return context[kWrappedRequest]
}

function convertResponseHeaders (
  headers: Record<string, string | string[] | number | undefined> | undefined
): Array<string | number> {
  const result: Array<string | number> = []

  for (const [key, value] of Object.entries(headers ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        result.push(key, item)
      }
    } else if (value !== undefined) {
      result.push(key, value)
    }
  }

  return result
}

export function publishRequestHeaders (
  request: any,
  response: {
    statusCode: number
    headers?: Record<string, string | string[] | number | undefined>
    statusMessage?: string
  },
  context: Record<PropertyKey, unknown>
): void {
  if (!channels.requestHeaders.hasSubscribers) {
    return
  }

  const wrappedRequest = getWrappedRequest(request, context)
  if (wrappedRequest) {
    channels.requestHeaders.publish({
      request: wrappedRequest,
      response: {
        statusCode: response.statusCode,
        headers: convertResponseHeaders(response.headers),
        statusText: response.statusMessage ?? ''
      }
    })
  }
}
