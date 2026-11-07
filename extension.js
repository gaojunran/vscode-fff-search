const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')
const { FinderClient } = require('./finder-client')

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

/** Fetch the next page once the cursor is this close to the end of the list. */
const PREFETCH_DISTANCE = 10

/** Let startup settle before indexing; typing postpones it up to the cap. */
const WARMUP_DELAY_MS = 2000
const WARMUP_CAP_MS = 30000

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

/**
 * fff's fuzzy matcher stops as soon as the line stops matching, so `couponpkg`
 * also returns rows that only matched `couponp`. Keep the rows that matched the
 * whole query, and fall back to all of them when none did.
 */
function completeFuzzy(page, query) {
  const kept = page.items.filter(match => coveredChars(match) >= query.length)
  return kept.length ? { ...page, items: kept } : page
}

function coveredChars(match) {
  const bytes = Buffer.from(match.lineContent, 'utf8')
  const at = offset => bytes.subarray(0, Math.min(offset, bytes.length)).toString('utf8').length
  return (match.matchRanges ?? []).reduce((sum, [start, end]) => sum + at(end) - at(start), 0)
}

/** Options for one grep pass. `classify` annotates hits, it never filters them. */function searchOptions(mode, smartCase, timeBudgetMs, cursor) {
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

const CROP_WIDTH = 110
const CROP_LEAD = 40
const CROP_TRAIL = 70
const UNDERLINE = '\u0332'

/** The slice of `text` a row shows, kept around the first hit. */
function cropWindow(text, hit) {
  const trimmed = text.trim()
  if (trimmed.length <= CROP_WIDTH) {
    const from = text.indexOf(trimmed)
    return { from, to: from + trimmed.length, prefix: false, suffix: false }
  }
  const head = Math.max(0, hit - CROP_LEAD)
  const tail = Math.min(text.length, hit + CROP_TRAIL)
  const slice = text.slice(head, tail)
  const kept = slice.trim()
  const from = head + slice.indexOf(kept)
  return { from, to: from + kept.length, prefix: head > 0, suffix: tail < text.length }
}

/**
 * fff reports the fragments a fuzzy match landed on, but QuickPick has no
 * highlight API and VS Code's own matcher only finds literal substrings. Marking
 * the characters with a combining low line is the only way to show them.
 */
function underlineFragments(text, ranges, window) {
  const marks = new Set()
  for (const range of ranges) {
    const [start, end] = charRange(text, range)
    for (let i = Math.max(start, window.from); i < Math.min(end, window.to); i++) marks.add(i)
  }
  let out = ''
  for (let i = window.from; i < window.to; i++) {
    out += text[i]
    if (marks.has(i)) out += UNDERLINE
  }
  return out
}

/** Keep the hit visible when a long line is cut down to a label. */
function cropLine(text, ranges, fuzzy) {
  if (!text.trim()) return '\u00a0'
  const hit = ranges?.length ? charRange(text, ranges[0])[0] : 0
  const window = cropWindow(text, hit)
  if (window.to <= window.from) return text.trim().slice(0, CROP_WIDTH)
  const body = fuzzy ? underlineFragments(text, ranges ?? [], window) : text.slice(window.from, window.to)
  return `${window.prefix ? '…' : ''}${body}${window.suffix ? '…' : ''}`
}

/** Per-result buttons; only rendered because the picker comes from createQuickPick. */
const BUTTON_PREVIEW = { iconPath: new vscode.ThemeIcon('eye'), tooltip: 'Preview without leaving the search' }
const BUTTON_SIDE = { iconPath: new vscode.ThemeIcon('go-to-file'), tooltip: 'Open to the side' }
const itemButtons = [BUTTON_PREVIEW, BUTTON_SIDE]

function toItem(root, match, fuzzy) {
  return {
    // Results are already ranked and filtered by fff. alwaysShow stops QuickPick
    // from filtering them again by label, which would hide fuzzy matches because
    // their lines do not contain the literal query.
    alwaysShow: true,
    label: definitionPrefix(match) + cropLine(match.lineContent, match.matchRanges, fuzzy),
    description: `${match.fileName}:${match.lineNumber}`,
    detail: match.relativePath,
    // Derives the file-type icon from the active icon theme.
    resourceUri: fileUri(root, match.relativePath),
    iconPath: vscode.ThemeIcon.File,
    buttons: itemButtons,
    match,
  }
}

function toItems(root, matches, fuzzy) {
  if (!toggles.grouped) return orderMatches(matches).map(match => toItem(root, match, fuzzy))

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
        label: definitionPrefix(match) + cropLine(match.lineContent, match.matchRanges, fuzzy),
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

  return new FinderClient(options)
}

/** Returns { finder, ready } immediately so the picker can show scan progress. */
function getFinder(root) {
  const cached = finders.get(root)
  if (cached) return cached

  const finder = createFinder(root)
  const entry = { finder, ready: null }
  entry.ready = (async () => {
    await finder.ready
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
    const items = toItems(root, state.matches, state.fuzzy)
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
  const showHistory = async () => {
    if (disposed || picker.busy) return
    const items = []
    const finder = entry?.finder
    if (finder && config().get('persistFrecency')) {
      for (let offset = 0; offset < 6; offset++) {
        const history = await finder.getHistoricalQuery(offset)
        if (disposed) return
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
  const searchPage = async (query, cursor, forceFuzzy) => {
    const budget = config().get('timeBudgetMs')
    const started = performance.now()
    const pass = mode => entry.finder.grep(query, searchOptions(mode, smartCase, budget, cursor))

    const mode = forceFuzzy ? 'fuzzy' : toggles.regex ? 'regex' : 'plain'
    const first = await pass(mode)
    if (!first.ok) return { error: first.error }
    const elapsed = performance.now() - started

    // Fuzzy ranks by distance rather than containment, so it is only a rescue
    // for a literal pass that found nothing — and only a cheap one, otherwise
    // the keystroke would pay for two passes.
    const autoRetry =
      mode === 'plain' &&
      !cursor &&
      config().get('fuzzy') === 'auto' &&
      first.value.items.length === 0 &&
      query.length >= 3 &&
      elapsed < budget * 0.6
    if (!autoRetry) return { page: first.value, mode, fuzzy: mode === 'fuzzy', ms: elapsed }

    const fuzzy = await pass('fuzzy')
    if (fuzzy.ok && fuzzy.value.items.length > 0) {
      return {
        page: completeFuzzy(fuzzy.value, query),
        mode: 'fuzzy',
        fuzzy: true,
        ms: performance.now() - started,
      }
    }
    return { page: first.value, mode, fuzzy: false, ms: performance.now() - started }
  }

  let runId = 0

  const run = async (raw, options = {}) => {
    const query = raw.trim()
    if (!query) {
      runId++
      state.query = ''
      state.matches = []
      state.cursor = null
      state.more = null
      state.ok = false
      await showHistory()
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

    const id = ++runId
    const outcome = await searchPage(query, null, options.forceFuzzy)
    // A newer keystroke owns the picker now, or it was closed while waiting.
    if (id !== runId || disposed) return
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

  let loadingMore = false
  let prefetchKey = ''

  const loadMore = async (focusMore = false) => {
    if (!entry || !state.cursor || loadingMore) return
    const cursor = state.cursor
    const active = picker.activeItems[0]?.match
    loadingMore = true
    try {
      const started = performance.now()
      const page = await entry.finder.grep(
        state.query,
        searchOptions(cursor.mode, smartCase, config().get('timeBudgetMs'), cursor.page),
      )
      if (disposed) return
      if (!page.ok) {
        picker.prompt = `Search failed: ${page.error}`
        return
      }
      state.matches = state.matches.concat(
        cursor.mode === 'fuzzy' ? completeFuzzy(page.value, state.query).items : page.value.items,
      )
      state.cursor = page.value.nextCursor ? { page: page.value.nextCursor, mode: cursor.mode } : null
      state.ms += performance.now() - started
      render(focusMore)
      // Replacing the list drops its focus, so a prefetch puts the cursor back on
      // the row the user was reading.
      if (!focusMore && active) {
        const item = picker.items.find(candidate => candidate.match === active)
        if (item) picker.activeItems = [item]
      }
      renderPrompt()
    } finally {
      loadingMore = false
    }
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
    timer = setTimeout(() => void run(picker.value), 60)
  }

  let progressInFlight = false
  const describeProgress = async () => {
    // Once a query is in flight the prompt belongs to the result counts.
    if (state.query || progressInFlight) return
    if (!entry) {
      picker.prompt = 'Building index…'
      return
    }
    progressInFlight = true
    try {
      const progress = await entry.finder.getScanProgress()
      if (disposed || !progress.ok) return
      const { scannedFilesCount, isScanning, isWarmupComplete } = progress.value
      if (isScanning) picker.prompt = `Indexing… ${scannedFilesCount.toLocaleString()} files`
      else if (!isWarmupComplete) picker.prompt = `Indexing contents… ${scannedFilesCount.toLocaleString()} files`
      else picker.prompt = 'Building index…'
    } finally {
      progressInFlight = false
    }
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
    if (picker.value.trim()) void run(picker.value, { force: true })
  })
  picker.onDidChangeActive(items => {
    const match = items[0]?.match
    if (!match) return
    // QuickPick exposes no scroll event, so the next page is fetched when the
    // active row gets close to the end instead.
    if (state.cursor && !loadingMore && picker.items.length >= PREFETCH_DISTANCE) {
      const index = picker.items.indexOf(items[0])
      const key = `${match.relativePath}:${match.lineNumber}`
      if (index >= picker.items.length - PREFETCH_DISTANCE && key !== prefetchKey) {
        prefetchKey = key
        void loadMore()
      }
    }
    if (config().get('preview')) previewAt(match, false)
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
      timer = setTimeout(() => void run(picker.value), 0)
      return
    }

    if (item.more) {
      void loadMore()
      return
    }

    if (item.retryFuzzy) {
      void run(picker.value, { forceFuzzy: true })
      return
    }

    if (!item.match) return
    accepted = true
    if (config().get('persistFrecency')) {
      // fff canonicalizes the path, so a relative one fails outside the workspace cwd.
      void entry?.finder
        .trackQuery(picker.value.trim(), path.join(root, item.match.relativePath))
        .catch(() => {})
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
  void describeProgress()
  progressTimer = setInterval(() => void describeProgress(), 150)

  entry.ready.then(
    () => {
      if (disposed) return
      clearInterval(progressTimer)
      picker.busy = false
      if (picker.value.trim()) void run(picker.value)
      else void showHistory()
    },
    error => {
      if (disposed) return
      picker.hide()
      vscode.window.showErrorMessage(`FFF: failed to build the index: ${error.message}`)
    },
  )
}

/** Index once the window is quiet, so startup is not competing with it. */
function scheduleWarmUp(context) {
  if (!config().get('eagerIndex')) return
  let timer
  const defer = () => {
    clearTimeout(timer)
    timer = setTimeout(warmUp, WARMUP_DELAY_MS)
  }
  defer()
  // Typing keeps postponing it, but it must not wait forever.
  const cap = setTimeout(warmUp, WARMUP_CAP_MS)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(defer),
    vscode.window.onDidChangeWindowState(state => {
      if (!state.focused) warmUp()
    }),
    {
      dispose() {
        clearTimeout(timer)
        clearTimeout(cap)
      },
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
  scheduleWarmUp(context)
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
