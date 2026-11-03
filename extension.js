const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

/** One resident index per workspace folder: { finder, ready }. */
const finders = new Map()

/** Picker toggles, kept for the window's lifetime. */
const toggles = { regex: false, grouped: false }

/** Matches kept from the last search, so re-rendering does not hit the index. */
let lastQuery = ''
let extensionContext
let openPickerHandle

const config = () => vscode.workspace.getConfiguration('fffSearch')

function activeRoot() {
  const editor = vscode.window.activeTextEditor
  const folder = editor ? vscode.workspace.getWorkspaceFolder(editor.document.uri) : undefined
  return (folder ?? vscode.workspace.workspaceFolders?.[0])?.uri.fsPath
}

function selectedText() {
  const editor = vscode.window.activeTextEditor
  if (!editor || editor.selection.isEmpty) return ''
  const text = editor.document.getText(editor.selection)
  return text.includes('\n') ? '' : text.trim()
}

function fileUri(root, relativePath) {
  return vscode.Uri.joinPath(vscode.Uri.file(root), relativePath)
}

/**
 * fff reports UTF-8 byte offsets; VS Code works in UTF-16 code units.
 * Returns [start, end] as code-unit indices into `text`.
 */
function charRange(text, range) {
  const bytes = Buffer.from(text, 'utf8')
  const at = offset => bytes.subarray(0, Math.min(offset, bytes.length)).toString('utf8').length
  const from = range?.[0] ?? 0
  return [at(from), at(range?.[1] ?? from)]
}

/** Wall-clock budget per keystroke, split between the literal and fuzzy pass. */
function searchOptions(mode, smartCase, timeBudgetMs, cursor) {
  return {
    mode,
    pageSize: config().get('maxResults'),
    maxMatchesPerFile: config().get('maxMatchesPerFile'),
    maxFileSize: config().get('maxFileSizeMb') * 1024 * 1024,
    smartCase,
    // grep is a synchronous FFI call that blocks the extension host, so it needs
    // a ceiling. A zero-match query scans every candidate file by default.
    timeBudgetMs,
    enforceTimeBudget: true,
    beforeContext: 0,
    afterContext: 0,
    ...(cursor ? { cursor } : {}),
  }
}

/** Keep the hit visible when a long line is cut down to a label. */
function cropLine(text, ranges) {
  const line = text.trim()
  if (!line) return '\u00a0'
  if (line.length <= 110) return line

  const hitStart = charRange(text, ranges?.[0])[0]
  const head = Math.max(0, hitStart - 40)
  const tail = Math.min(text.length, hitStart + 70)
  const slice = text.slice(head, tail).trim()
  if (!slice) return line.slice(0, 110)
  return `${head > 0 ? '…' : ''}${slice}${tail < text.length ? '…' : ''}`
}

/** Per-result buttons; only rendered because the picker comes from createQuickPick. */
const BUTTON_SIDE = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open to the side' }
const BUTTON_COPY = { iconPath: new vscode.ThemeIcon('copy'), tooltip: 'Copy relative path' }
const itemButtons = [BUTTON_SIDE, BUTTON_COPY]

function toItem(root, match) {
  return {
    // Results are already ranked and filtered by fff. alwaysShow stops QuickPick
    // from filtering them again by label, which would hide fuzzy matches because
    // their lines do not contain the literal query.
    alwaysShow: true,
    label: cropLine(match.lineContent, match.matchRanges),
    description: `${match.fileName}:${match.lineNumber}`,
    detail: match.relativePath,
    // Derives the file-type icon from the active icon theme.
    resourceUri: fileUri(root, match.relativePath),
    iconPath: vscode.ThemeIcon.File,
    buttons: itemButtons,
    match,
  }
}

