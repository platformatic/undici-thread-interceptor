'use strict'

const { request } = require('undici')

function requestWithTimeout (url, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 1000
    delete options.timeout

    const reqTimeout = setTimeout(
      () => reject(new Error('timeout')),
      timeout
    ).unref()

    request(url, options)
      .then(resolve)
      .catch(reject)
      .finally(() => clearTimeout(reqTimeout))
  })
}

module.exports = { requestWithTimeout }
