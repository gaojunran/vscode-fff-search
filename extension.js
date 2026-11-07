const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

/** One resident index per workspace folder: { finder, ready }. */
const finders = new Map()

/** Picker toggles, kept for the window's lifetime. */
const toggles = { regex: false, grouped: false }

/** Last query typed, so an empty picker reopens where the user left off. */
let lastQuery = ''
let extensionContext
let openPickerHandle

/** How long the list must stay still before the hit behind it is previewed. */
const PREVIEW_DELAY_MS = 110

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

/** Options for one grep pass. `classify` annotates hits, it never filters them. */
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
    ...(config().get('definitionsFirst') ? { classifyDefinitions: 'classify' } : {}),
    beforeContext: 0,
    afterContext: 0,
    ...(cursor ? { cursor } : {}),
  }
}

/**
 * Definitions first, everything else in fff's order. Array#sort is stable, so
 * this is a partition and the frecency ranking inside each half survives.
 * Grouped mode keeps file order: hoisting would tear its headers apart.
 */
function orderMatches(matches) {
  if (toggles.grouped) return matches
  return [...matches].sort((a, b) => Number(Boolean(b.isDefinition)) - Number(Boolean(a.isDefinition)))
}

/** A leading glyph so a row lifted to the top explains itself. */
const definitionPrefix = match => (match.isDefinition ? '$(symbol-misc) ' : '')

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
const BUTTON_PREVIEW = { iconPath: new vscode.ThemeIcon('eye'), tooltip: 'Preview without leaving the search' }
const BUTTON_SIDE = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open to the side' }
const itemButtons = [BUTTON_PREVIEW, BUTTON_SIDE]

