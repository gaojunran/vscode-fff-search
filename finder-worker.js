// Runs the fff index off the extension host: grep is a synchronous FFI call, so
// doing it here keeps typing in VS Code responsive while a query scans.
const { parentPort } = require('node:worker_threads')
const { FileFinder } = require('@ff-labs/fff-node')

let finder

const handlers = {
  create(options) {
    const created = FileFinder.create(options)
    if (!created.ok) throw new Error(created.error)
    finder = created.value
    return true
  },
  waitForScan: timeout => finder.waitForScan(timeout),
  waitForIndexReady: timeout => finder.waitForIndexReady(timeout),
  grep: ({ query, options }) => finder.grep(query, options),
  getHistoricalQuery: offset => finder.getHistoricalQuery(offset),
  trackQuery: ({ query, filePath }) => finder.trackQuery(query, filePath),
  getScanProgress: () => finder.getScanProgress(),
  destroy: () => {
    finder?.destroy()
    finder = undefined
    return true
  },
}

parentPort.on('message', async ({ id, op, args }) => {
  try {
    // Some SDK calls are async (waitForScan, waitForIndexReady); grep is sync.
    parentPort.postMessage({ id, result: await handlers[op](args) })
  } catch (error) {
    parentPort.postMessage({ id, error: error.message })
  }
})
