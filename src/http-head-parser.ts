const MAX_HEAD_SIZE = 16 * 1024
const HEAD_TERMINATOR = Buffer.from('\r\n\r\n')

export interface ParsedResponseHead {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[]>
  // Flat [name, value, ...] Buffer pairs, mirroring the shape undici's H1
  // client hands to onRequestUpgrade via controller.rawHeaders.
  rawHeaders: Buffer[]
  rest: Buffer
}

export class InvalidResponseHeadError extends Error {
  code = 'UND_TI_INVALID_RESPONSE_HEAD'
}

/**
 * Incremental parser for an HTTP/1.1 response head arriving as raw bytes over
 * a tunneled connection. Feed chunks until it returns a parsed head; bytes
 * following the head terminator are returned untouched in `rest`.
 */
export class HttpResponseHeadParser {
  #buffer: Buffer

  constructor () {
    this.#buffer = Buffer.alloc(0)
  }

  feed (chunk: Buffer): ParsedResponseHead | null {
    this.#buffer = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk])

    const terminator = this.#buffer.indexOf(HEAD_TERMINATOR)
    if (terminator === -1) {
      if (this.#buffer.length > MAX_HEAD_SIZE) {
        throw new InvalidResponseHeadError('response head exceeds maximum size')
      }

      return null
    }

    const lines = this.#buffer.subarray(0, terminator).toString('latin1').split('\r\n')
    const match = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0])

    if (!match) {
      throw new InvalidResponseHeadError(`invalid status line: ${lines[0]}`)
    }

    const headers: Record<string, string | string[]> = {}
    const rawHeaders: Buffer[] = []

    for (let i = 1; i < lines.length; i++) {
      const separator = lines[i].indexOf(':')

      if (separator === -1) {
        throw new InvalidResponseHeadError(`invalid header line: ${lines[i]}`)
      }

      const name = lines[i].slice(0, separator).trim().toLowerCase()
      const value = lines[i].slice(separator + 1).trim()
      const existing = headers[name]

      if (existing === undefined) {
        headers[name] = value
      } else if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        headers[name] = [existing, value]
      }

      rawHeaders.push(Buffer.from(name, 'latin1'), Buffer.from(value, 'latin1'))
    }

    return {
      statusCode: Number(match[1]),
      statusMessage: match[2] ?? '',
      headers,
      rawHeaders,
      rest: this.#buffer.subarray(terminator + HEAD_TERMINATOR.length)
    }
  }
}
