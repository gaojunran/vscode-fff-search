// Drives extension.js against a stubbed vscode + fff-node, without a VS Code host.
// Verifies the picker flow: preview de-duplication, dismiss restore, paging,
// history, fuzzy fallback gating, and that accept records the *current* query.
const Module = require('node:module')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const assert = require('node:assert')

const EXT = path.resolve(__dirname, '..', 'extension.js')
const ROOT = '/w/proj'
// Global storage must be writable; the extension degrades gracefully otherwise.
const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fff-search-test-'))
process.on('exit', () => fs.rmSync(storageDir, { recursive: true, force: true }))

const sleep = ms => new Promise(r => setTimeout(r, ms))

const emitter = () => {
  const listeners = []
  // VS Code exposes events as callable functions: picker.onDidChangeValue(fn).
  const event = listener => {
    listeners.push(listener)
    return { dispose() {} }
  }
  event.fire = value => {
    for (const listener of listeners) listener(value)
  }
  return event
}

const shown = []
const reveals = []
const warnings = []
const errors = []

class FakeQuickPick {
  constructor() {
    this._items = []
    this.value = ''
    this.busy = false
    this.prompt = undefined
    this.title = undefined
    this.buttons = []
    this.selectedItems = []
    this._activeItems = []
    this.disposed = false
    this.visible = false
    this.onDidChangeValue = emitter()
    this.onDidChangeActive = emitter()
    this.onDidAccept = emitter()
    this.onDidTriggerButton = emitter()
    this.onDidTriggerItemButton = emitter()
    this.onDidHide = emitter()
    FakeQuickPick.last = this
  }

  get activeItems() {
    return this._activeItems
  }

  // The real QuickPick fires onDidChangeActive whenever the setter is used.
  set activeItems(items) {
    this._activeItems = items
    this.onDidChangeActive.fire(items)
  }

  show() {
    this.visible = true
  }

  hide() {
    if (!this.visible) return
    this.visible = false
    this.onDidHide.fire()
  }

  dispose() {
    this.disposed = true
  }

  setValue(value) {
    this.value = value
    this.onDidChangeValue.fire(value)
  }

  // Mimics QuickPick's update(): items are replaced, focus goes back to row 0.
  get items() {
    return this._items
  }

  set items(items) {
    this.setItems(items)
  }

  setItems(items) {
    this._items = items
    // A separator is never focused: the list lands on the first real row.
    const first = items.find(item => item.kind !== -1)
    if (!first) return
    this.activeItems = [first]
  }

  accept() {
    this.selectedItems = this.activeItems
    this.onDidAccept.fire()
  }

  trigger(button) {
    this.onDidTriggerButton.fire(button)
  }

  triggerItem(button, item) {
    this.onDidTriggerItemButton.fire({ button, item })
  }
}

const LONG_LINE = `${'x'.repeat(200)}requestCouponPkg`

// Deep enough that a preview can be pushed below the picker: the revealed range
// leads the hit by ~30% of the visible span.
const fakeLines = Array.from({ length: 200 }, (_, i) => `// filler ${i}`)
fakeLines[60] = '  requestCouponPkg(id)  '
fakeLines[69] = 'if (requestCouponPkg(x)) {'
fakeLines[80] = LONG_LINE

const fakeDoc = {
  uri: { fsPath: `${ROOT}/a.js`, scheme: 'file' },
  lineCount: fakeLines.length,
  isClosed: false,
  lineAt(line) {
    return { text: fakeLines[line] }
  },
}

class Selection {
  constructor(line, from, endLine, to) {
    Object.assign(this, { line, from, endLine, to })
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    Object.assign(this, { startLine, startChar, endLine, endChar })
  }
}

const ThemeIcon = class {
  constructor(id) {
    this.id = id
  }
}
ThemeIcon.File = { id: 'file' }
ThemeIcon.Folder = { id: 'folder' }

const handlers = {}

