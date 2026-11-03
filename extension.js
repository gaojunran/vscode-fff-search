const fs = require('node:fs')
const path = require('node:path')
const vscode = require('vscode')

/** One resident index per workspace folder, keyed by folder path. */
const finders = new Map()

/** Picker toggles, kept for the window's lifetime. */
const toggles = { regex: false, grouped: false }

/** Kept so an empty picker reopens with the previous query. */
let lastQuery = ''
let extensionContext

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

function getFinder(root) {
  const cached = finders.get(root)
  if (cached) return cached

  const pending = (async () => {
    const { FileFinder } = require('@ff-labs/fff-node')
    const options = { basePath: root }

    if (config().get('persistFrecency')) {
      const dir = extensionContext.globalStorageUri.fsPath
      fs.mkdirSync(dir, { recursive: true })
      options.frecencyDbPath = path.join(dir, 'frecency.db')
      options.historyDbPath = path.join(dir, 'history.db')
    }

    const created = FileFinder.create(options)
    if (!created.ok) throw new Error(created.error)

    const finder = created.value
    const scanned = await finder.waitForScan(60_000)
    if (!scanned.ok) throw new Error(scanned.error)

    // grep returns nothing until the content index is built, so waiting for the
    // file scan alone is not enough.
    const indexed = await finder.waitForIndexReady(120_000)
    if (!indexed.ok) throw new Error(indexed.error)
    return finder
  })()

  finders.set(root, pending)
  pending.catch(() => finders.delete(root))
  return pending
}

function toItem(match) {
  return {
    // Results are already ranked and filtered by fff. alwaysShow stops QuickPick
    // from filtering them again by label, which would hide fuzzy matches because
    // their lines do not contain the literal query.
    alwaysShow: true,
    label: match.lineContent.trim() || '\u00a0',
    description: `${match.fileName}:${match.lineNumber}`,
    detail: match.relativePath,
    match,
  }
}

function toItems(matches) {
  if (!toggles.grouped) return matches.map(toItem)

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
    detail: match.lineContent.trim() || '\u00a0',
    match,
  }))
}

