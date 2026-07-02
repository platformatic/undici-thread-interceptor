export class NoAvailableTargetError extends Error {
  code: string

  constructor (origin: string) {
    super(`No available target found for ${origin}.`)
    this.name = 'NoAvailableTargetError'
    this.code = 'UND_TI_NO_AVAILABLE_TARGET'
  }
}

export class ConnectTimeoutError extends Error {
  code: string

  constructor (message = 'Connection timeout.') {
    super(message)
    this.name = 'ConnectTimeoutError'
    this.code = 'UND_TI_CONNECT_TIMEOUT'
  }
}