// Mutable so a test can switch modes without reloading the extension.
const settings = {
  maxResults: 200,
  maxMatchesPerFile: 20,
  smartCase: true,
  definitionsFirst: true,
  useExcludeSettings: true,
  fuzzy: 'auto',
  timeBudgetMs: 150,
  maxFileSizeMb: 10,
  persistFrecency: true,
  preview: true,
  restoreEditorOnDismiss: true,
  seedFromSelection: true,
  eagerIndex: false,
}

const excludeSettings = {
  search: { exclude: { '**/dist': true, '**/coverage': false } },
  files: { exclude: { '**/node_modules': true } },
}

const vscodeStub = {
  QuickInputButtonLocation: { Title: 1, Inline: 2, Input: 3 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  ViewColumn: { One: 1, Beside: -2 },
  env: {},
  TextEditorRevealType: { InCenterIfOutsideViewport: 3 },
  ThemeIcon,
  Selection,
  Range,
  Uri: {
    file: p => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }),
    joinPath: (base, rel) => {
      const fsPath = path.join(base.fsPath, rel)
      return { fsPath, scheme: 'file', toString: () => `file://${fsPath}` }
    },
  },
  window: {
    activeTextEditor: {
      document: fakeDoc,
      selection: { isEmpty: true },
      viewColumn: 1,
    },
    visibleTextEditors: [],
    createQuickPick: () => new FakeQuickPick(),
    showTextDocument: async (document, options) => {
      const editor = {
        document,
        selection: null,
        visibleRanges: [{ start: { line: 0 }, end: { line: 40 } }],
        revealRange(range) {
          reveals.push(range)
        },
      }
      shown.push({ document, options, editor })
      vscodeStub.window.visibleTextEditors.push(editor)
      return editor
    },
    showWarningMessage: message => warnings.push(message),
    showErrorMessage: message => errors.push(message),
    onDidChangeWindowState: emitter(),
  },
  workspace: {
    openTextDocument: async () => fakeDoc,
    onDidChangeTextDocument: emitter(),
    workspaceFolders: [{ uri: { fsPath: ROOT } }],
    getWorkspaceFolder: () => ({ uri: { fsPath: ROOT } }),
    getConfiguration: section => ({
      get: key => (section in excludeSettings ? excludeSettings[section][key] : settings[key]),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
  },
  commands: {
    registerCommand: (id, handler) => {
      handlers[id] = handler
      return { dispose() {} }
    },
  },
}

const MATCHES = [
  {
    relativePath: 'src/a.js',
    fileName: 'a.js',
    lineNumber: 61,
    col: 0,
    lineContent: '  requestCouponPkg(id)  ',
    matchRanges: [[2, 19]],
  },
  {
    relativePath: 'src/a.js',
    fileName: 'a.js',
    lineNumber: 70,
    col: 0,
    lineContent: 'if (requestCouponPkg(x)) {',
    matchRanges: [[4, 21]],
  },
  {
    relativePath: 'src/long.js',
    fileName: 'long.js',
    lineNumber: 81,
    col: 0,
    lineContent: LONG_LINE,
    matchRanges: [[200, 217]],
  },
]

const calls = { grep: [], trackQuery: [], create: [] }
const finder = {
  waitForScan: async () => ({ ok: true, value: true }),
  waitForIndexReady: async () => ({ ok: true, value: true }),
  getScanProgress: () => ({ ok: true, value: { scannedFilesCount: 11277, isScanning: false, isWarmupComplete: true } }),
  getHistoricalQuery: offset => ({ ok: true, value: offset === 0 ? 'requestCouponPkg' : null }),
  trackQuery: (query, file) => {
    calls.trackQuery.push({ query, file })
    return { ok: true, value: true }
  },
  grep: (query, options) => {
    calls.grep.push({ query, mode: options.mode, cursor: options.cursor ?? null, classify: options.classifyDefinitions })
    if (/^qqq/.test(query)) {
      return { ok: true, value: { items: [], nextCursor: null } }
    }
    if (/^zzz/.test(query)) {
      return { ok: true, value: { items: options.mode === 'fuzzy' ? [MATCHES[0]] : [], nextCursor: null } }
    }
    if (query === 'zzzfull') {
      const full = { ...MATCHES[0], matchRanges: [[2, 9]] }
      const partial = { ...MATCHES[1], matchRanges: [[4, 7]] }
      return { ok: true, value: { items: options.mode === 'fuzzy' ? [partial, full] : [], nextCursor: null } }
    }
    if (query === 'zzzpart') {
      const partial = { ...MATCHES[1], matchRanges: [[4, 7]] }
      return { ok: true, value: { items: options.mode === 'fuzzy' ? [partial] : [], nextCursor: null } }
    }
    if (query === 'zzfrag') {
      const line = `${'a'.repeat(36)} requestCoupon bbbb Package ccccccccccccccc`
      const hit = { ...MATCHES[0], lineContent: line, matchRanges: [[37, 50], [56, 63]] }
      return { ok: true, value: { items: options.mode === 'fuzzy' ? [hit] : [], nextCursor: null } }
    }
    if (query === 'defs') {
      return { ok: true, value: { items: [{ ...MATCHES[0] }, { ...MATCHES[1], isDefinition: true }], nextCursor: null } }
    }
    if (query === 'many') {
      const start = options.cursor ? 30 : 0
      const items = Array.from({ length: options.cursor ? 10 : 30 }, (_, i) => ({
        ...MATCHES[0],
        relativePath: `src/many${start + i}.js`,
        fileName: `many${start + i}.js`,
        lineNumber: 10 + i,
      }))
      return { ok: true, value: { items, nextCursor: options.cursor ? null : 77 } }
    }
    const items = options.cursor ? MATCHES.slice(1) : MATCHES.slice(0, 1)
    return { ok: true, value: { items, nextCursor: options.cursor ? null : 42 } }
  },
  destroy() {},
}

const fffStub = {
  FileFinder: {
    create: options => {
      calls.create.push(options)
      return { ok: true, value: finder }
    },
  },
}

// The extension talks to the index through a worker; the stub keeps the same
// async surface and forwards to the synchronous fake above.
class FakeFinderClient {
  constructor(options) {
    calls.create.push(options)
    this.ready = Promise.resolve(true)
  }

  waitForScan(timeout) {
    return Promise.resolve(finder.waitForScan(timeout))
  }

  waitForIndexReady(timeout) {
    return Promise.resolve(finder.waitForIndexReady(timeout))
  }

  grep(query, options) {
    return Promise.resolve(finder.grep(query, options))
  }

  getHistoricalQuery(offset) {
    return Promise.resolve(finder.getHistoricalQuery(offset))
  }

  trackQuery(query, file) {
    return Promise.resolve(finder.trackQuery(query, file))
  }

  getScanProgress() {
    return Promise.resolve(finder.getScanProgress())
  }

  destroy() {}
}

const load = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'vscode') return vscodeStub
  if (request === '@ff-labs/fff-node') return fffStub
  if (request === './finder-client') return { FinderClient: FakeFinderClient }
  return load.call(this, request, parent, isMain)
}