function toItems(root, matches) {
  if (!toggles.grouped) return matches.map(match => toItem(root, match))

  // QuickPick drops separators whenever the input is non-empty (sortByLabel
  // defaults to true and no public API changes it), so group by collapsing
  // each file into a single row instead.
  const files = new Map()
  for (const match of matches) {
    const entry = files.get(match.relativePath)
    if (entry) entry.count++
    else files.set(match.relativePath, { match, count: 1 })
  }

  return [...files.values()].map(({ match, count }) => ({
    alwaysShow: true,
    label: match.relativePath,
    description: `${count} ${count === 1 ? 'match' : 'matches'}`,
    detail: cropLine(match.lineContent, match.matchRanges),
    resourceUri: fileUri(root, match.relativePath),
    iconPath: vscode.ThemeIcon.Folder,
    buttons: itemButtons,
    match,
  }))
}

/**
 * The line fff indexed may have moved (unsaved edits). Returns -1 when the match
 * is gone, so the caller can avoid selecting an unrelated line.
 */
function locateLine(document, match) {
  const indexed = Math.min(Math.max(match.lineNumber - 1, 0), document.lineCount - 1)
  const needle = match.lineContent.trim().slice(0, 48)
  if (!needle) return indexed

  const includes = line => document.lineAt(line).text.includes(needle)
  for (let distance = 0; distance <= 20; distance++) {
    if (indexed + distance < document.lineCount && includes(indexed + distance)) return indexed + distance
    if (distance > 0 && indexed - distance >= 0 && includes(indexed - distance)) return indexed - distance
  }
  return -1
}