async function reveal(root, item, preserveFocus) {
  const { match } = item
  const uri = vscode.Uri.joinPath(vscode.Uri.file(root), match.relativePath)

  let document
  let editor
  try {
    document = await vscode.workspace.openTextDocument(uri)
    editor = await vscode.window.showTextDocument(document, { preview: true, preserveFocus })
  } catch {
    // The file may have been deleted or renamed while the picker was open.
    return
  }

  const line = Math.min(Math.max(match.lineNumber - 1, 0), document.lineCount - 1)
  const text = document.lineAt(line).text

  // fff reports UTF-8 byte offsets; VS Code works in UTF-16 code units.
  const bytes = Buffer.from(text, 'utf8')
  const charIndex = offset => bytes.subarray(0, Math.min(offset, bytes.length)).toString('utf8').length
  const [from = match.col, to = from] = match.matchRanges?.[0] ?? []

  const selection = new vscode.Selection(line, charIndex(from), line, charIndex(to))
  editor.selection = selection
  editor.revealRange(selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
}

function search(finder, query) {
  const options = {
    pageSize: config().get('maxResults'),
    maxMatchesPerFile: config().get('maxMatchesPerFile'),
    maxFileSize: config().get('maxFileSizeMb') * 1024 * 1024,
    smartCase: config().get('smartCase'),
    // grep is a synchronous FFI call that blocks the extension host, so it needs
    // a ceiling. A zero-match query scans every candidate file by default.
    timeBudgetMs: config().get('timeBudgetMs'),
    enforceTimeBudget: true,
    beforeContext: 0,
    afterContext: 0,
  }

  const grep = mode => finder.grep(query, { ...options, mode })

  const run = mode => {
    const page = grep(mode)
    if (!page.ok) return { error: page.error }
    return {
      items: page.value.items,
      truncated: Boolean(page.value.nextCursor),
      regexError: page.value.regexFallbackError,
    }
  }

  const literal = run(toggles.regex ? 'regex' : 'plain')
  if (literal.error || literal.items.length > 0 || toggles.regex) return literal
  if (!config().get('fuzzyFallback') || query.length < 3) return literal

  // Same fallback fff's own MCP server uses: typo-tolerant retry on zero hits.
  const fuzzy = run('fuzzy')
  return fuzzy.error || fuzzy.items.length === 0 ? literal : { ...fuzzy, fuzzy: true }
}

async function openPicker() {
  const root = activeRoot()
  if (!root) {
    vscode.window.showWarningMessage('FFF: open a folder first.')
    return
  }

  const cached = finders.has(root)
  const picker = vscode.window.createQuickPick()
  picker.matchOnDescription = false
  picker.matchOnDetail = false
  picker.placeholder = cached ? 'Search in files…' : 'Building index…'
  picker.enabled = cached
  picker.busy = !cached

  const makeButton = (id, tooltip, checked) => ({
    iconPath: new vscode.ThemeIcon(id),
    tooltip,
    // Inside the input box, with the checked state rendered by QuickPick itself.
    location: vscode.QuickInputButtonLocation.Input,
    toggle: { checked },
  })

  let buttons
  const renderButtons = () => {
    buttons = {
      regex: makeButton('regex', 'Match with a regular expression', toggles.regex),
      grouped: makeButton('list-filter', 'Collapse results to one row per file', toggles.grouped),
    }
    picker.buttons = [buttons.regex, buttons.grouped]
  }
  renderButtons()

  const seeded = config().get('seedFromSelection') ? selectedText() : ''
  picker.value = seeded || lastQuery

  let finder
  let timer
  let disposed = false

  const run = raw => {
    const query = raw.trim()
    if (!query || !finder) {
      picker.items = []
      picker.prompt = ''
      return
    }

    const outcome = search(finder, query)
    if (outcome.error) {
      picker.items = []
      picker.prompt = `Search failed: ${outcome.error}`
      return
    }

    const { items } = outcome
    const files = new Set(items.map(i => i.relativePath)).size
    picker.items = toItems(items)
    picker.prompt = [
      outcome.fuzzy ? 'fuzzy' : '',
      `${files} ${files === 1 ? 'file' : 'files'}`,
      `${items.length} ${items.length === 1 ? 'match' : 'matches'}`,
      outcome.truncated ? 'truncated' : '',
      outcome.regexError ? `invalid regex, matched literally: ${outcome.regexError}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    lastQuery = raw
  }

  const schedule = () => {
    clearTimeout(timer)
    timer = setTimeout(() => run(picker.value), 60)
  }

  picker.onDidChangeValue(schedule)
  picker.onDidTriggerButton(button => {
    if (button === buttons.regex) toggles.regex = !toggles.regex
    else if (button === buttons.grouped) toggles.grouped = !toggles.grouped
    renderButtons()
    if (picker.value.trim()) run(picker.value)
  })
  picker.onDidChangeActive(items => {
    if (config().get('preview') && items[0]?.match) void reveal(root, items[0], true)
  })
  picker.onDidAccept(() => {
    const item = picker.selectedItems[0]
    if (!item?.match) return
    if (config().get('persistFrecency')) {
      // fff canonicalizes the path, so a relative one fails outside the workspace cwd.
      finder?.trackQuery(lastQuery.trim(), path.join(root, item.match.relativePath))
    }
    void reveal(root, item, false)
    picker.hide()
  })
  picker.onDidHide(() => {
    disposed = true
    clearTimeout(timer)
    picker.dispose()
  })

  picker.show()

  try {
    finder = await getFinder(root)
  } catch (err) {
    if (!disposed) picker.hide()
    vscode.window.showErrorMessage(`FFF: failed to build the index: ${err.message}`)
    return
  }

  if (disposed) return
  picker.busy = false
  picker.enabled = true
  picker.placeholder = 'Search in files…'
  if (picker.value.trim()) run(picker.value)
}

function activate(context) {
  extensionContext = context
  context.subscriptions.push(vscode.commands.registerCommand('fffSearch.open', openPicker))
}

async function deactivate() {
  for (const pending of finders.values()) {
    try {
      ;(await pending).destroy()
    } catch {
      // The index never came up, so there is nothing to release.
    }
  }
  finders.clear()
}

module.exports = { activate, deactivate }