const extension = require(EXT)
const context = { subscriptions: [], globalStorageUri: { fsPath: storageDir } }

const open = () => handlers['fffSearch.open']()
const step = async (name, fn) => {
  try {
    await fn()
    console.log(`ok  ${name}`)
  } catch (error) {
    console.error(`FAIL ${name}\n     ${error.message}`)
    process.exitCode = 1
  }
}

async function main() {
  extension.activate(context)
  await step('activate registers the command', () => assert.equal(typeof handlers['fffSearch.open'], 'function'))

  await step('empty input shows recent searches', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    assert.equal(picker.items[0]?.query, 'requestCouponPkg', 'history row expected')
    assert.equal(picker.title, 'proj')
    picker.hide()
  })

  await step('exclude settings reach the index as extraIgnore', () => {
    const options = calls.create[0]
    assert.deepEqual(options.extraIgnore, ['**/dist', '**/node_modules'], 'only enabled excludes apply')
  })

  await step('typing renders cropped labels + file icons and pages', async () => {
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    picker.setValue('requestCouponPkg')
    await sleep(220)
    assert.equal(picker.items.length, 2, `expected 1 match + load more, got ${picker.items.length}`)
    assert.equal(picker.items[0].label, 'requestCouponPkg(id)', 'label should be trimmed')
    assert.doesNotMatch(picker.items[0].label, /\u0332/, 'literal hits rely on the picker own highlight')
    assert.ok(picker.items[0].resourceUri.fsPath.endsWith('src/a.js'), 'resourceUri drives the icon')
    assert.ok(picker.items[1].more, 'last row should be Load more')
    assert.match(picker.prompt ?? '', /1 file · 1 match · truncated · \d+ ms/, picker.prompt)
  })

  await step('preview opens the editor once, not once per keystroke', async () => {
    const picker = FakeQuickPick.last
    picker.setValue('requestCouponPkg ')
    await sleep(220)
    picker.setValue('requestCouponPkgx')
    await sleep(220)
    picker.setValue('requestCouponPkg')
    await sleep(220)
    // Cumulative: the first render already previewed this row.
    const previews = shown.filter(s => s.options.preserveFocus)
    assert.equal(previews.length, 1, `expected 1 preview open, got ${previews.length}`)
  })

  await step('long lines are cropped around the hit', async () => {
    const picker = FakeQuickPick.last
    picker.activeItems = [picker.items[1]]
    picker.accept() // load more
    await sleep(50)
    assert.equal(calls.grep.at(-1).cursor, 42, 'second page must pass the cursor')
    const long = picker.items.find(item => item.detail === 'src/long.js')
    assert.ok(long, 'page 2 should contain the long-line match')
    assert.ok(long.label.startsWith('…'), `cropped label expected, got ${long.label.slice(0, 20)}`)
    assert.ok(long.label.includes('requestCouponPkg'), 'the hit must stay visible')
  })

  await step('accept records the current query and does not restore', async () => {
    const picker = FakeQuickPick.last
    shown.length = 0
    picker.activeItems = [picker.items[0]]
    picker.accept()
    assert.deepEqual(calls.trackQuery.at(-1), { query: 'requestCouponPkg', file: '/w/proj/src/a.js' })
    await sleep(220)
    assert.ok(shown.some(s => s.options.preserveFocus === false), 'accept should open the file')
    assert.equal(picker.visible, false, 'picker should be hidden')
    assert.ok(!shown.some(s => s.document === fakeDoc && s.options.preview === false), 'no restore after accept')
  })

  await step('dismissing restores the editor behind the picker', async () => {
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    picker.setValue('requestCouponPkg')
    await sleep(220)
    picker.hide()
    await sleep(220)
    const restore = shown.find(s => s.document === fakeDoc && s.options.preview === false)
    assert.ok(restore, 'dismiss should re-reveal the previous editor')
    assert.equal(restore.options.viewColumn, 1)
  })

  await step('auto mode retries fuzzy after a cheap zero-hit literal pass', async () => {
    settings.fuzzy = 'auto'
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    // The picker re-seeds the last query, so drop those calls.
    calls.grep.length = 0
    picker.setValue('zzz')
    await sleep(220)
    assert.deepEqual(calls.grep.map(call => call.mode), ['plain', 'fuzzy'])
    assert.match(picker.prompt ?? '', /^fuzzy · /, picker.prompt)
    assert.match(picker.items[0].label, /\u0332/, 'fuzzy fragments are underlined')
    assert.equal(
      picker.items[0].label.replace(/\u0332/g, ''),
      'requestCouponPkg(id)',
      'the underline adds no visible text',
    )
    picker.hide()
  })

  await step('every fuzzy fragment is underlined, and only those', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    picker.setValue('zzfrag')
    await sleep(220)
    const label = picker.items[0].label
    assert.equal(label.replace(/\u0332/g, '').includes('requestCoupon bbbb Package'), true, label)
    assert.equal((label.match(/\u0332/g) || []).length, 20, '13 + 7 characters are marked')
    assert.ok(label.startsWith('a'.repeat(36)), 'the text before the hit is untouched')
    picker.hide()
  })

  await step('fuzzy drops rows that only matched part of the query', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    picker.setValue('zzzfull')
    await sleep(220)
    assert.equal(picker.items.length, 1, 'the 3-character match is dropped, the 7-character one kept')
    assert.equal(picker.items[0].match.lineNumber, 61)
    picker.setValue('zzzpart')
    await sleep(220)
    assert.equal(picker.items.length, 1, 'a partial match survives when nothing covers the whole query')
    picker.hide()
  })

  await step('manual mode never runs fuzzy on its own', async () => {
    settings.fuzzy = 'manual'
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    calls.grep.length = 0
    picker.setValue('zzzq')
    await sleep(220)
    assert.deepEqual(calls.grep.map(call => call.mode), ['plain'])
    assert.ok(picker.items[0].retryFuzzy, 'the retry row is how fuzzy is reached here')
    assert.doesNotMatch(picker.prompt ?? '', /fuzzy/, picker.prompt)
    picker.hide()
  })

  await step('off mode hides the fuzzy retry', async () => {
    settings.fuzzy = 'off'
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    calls.grep.length = 0
    picker.setValue('zzzqw')
    await sleep(220)
    const modes = calls.grep.map(call => call.mode)
    settings.fuzzy = 'auto'
    assert.deepEqual(modes, ['plain'])
    assert.equal(picker.items.length, 0, 'no retry row when fuzzy is off')
    picker.hide()
  })

  await step('accepting the retry row searches fuzzy', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    calls.grep.length = 0
    picker.setValue('qqqx')
    await sleep(220)
    assert.equal(picker.items.length, 1)
    assert.ok(picker.items[0].retryFuzzy, 'zero-hit query should offer the fuzzy retry')
    calls.grep.length = 0
    picker.accept()
    await sleep(50)
    assert.deepEqual(calls.grep.map(call => call.mode), ['fuzzy'], 'retry must search fuzzy, not literal')
    assert.match(picker.prompt ?? '', /^fuzzy · /, picker.prompt)
    picker.hide()
  })

  await step('per-result buttons preview in place and open to the side', async () => {
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    await sleep(50)
    picker.setValue('requestCouponPkg')
    await sleep(220)
    const item = picker.items[0]
    assert.equal(item.buttons.length, 2, 'rows should expose two buttons')

    picker.triggerItem(item.buttons[0], item)
    await sleep(220)
    assert.equal(picker.visible, true, 'preview must keep the picker open')
    assert.ok(
      shown.some(s => s.options.preview === true && s.options.preserveFocus === true),
      'preview should open in the background',
    )
    assert.ok(!shown.some(s => s.options.viewColumn === -2), 'preview must not open beside')

    picker.triggerItem(item.buttons[1], item)
    await sleep(220)
    assert.ok(shown.some(s => s.options.viewColumn === -2), 'side button should open beside')
    assert.equal(picker.visible, false)
  })

  await step('definitions are hoisted, marked, and left alone when grouped', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    picker.setValue('defs')
    await sleep(220)
    assert.equal(calls.grep.at(-1).classify, 'classify', 'classification must be requested')
    assert.equal(picker.items[0].match.lineNumber, 70, 'the definition moves to the top')
    assert.match(picker.items[0].label, /^\$\(symbol-misc\) /, picker.items[0].label)
    assert.equal(picker.items[1].match.lineNumber, 61, 'the rest keeps fff order')
    assert.doesNotMatch(picker.items[1].label, /symbol-misc/)

    picker.trigger(picker.buttons[2]) // group
    assert.equal(picker.items[1].match.lineNumber, 61, 'grouped mode keeps file order')
    assert.match(picker.items[2].label, /^\$\(symbol-misc\) /, 'the mark survives grouping')
    picker.trigger(picker.buttons[2])
    picker.hide()
  })

  await step('grouped mode keeps one row per match under a file header', async () => {
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    const kinds = () => picker.items.map(item => (item.kind === -1 ? 'sep' : 'row'))
    assert.equal(picker.sortByLabel, false, 'label sorting must be off or headers are dropped while typing')
    picker.setValue('requestCouponPkg')
    await sleep(220)
    picker.trigger(picker.buttons[2]) // group
    assert.deepEqual(kinds(), ['sep', 'row', 'sep', 'row'], kinds().join(','))
    assert.equal(picker.items[0].label, 'src/a.js')
    assert.equal(picker.items[1].description, '61')
    assert.equal(picker.items[1].detail, undefined, 'the path moved into the header')
    assert.equal(picker.items[2].label, '1 loaded', 'the paging row gets its own header when grouped')

    picker.activeItems = [picker.items[3]]
    picker.accept() // load page 2 while grouped
    await sleep(50)
    assert.deepEqual(kinds(), ['sep', 'row', 'row', 'sep', 'row'], kinds().join(','))
    assert.equal(picker.items[2].description, '70', 'a second match in the same file is its own row')
    assert.equal(picker.items[3].label, 'src/long.js')
    picker.trigger(picker.buttons[2]) // back to a flat list for the next steps
    picker.hide()
  })

  await step('preview pushes the hit below the picker, accept does not', async () => {
    reveals.length = 0
    await open()
    const picker = FakeQuickPick.last
    picker.setValue('requestCouponPkg')
    await sleep(220)

    const previewed = reveals.at(-1)
    assert.equal(previewed.startLine, 48, 'preview leads the hit by 30% of the viewport')
    assert.equal(previewed.endLine, 60, 'the revealed range ends at the hit')

    picker.accept()
    await sleep(20)
    const accepted = reveals.at(-1)
    assert.equal(accepted.line, 60, 'accept reveals the selection itself, not a lead range')
    assert.equal(accepted.endLine, 60)
  })

  await step('preview waits for typing to settle', async () => {
    shown.length = 0
    await open()
    const picker = FakeQuickPick.last
    await sleep(30)
    picker.setValue('requestCouponPkgx')
    // Past the 60 ms search debounce, short of the 110 ms preview delay.
    await sleep(80)
    assert.equal(shown.filter(s => s.options.preserveFocus).length, 0, 'no preview mid-typing')
    await sleep(220)
    assert.equal(shown.filter(s => s.options.preserveFocus).length, 1, 'one preview once typing stops')
    picker.hide()
  })

  await step('a second hit in the same file reuses the preview editor', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(300)
    picker.setValue('defs')
    await sleep(300)
    const opened = shown.length
    picker.activeItems = [picker.items[1]]
    await sleep(300)
    assert.equal(shown.length, opened, 'the open document is reused, not reopened')
    picker.hide()
  })

  await step('moving near the end of a long list prefetches the next page', async () => {
    await open()
    const picker = FakeQuickPick.last
    await sleep(50)
    picker.setValue('many')
    await sleep(220)
    assert.equal(picker.items.length, 31, '30 hits plus the Load more row')

    const before = calls.grep.length
    picker.activeItems = [picker.items[25]]
    await sleep(100)
    assert.ok(calls.grep.length > before, 'the next page is fetched without pressing Load more')
    assert.equal(picker.items.length, 40, 'the second page is appended')
    assert.equal(picker.activeItems[0].match.lineNumber, 35, 'focus stays on the row being read')

    const after = calls.grep.length
    picker.activeItems = [picker.items[25]]
    await sleep(60)
    assert.equal(calls.grep.length, after, 'one prefetch per row')
    picker.hide()
  })

  await step('pressing the shortcut again dismisses the picker', async () => {
    await open()
    const picker = FakeQuickPick.last
    assert.equal(picker.visible, true)
    await open()
    assert.equal(picker.visible, false, 'a second press should close the picker')
    assert.equal(picker.disposed, true)
    assert.equal(FakeQuickPick.last, picker, 'no second picker should be created')
  })

  await step('no stray errors or warnings', () => {
    assert.deepEqual(errors, [])
    assert.deepEqual(warnings, [])
  })
}

main().then(
  () => {
    if (!process.exitCode) console.log('\nall checks passed')
  },
  error => {
    console.error('SIM CRASHED:', error)
    process.exit(1)
  },
)