function toItem(root, match) {
  return {
    // Results are already ranked and filtered by fff. alwaysShow stops QuickPick
    // from filtering them again by label, which would hide fuzzy matches because
    // their lines do not contain the literal query.
    alwaysShow: true,
    label: definitionPrefix(match) + cropLine(match.lineContent, match.matchRanges),
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
  if (!toggles.grouped) return orderMatches(matches).map(match => toItem(root, match))

  // One row per match, with the file path as a header above its first match.
  // A QuickPick separator without buttons is not a row of its own: the list
  // renders its label inside the row that follows, which is exactly the
  // "file header, then matches" shape the search view has.
  const groups = new Map()
  for (const match of matches) {
    const group = groups.get(match.relativePath)
    if (group) group.push(match)
    else groups.set(match.relativePath, [match])
  }

  const items = []
  for (const [relativePath, group] of groups) {
    items.push({ kind: vscode.QuickPickItemKind.Separator, label: relativePath })
    for (const match of group) {
      items.push({
        alwaysShow: true,
        label: definitionPrefix(match) + cropLine(match.lineContent, match.matchRanges),
        // Path is in the header now, so the second column carries the line.
        description: `${match.lineNumber}`,
        buttons: itemButtons,
        match,
      })
    }
  }
  return items
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

/**
 * The picker's list is capped at 40% of the window height and starts at the
 * title bar, so its bottom edge lands near the vertical middle — exactly where
 * InCenterIfOutsideViewport would put the previewed hit. Ending the revealed
 * range at the hit pushes it into the lower third instead, and a hit already
 * visible down there is left alone.
 */
function revealSelection(editor, line, selection, keepClear) {
  const visible = keepClear ? editor.visibleRanges?.[0] : undefined
  const span = visible ? visible.end.line - visible.start.line : 0
  const lead = Math.round(span * 0.3)
  if (lead > 0 && line - lead >= 0) {
    editor.revealRange(
      new vscode.Range(line - lead, 0, line, 0),
      vscode.TextEditorRevealType.InCenterIfOutsideViewport,
    )
    return
  }
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

async function reveal(root, match, options) {
  const uri = fileUri(root, match.relativePath)
  // Reusing the editor we opened for the previous preview avoids re-opening a
  // document per keystroke; only the selection and scroll position change.
  const reusable = Boolean(
    options.reuseFrom?.editor &&
      options.reuseFrom.uri === uri.toString() &&
      !options.reuseFrom.editor.document.isClosed &&
      vscode.window.visibleTextEditors.includes(options.reuseFrom.editor),
  )

  let document
  let editor
  try {
    if (reusable) {
      document = options.reuseFrom.editor.document
      editor = options.reuseFrom.editor
    } else {
      document = await vscode.workspace.openTextDocument(uri)
      editor = await vscode.window.showTextDocument(document, {
        preview: true,
        preserveFocus: options.preserveFocus,
        ...(options.viewColumn ? { viewColumn: options.viewColumn } : {}),
      })
      if (options.reuseFrom) Object.assign(options.reuseFrom, { uri: uri.toString(), editor })
    }
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
  revealSelection(editor, line, selection, options.keepClear)
}

// search.exclude + files.exclude entries that are switched on, passed to the
// index as gitignore rules. VS Code stores globs, which zlob accepts as-is.
function excludePatterns() {
  if (!config().get('useExcludeSettings')) return []
  const enabled = section => {
    const exclude = vscode.workspace.getConfiguration(section).get('exclude') || {}
    return Object.keys(exclude).filter(pattern => exclude[pattern] === true)
  }
  return enabled('search').concat(enabled('files'))
}

function createFinder(root) {
  const { FileFinder } = require('@ff-labs/fff-node')
  const options = { basePath: root }
  const ignore = excludePatterns()
  if (ignore.length) options.extraIgnore = ignore

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
    // A rebuild may already have replaced this entry.
    if (finders.get(root) === entry) finders.delete(root)
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

/** Exclude rules are baked into the index, so a change means building it again. */
function resetFinders() {
  openPickerHandle?.hide()
  for (const entry of finders.values()) {
    try {
      entry.finder.destroy()
    } catch {}
  }
  finders.clear()
  warmUp()
}

async function openPicker() {
  // The shortcut toggles: a second press closes the picker it opened.
  if (openPickerHandle) {
    openPickerHandle.hide()
    return
  }

  const root = activeRoot()
  if (!root) {
    vscode.window.showWarningMessage('FFF: open a folder first.')
    return
  }

  const picker = vscode.window.createQuickPick()
  openPickerHandle = picker

  picker.matchOnDescription = false
  picker.matchOnDetail = false
  // Undocumented but real (QuickPick#sortByLabel): it defaults to true, which
  // makes the list sort by label match score and silently drop separators while
  // a query is present. Turning it off keeps fff's frecency order and lets the
  // per-file headers in grouped mode survive. Setting it is a no-op if a future
  // version drops the property; grouped mode then falls back to plain rows.
  picker.sortByLabel = false
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
      case: makeButton('case-sensitive', 'Smart case: ignore case unless the query has an uppercase letter', smartCase),
      grouped: makeButton('list-filter', 'Group matches under their file', toggles.grouped),
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
  let previewPending = ''
  // The preview is delayed so a burst of keystrokes does not open a document per
  // keystroke; it only runs once typing pauses.
  let previewTimer
  const previewReuse = { uri: '', editor: undefined }

  const state = {
    query: '',
    ok: false,
    matches: [],
    cursor: null,
    fuzzy: false,
    regexError: undefined,
    ms: 0,
    more: null,
  }

  const plural = (count, singular, many) => `${count} ${count === 1 ? singular : many}`

  const renderPrompt = () => {
    const files = new Set(state.matches.map(match => match.relativePath)).size
    picker.prompt = [
      state.fuzzy ? 'fuzzy' : '',
      plural(files, 'file', 'files'),
      plural(state.matches.length, 'match', 'matches'),
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
      // In grouped mode the row would otherwise read as one more hit of the last
      // file, so give it a header of its own.
      if (toggles.grouped) {
        items.push({ kind: vscode.QuickPickItemKind.Separator, label: `${state.matches.length} loaded` })
      }
      state.more = {
        alwaysShow: true,
        label: '$(ellipsis) Load more…',
        ...(toggles.grouped ? {} : { description: `${state.matches.length} loaded` }),
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

  /** One search pass; in 'auto' mode a cheap zero-hit literal pass retries fuzzy. */
  const searchPage = (query, cursor, forceFuzzy) => {
    const budget = config().get('timeBudgetMs')
    const started = performance.now()
    const run = mode => entry.finder.grep(query, searchOptions(mode, smartCase, budget, cursor))

    const mode = forceFuzzy ? 'fuzzy' : toggles.regex ? 'regex' : 'plain'
    const first = run(mode)
    if (!first.ok) return { error: first.error }
    const elapsed = performance.now() - started

    // Fuzzy ranks by distance rather than containment, so it is only a rescue
    // for a literal pass that found nothing — and only a cheap one, otherwise
    // the keystroke would block for twice the budget.
    const autoRetry =
      mode === 'plain' &&
      !cursor &&
      config().get('fuzzy') === 'auto' &&
      first.value.items.length === 0 &&
      query.length >= 3 &&
      elapsed < budget * 0.6
    if (!autoRetry) return { page: first.value, mode, fuzzy: mode === 'fuzzy', ms: elapsed }

    const fuzzy = run('fuzzy')
    if (fuzzy.ok && fuzzy.value.items.length > 0) {
      return { page: fuzzy.value, mode: 'fuzzy', fuzzy: true, ms: performance.now() - started }
    }
    return { page: first.value, mode, fuzzy: false, ms: performance.now() - started }
  }

  const run = (raw, options = {}) => {
    const query = raw.trim()
    if (!query) {
      state.query = ''
      state.matches = []
      state.cursor = null
      state.more = null
      state.ok = false
      showHistory()
      return
    }
    if (!entry) {
      picker.items = []
      picker.prompt = 'Building index…'
      return
    }
    // Trimming can leave the query unchanged (a trailing space), and the visible
    // results already belong to it.
    if (state.ok && query === state.query && !options.force && !options.forceFuzzy) return

    const outcome = searchPage(query, null, options.forceFuzzy)
    if (outcome.error) {
      state.ok = false
      picker.items = []
      picker.prompt = `Search failed: ${outcome.error}`
      return
    }

    state.ok = true
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
    !toggles.regex && !outcome.fuzzy && config().get('fuzzy') !== 'off' && query.length >= 2

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
    // A pending preview belongs to the results the user is typing over, unless
    // the trimmed query did not change and the results stay as they are.
    if (picker.value.trim() !== state.query) {
      clearTimeout(previewTimer)
      previewTimer = undefined
      previewPending = ''
    }
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
    if (picker.value.trim()) run(picker.value, { force: true })
  })
  picker.onDidChangeActive(items => {
    const match = items[0]?.match
    if (!match || !config().get('preview')) return
    previewAt(match, false)
  })

  /**
   * Opens the hit behind the picker without touching focus. Guarded so that an
   * items update, which re-focuses the first row, does not re-open the file, and
   * delayed so that typing does not pay for a preview per keystroke.
   */
  const previewAt = (match, warnIfStale) => {
    const key = `${match.relativePath}:${match.lineNumber}:${match.matchRanges?.[0]?.[0] ?? 0}`
    if (key === previewKey || key === previewPending) return
    previewPending = key
    clearTimeout(previewTimer)
    previewTimer = setTimeout(() => {
      previewTimer = undefined
      previewPending = ''
      previewKey = key
      void reveal(root, match, {
        preserveFocus: true,
        warnIfStale,
        keepClear: true,
        reuseFrom: previewReuse,
      })
    }, PREVIEW_DELAY_MS)
  }
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
    // A row button is a separate channel from accept, so it never jumps away:
    // the preview stays behind an open picker.
    if (button === BUTTON_PREVIEW) {
      previewAt(item.match, true)
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
    clearTimeout(previewTimer)
    clearInterval(progressTimer)
    previewReuse.uri = ''
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
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(event => {
      const touched = ['fffSearch.useExcludeSettings', 'search.exclude', 'files.exclude']
      if (touched.some(key => event.affectsConfiguration(key))) resetFinders()
    }),
  )
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
