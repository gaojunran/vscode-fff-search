const path = require('node:path')
const { Worker } = require('node:worker_threads')

/**
 * Talks to the index worker. Every method resolves with the same `{ ok, value }`
 * result the SDK returns, so call sites only had to add an await.
 */
class FinderClient {
  constructor(options) {
    this.pending = new Map()
    this.nextId = 1
    this.closed = false
    this.worker = new Worker(path.join(__dirname, 'finder-worker.js'))
    this.worker.on('message', ({ id, result, error }) => {
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (error) entry.reject(new Error(error))
      else entry.resolve(result)
    })
    this.worker.on('error', error => this.fail(error))
    this.worker.on('exit', code => {
      if (!this.closed) this.fail(new Error(`the index worker exited (${code})`))
    })
    this.ready = this.call('create', options)
  }

  call(op, args) {
    if (this.closed) return Promise.reject(new Error('the index worker is closed'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.worker.postMessage({ id, op, args })
    })
  }

  fail(error) {
    this.closed = true
    for (const { reject } of this.pending.values()) reject(error)
    this.pending.clear()
  }

  waitForScan(timeout) {
    return this.call('waitForScan', timeout)
  }

  waitForIndexReady(timeout) {
    return this.call('waitForIndexReady', timeout)
  }

  grep(query, options) {
    return this.call('grep', { query, options })
  }

  getHistoricalQuery(offset) {
    return this.call('getHistoricalQuery', offset)
  }

  trackQuery(query, filePath) {
    return this.call('trackQuery', { query, filePath })
  }

  getScanProgress() {
    return this.call('getScanProgress')
  }

  destroy() {
    this.closed = true
    this.worker.terminate()
  }
}

module.exports = { FinderClient }
