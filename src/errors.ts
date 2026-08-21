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

export class TargetChangedError extends Error {
  code: string

  constructor (message = 'Mesh target changed during dispatch.') {
    super(message)
    this.name = 'TargetChangedError'
    this.code = 'UND_TI_TARGET_CHANGED'
  }
}