async function reveal(root, match, options) {
  let document
  let editor
  try {
    document = await vscode.workspace.openTextDocument(fileUri(root, match.relativePath))
    editor = await vscode.window.showTextDocument(document, {
      preview: true,
      preserveFocus: options.preserveFocus,
      ...(options.viewColumn ? { viewColumn: options.viewColumn } : {}),
    })
  } catch {
    // The file may have been deleted or renamed while the picker was open.
    if (options.warnIfStale) vscode.window.showWarningMessage('FFF: that file is no longer available.')
    return
  }

  const line = locateLine(document, match)
  if (line < 0) {
    if (options.warnIfStale) {
      vscode.window.showWarningMessage('FFF: the file changed since it was indexed; the match is gone.')
    }
    return
  }

  const indexedLine = Math.min(Math.max(match.lineNumber - 1, 0), document.lineCount - 1)
  const [from, to] = line === indexedLine ? charRange(document.lineAt(line).text, match.matchRanges?.[0]) : [0, 0]
  const selection = new vscode.Selection(line, from, line, to)
  editor.selection = selection
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

function createFinder(root) {
  const { FileFinder } = require('@ff-labs/fff-node')
  const options = { basePath: root }

  if (config().get('persistFrecency')) {
    const dir = extensionContext.globalStorageUri.fsPath
    try {
      fs.mkdirSync(dir, { recursive: true })
      options.frecencyDbPath = path.join(dir, 'frecency.db')
      options.historyDbPath = path.join(dir, 'history.db')
    } catch {
      // Unwritable global storage must not take the search index down with it.
    }
  }

  const created = FileFinder.create(options)
  if (!created.ok) throw new Error(created.error)
  return created.value
}

/** Returns { finder, ready } immediately so the picker can show scan progress. */
function getFinder(root) {
  const cached = finders.get(root)
  if (cached) return cached

  const finder = createFinder(root)
  const entry = { finder, ready: null }
  entry.ready = (async () => {
    const scanned = await finder.waitForScan(60_000)
    if (!scanned.ok) throw new Error(scanned.error)
    if (!scanned.value) throw new Error('timed out waiting for the file scan')
    // grep returns nothing until the content index is built, so waiting for the
    // file scan alone is not enough.
    const indexed = await finder.waitForIndexReady(120_000)
    if (!indexed.ok) throw new Error(indexed.error)
    if (!indexed.value) throw new Error('timed out waiting for the content index')
  })().catch(error => {
    finders.delete(root)
    try {
      finder.destroy()
    } catch {}
    throw error
  })

  finders.set(root, entry)
  return entry
}

/** Start indexing before the first keystroke so the picker opens warm. */
function warmUp() {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (!root || !extensionContext) return
  try {
    void getFinder(root).ready.catch(() => {})
  } catch {
    // A failed index is reported when the picker is actually opened.
  }
}

async function openPicker() {
  if (openPickerHandle) return

  const root = activeRoot()
  if (!root) {
    vscode.window.showWarningMessage('FFF: open a folder first.')
    return
  }

  const picker = vscode.window.createQuickPick()
  openPickerHandle = picker

  picker.matchOnDescription = false
  picker.matchOnDetail = false
  // Item updates must not yank the list back to the top while paging.
  picker.keepScrollPosition = true
  picker.placeholder = 'Search in files…'
  picker.title = path.basename(root)

  const before = vscode.window.activeTextEditor
  const backdrop = before
    ? { document: before.document, selection: before.selection, viewColumn: before.viewColumn }
    : undefined

  const makeButton = (id, tooltip, checked) => ({
    iconPath: new vscode.ThemeIcon(id),
    tooltip,
    // Inside the input box, with the checked state rendered by QuickPick itself.
    location: vscode.QuickInputButtonLocation.Input,
    toggle: { checked },
  })

  let smartCase = config().get('smartCase')
  let buttons
  const renderButtons = () => {
    buttons = {
      regex: makeButton('regex', 'Match with a regular expression', toggles.regex),
      case: makeButton('case-sensitive', 'Match case (smart case is on while the query is lowercase)', smartCase),
      grouped: makeButton('list-filter', 'Collapse results to one row per file', toggles.grouped),
    }
    picker.buttons = [buttons.regex, buttons.case, buttons.grouped]
  }
  renderButtons()

  const seeded = config().get('seedFromSelection') ? selectedText() : ''
  picker.value = seeded || lastQuery

  /** @type {{ finder: any, ready: Promise<void> } | undefined} */
  let entry
  let timer
  let progressTimer
  let disposed = false
  let accepted = false
  let previewKey = ''

  const state = {
    query: '',
    matches: [],
    cursor: null,
    fuzzy: false,
    regexError: undefined,
    ms: 0,
    more: null,
  }

  const plural = (count, word) => `${count} ${count === 1 ? word : `${word}s`}`

  const renderPrompt = () => {
    const files = new Set(state.matches.map(match => match.relativePath)).size
    picker.prompt = [
      state.fuzzy ? 'fuzzy' : '',
      plural(files, 'file'),
      plural(state.matches.length, 'match'),
      state.cursor ? 'truncated' : '',
      state.regexError ? `invalid regex, matched literally: ${state.regexError}` : '',
      `${state.ms.toFixed(0)} ms`,
    ]
      .filter(Boolean)
      .join(' · ')
  }

  const render = (moreItem) => {
    const items = toItems(root, state.matches)
    if (state.cursor) {
      state.more = {
        alwaysShow: true,
        label: '$(ellipsis) Load more…',
        description: `${state.matches.length} loaded`,
        more: true,
      }
      items.push(state.more)
    } else {
      state.more = null
    }
    picker.items = items
    if (moreItem && state.more) picker.activeItems = [state.more]
  }

  /** Keep the hit visible while a long line is cut down to a label. */
  const showHistory = () => {
    if (disposed || picker.busy) return
    const items = []
    const finder = entry?.finder
    if (finder && config().get('persistFrecency')) {
      for (let offset = 0; offset < 6; offset++) {
        const history = finder.getHistoricalQuery(offset)
        if (!history.ok || !history.value) break
        items.push({
          alwaysShow: true,
          label: `$(history) ${history.value}`,
          description: 'recent search',
          query: history.value,
        })
      }
    }
    if (!items.length) {
      items.push({ alwaysShow: true, label: `$(search) Search all files in ${path.basename(root)}` })
    }
    picker.items = items
    picker.prompt = undefined
  }

  /** One search pass. The fuzzy retry only runs when the literal pass was cheap. */
  const searchPage = (query, cursor, forceFuzzy) => {
    const budget = config().get('timeBudgetMs')
    const started = performance.now()
    const mode = toggles.regex ? 'regex' : 'plain'

    const run = (nextMode, nextBudget) => entry.finder.grep(query, searchOptions(nextMode, smartCase, nextBudget, cursor))

    if (forceFuzzy) {
      const fuzzy = run('fuzzy', budget)
      if (!fuzzy.ok) return { error: fuzzy.error }
      return { page: fuzzy.value, mode: 'fuzzy', fuzzy: true, ms: performance.now() - started }
    }

    const first = run(mode, budget)
    if (!first.ok) return { error: first.error }

    const elapsed = performance.now() - started
    if (
      !cursor &&
      first.value.items.length === 0 &&
      !toggles.regex &&
      config().get('fuzzyFallback') &&
      query.length >= 3 &&
      // A literal pass that burned its budget proved nothing; retrying fuzzy on
      // top would just double the blocked time without better results.
      elapsed < budget * 0.6
    ) {
      const fuzzy = run('fuzzy', Math.max(40, budget - elapsed))
      if (fuzzy.ok && fuzzy.value.items.length > 0) {
        return { page: fuzzy.value, mode: 'fuzzy', fuzzy: true, ms: performance.now() - started }
      }
    }

    return { page: first.value, mode, ms: performance.now() - started }
  }

  const run = (raw, options = {}) => {
    const query = raw.trim()
    if (!query) {
      state.query = ''
      state.matches = []
      state.cursor = null
      state.more = null
      showHistory()
      return
    }
    if (!entry) {
      picker.items = []
      picker.prompt = 'Building index…'
      return
    }

    const outcome = searchPage(query, null, options.forceFuzzy)
    if (outcome.error) {
      picker.items = []
      picker.prompt = `Search failed: ${outcome.error}`
      return
    }

    state.query = query
    state.matches = outcome.page.items
    state.cursor = outcome.page.nextCursor ? { page: outcome.page.nextCursor, mode: outcome.mode } : null
    state.fuzzy = Boolean(outcome.fuzzy)
    state.regexError = outcome.page.regexFallbackError
    state.ms = outcome.ms
    render()
    renderPrompt()
    if (!state.matches.length && !options.forceFuzzy && canRetryAsFuzzy(query, outcome)) {
      picker.items = [
        {
          alwaysShow: true,
          label: '$(search) No matches — press Enter to retry with fuzzy matching',
          retryFuzzy: true,
        },
      ]
    }
    lastQuery = raw
  }

  const canRetryAsFuzzy = (query, outcome) =>
    !toggles.regex && !outcome.fuzzy && config().get('fuzzyFallback') && query.length >= 2

  const loadMore = () => {
    if (!entry || !state.cursor) return
    const outcome = (() => {
      const started = performance.now()
      const page = entry.finder.grep(
        state.query,
        searchOptions(state.cursor.mode, smartCase, config().get('timeBudgetMs'), state.cursor.page),
      )
      if (!page.ok) return { error: page.error }
      return { page: page.value, ms: performance.now() - started }
    })()
    if (outcome.error) {
      picker.prompt = `Search failed: ${outcome.error}`
      return
    }
    state.matches = state.matches.concat(outcome.page.items)
    state.cursor = outcome.page.nextCursor ? { page: outcome.page.nextCursor, mode: state.cursor.mode } : null
    state.ms += outcome.ms
    render(true)
    renderPrompt()
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => run(picker.value), 60)
  }

  const describeProgress = () => {
    // Once a query is in flight the prompt belongs to the result counts.
    if (state.query) return
    if (!entry) {
      picker.prompt = 'Building index…'
      return
    }
    const progress = entry.finder.getScanProgress()
    if (!progress.ok) return
    const { scannedFilesCount, isScanning, isWarmupComplete } = progress.value
    if (isScanning) picker.prompt = `Indexing… ${scannedFilesCount.toLocaleString()} files`
    else if (!isWarmupComplete) picker.prompt = `Indexing contents… ${scannedFilesCount.toLocaleString()} files`
    else picker.prompt = 'Building index…'
  }

  const cancelPreview = () => {
    if (!config().get('restoreEditorOnDismiss') || !backdrop || backdrop.document.isClosed) return
    void vscode.window
      .showTextDocument(backdrop.document, { preview: false, preserveFocus: false, viewColumn: backdrop.viewColumn })
      .then(
        editor => {
          editor.selection = backdrop.selection
          editor.revealRange(backdrop.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
        },
        () => {},
      )
  }

  picker.onDidChangeValue(schedule)
  picker.onDidTriggerButton(button => {
    if (button === buttons.regex) toggles.regex = !toggles.regex
    else if (button === buttons.case) smartCase = !smartCase
    else if (button === buttons.grouped) {
      toggles.grouped = !toggles.grouped
      renderButtons()
      // Re-grouping is a rendering change, no need to search again.
      if (state.query) {
        render()
        renderPrompt()
      }
      return
    }
    renderButtons()
    if (picker.value.trim()) run(picker.value)
  })
  picker.onDidChangeActive(items => {
    const match = items[0]?.match
    if (!match || !config().get('preview')) return
    const key = `${match.relativePath}:${match.lineNumber}:${match.matchRanges?.[0]?.[0] ?? 0}`
    // Every items update re-focuses the first row; without this the editor is
    // re-opened on each keystroke even when the preview did not move.
    if (key === previewKey) return
    previewKey = key
    void reveal(root, match, { preserveFocus: true, warnIfStale: false })
  })
  picker.onDidAccept(() => {
    const item = picker.selectedItems[0]
    if (!item) return

    if (item.query !== undefined) {
      picker.value = item.query
      clearTimeout(timer)
      timer = setTimeout(() => run(picker.value), 0)
      return
    }

    if (item.more) {
      loadMore()
      return
    }

    if (item.retryFuzzy) {
      run(picker.value, { forceFuzzy: true })
      return
    }

    if (!item.match) return
    accepted = true
    if (config().get('persistFrecency')) {
      // fff canonicalizes the path, so a relative one fails outside the workspace cwd.
      entry?.finder.trackQuery(picker.value.trim(), path.join(root, item.match.relativePath))
    }
    void reveal(root, item.match, { preserveFocus: false, warnIfStale: true })
    picker.hide()
  })
  picker.onDidTriggerItemButton(({ item, button }) => {
    if (!item.match) return
    if (button === BUTTON_COPY) {
      void vscode.env.clipboard.writeText(item.match.relativePath)
      return
    }
    accepted = true
    void reveal(root, item.match, {
      preserveFocus: false,
      warnIfStale: true,
      viewColumn: vscode.ViewColumn.Beside,
    })
    picker.hide()
  })
  picker.onDidHide(() => {
    disposed = true
    clearTimeout(timer)
    clearInterval(progressTimer)
    if (!accepted) cancelPreview()
    openPickerHandle = undefined
    picker.dispose()
  })

  picker.show()

  try {
    entry = getFinder(root)
  } catch (error) {
    picker.hide()
    vscode.window.showErrorMessage(`FFF: failed to build the index: ${error.message}`)
    return
  }

  picker.busy = true
  describeProgress()
  progressTimer = setInterval(describeProgress, 150)

  entry.ready.then(
    () => {
      if (disposed) return
      clearInterval(progressTimer)
      picker.busy = false
      if (picker.value.trim()) run(picker.value)
      else showHistory()
    },
    error => {
      if (disposed) return
      picker.hide()
      vscode.window.showErrorMessage(`FFF: failed to build the index: ${error.message}`)
    },
  )
}

function activate(context) {
  extensionContext = context
  context.subscriptions.push(vscode.commands.registerCommand('fffSearch.open', openPicker))
  if (config().get('eagerIndex')) warmUp()
}

async function deactivate() {
  for (const { finder } of finders.values()) {
    try {
      finder.destroy()
    } catch {
      // The index never came up, so there is nothing to release.
    }
  }
  finders.clear()
}

module.exports = { activate, deactivate }
