# FFF Search

<img width="959" height="603" alt="Snapzy_Recording_2026-11-03_21-02-56_compressed" src="https://github.com/user-attachments/assets/6af7a55d-6c97-424f-9e0f-ac97fce12838" />

A floating, typo-tolerant search box for VS Code — the shape of `cmd+p`, but searching file *contents*.

Press `cmd+shift+f`, type, watch results appear in milliseconds, and preview each hit in the editor behind the picker. An in-memory index means each keystroke costs a lookup instead of a directory walk.

Powered by [fff](https://github.com/dmtrKovalenko/fff), which keeps a resident in-memory index of the workspace instead of re-walking the tree on every keystroke.

## Why not ripgrep

Extensions that shell out to `rg` on each keystroke pay for a full directory walk and file scan every time (roughly 100 ms on a 11k-file repo, and it grows with the repo). They also inherit the extension host's `PATH` and drop every result if `rg` writes anything to stderr.

Measured with this extension on a 11,277-file TypeScript repo (Apple Silicon):

| | fff (resident index) | `rg` per keystroke |
| --- | ---: | ---: |
| Index build, once per workspace | ~0.8 s | — |
| Query, cold | 105 ms | ~100 ms |
| Query, warm | **2 ms** | ~100 ms |
| Files actually scanned per query | 177 | all |

*Cold* means the files this query needs were not resident in fff's content cache yet; *warm* means they were. `fff` 0.11.0 ships with its mmap warm-up pass commented out upstream, so the first query after indexing is always cold. The content cache is also Unix-only: on Windows every query re-reads from the OS page cache. Neither number is about how long indexing takes, and a CJK query bypasses the bigram prefilter entirely, so it scans every candidate file on every keystroke.

## Features

- `cmd+shift+f` toggles a picker; input stays focused, results update as you type, and a second press closes it
- Literal match with smart case; **fuzzy on zero hits by default** (`fffSearch.fuzzy: auto`), so `requestCouponPkg` still finds `requestCouponPackage`. Set it to `manual` for a "press Enter to retry" row instead, or `off` to disable fuzzy
- Three toggle buttons inside the input box: regular expressions, match case (smart case), and grouping matches under their file
- Grouped view keeps one row per match, with the file path as a header above its first hit — the shape of the Search view, not one row per file
- **Definitions first.** Hits the SDK classifies as a declaration (`function`, `class`, `interface`, `type`, `enum`, `def`, `func`, `const x = () => …`) are lifted above the call sites and marked with a symbol glyph. It is one search pass — the classifier runs on the matched lines — so nothing is re-sorted after the list appears
- Preview: moving through results opens the file behind the picker and selects the match, kept in the lower third of the viewport so the picker does not cover it. The same row is never opened twice, and `esc` puts you back in the editor, cursor and scroll position you came from
- Each row shows the file-type icon, the match cropped around the hit, `file:line`, and the relative path. Row buttons open the result to the side or copy its path
- Paging: the last row is "Load more…", which fetches the next page from fff's cursor instead of re-running the search
- Empty input lists your recent searches from fff's query history
- Seeds the query from the current selection; remembers the last query
- Index is built once per workspace folder and kept fresh by a background watcher; with `eagerIndex` it starts at window open, and the picker shows live indexing progress
- The prompt reports file/match counts, truncation, regex fallback and how long the search took
- Frecency: files opened from the picker feed fff's ranking, persisted across sessions. Label sorting is disabled, so the order you see is fff's, not VS Code's guess at your query

## Install

Not on the Marketplace yet. Build from source:

```bash
git clone https://github.com/gaojunran/vscode-fff-search
cd vscode-fff-search
npm install
npx @vscode/vsce package
code --install-extension fff-search-*.vsix
```

Then reload the window.

## Settings

| Key | Default | |
| --- | --- | --- |
| `fffSearch.maxResults` | `200` | Maximum matches per page |
| `fffSearch.maxMatchesPerFile` | `20` | Matches kept per file, so one huge file cannot fill the list |
| `fffSearch.definitionsFirst` | `true` | Rank lines the SDK classifies as definitions above the rest |
| `fffSearch.smartCase` | `true` | Case-insensitive while the query is lowercase; off means always ignore case |
| `fffSearch.fuzzy` | `auto` | When to search fuzzy: `auto` retries a zero-hit literal pass, `manual` only offers a retry row, `off` disables it |
| `fffSearch.timeBudgetMs` | `150` | Wall-clock budget per search; larger returns more but blocks the picker longer |
| `fffSearch.maxFileSizeMb` | `10` | Files larger than this are skipped |
| `fffSearch.persistFrecency` | `true` | Store frecency and query history in global storage |
| `fffSearch.preview` | `true` | Preview results in the editor behind the picker |
| `fffSearch.restoreEditorOnDismiss` | `true` | Dismissing the picker returns to the editor, cursor and scroll position it was opened from |
| `fffSearch.eagerIndex` | `true` | Start indexing the first workspace folder when the window opens, so the first search is warm. Costs roughly 26 MB per 14k files |
| `fffSearch.seedFromSelection` | `true` | Use the current selection as the query |

Press `esc` to dismiss. `cmd+shift+f` is remapped from the built-in files search; that command is still available from the Command Palette ("Files: Find in Files").

## How it works

The extension is a thin layer between the QuickPick widget and `@ff-labs/fff-node`:

1. **Index lifecycle.** `FileFinder.create()` starts a file scan plus a content index. Both `waitForScan()` and `waitForIndexReady()` must resolve — `grep` silently returns nothing until the content index exists. One index per workspace folder, kept for the window's lifetime and destroyed on deactivate. The picker is shown before the index exists, so it stays interactive: `getScanProgress()` drives an `Indexing… n files` prompt and typing already searches whatever is indexed. With `persistFrecency` on, the frecency and query databases live in the extension's global storage; an unwritable storage directory disables them instead of failing the search.
2. **Search.** `finder.grep()` with `plain` mode and smart case, or `regex` when the regex button is active. Fuzzy is a rescue, not a ranking: it orders by edit distance rather than containment, so `onLaunch` in fuzzy mode returns 201 rows of which 7 contain the word and none of the first five do (measured on an 11k-file repo; 180 ms for a query with few hits against 11 ms literal). `fffSearch.fuzzy` decides when it runs — `auto` (default) retries a zero-hit literal pass, `manual` only offers the retry row, `off` never searches fuzzy — and a fuzzy result is labelled in the prompt. An invalid regex is reported in the prompt and matched literally, which is what fff does internally.
3. **Time budget.** `grep` is a synchronous call across the FFI boundary: it blocks the extension host, and a zero-match query would otherwise scan every candidate file. `timeBudgetMs` bounds one keystroke; the automatic fuzzy retry runs only when the literal pass finished inside 60% of that budget, so a keystroke blocks for at most the budget plus a short rescue. Truncation is reported through `nextCursor`, which also backs the "Load more…" row.
4. **Definitions first.** `classifyDefinitions: 'classify'` asks the engine to tag each matched line as a declared name rather than filtering it, and the rows are then partitioned with a stable sort so fff's order survives inside each half. Grouped mode opts out: hoisting a match would separate it from its file header, so that view keeps file order and only marks the row.
5. **Visibility and ordering.** Every item sets `alwaysShow: true`; without it QuickPick hides fuzzy matches whose lines do not contain the literal query. `sortByLabel` (default `true`) is why the old version re-sorted rows by its own label score. It is missing from `vscode.d.ts`, but it exists on the extension-host QuickPick proxy and is forwarded by the generic `default:` branch of `$createOrUpdateQuickPick`, so setting it to `false` really does reach the list: fff's ranking is what you see. If a future release drops the property, the assignment becomes an inert own property and the extension falls back to VS Code's sorting.
6. **Grouping.** A `QuickPickItemKind.Separator` without buttons is not a row of its own: the list renders its label inside the row that follows (`.quick-input-list-separator`), and drops separators entirely while it sorts. With `sortByLabel` off, each file path becomes a header line above its first match and every match keeps its own selectable row — the Search view's shape. The header is label-only, because the extension host converts a separator to `{ type: 'separator', label }` and discards every other property.
7. **Buttons.** Both toggles use `QuickInputButtonLocation.Input` to sit inside the input box, and `toggle: { checked }` so QuickPick renders the pressed state; the checked flag is re-sent from the extension whenever it flips. Per-row buttons (open to the side, copy path) only render because the picker comes from `createQuickPick`.
8. **Preview.** `showTextDocument(..., { preview: true, preserveFocus: true })` keeps focus in the picker while the editor scrolls to the match. Every `items` update re-focuses row 0, so the extension remembers the last previewed `file:line:offset` and skips re-opening it — otherwise a floating preview would re-open the file on each keystroke. fff reports UTF-8 byte offsets, so they are converted to UTF-16 indices before building the selection. The previewed hit is revealed in the lower third, not centred: the picker's list is capped at 40% of the window height and starts at the title bar, so its bottom edge lands near the vertical middle — centred would mean hidden. Accepting a result reveals the selection normally, because by then the picker is gone.
9. **Stale matches.** The index can be behind the buffer. Before selecting, the match line is checked against the open document (and a few neighbours); when it no longer exists the extension opens the file without a selection and says why, instead of highlighting an unrelated line.

## Limitations

- **Headers are not rows.** A separator cannot be focused, carry a description, or indent its children: it renders as a line above the first match of each file, and the matches under it are flush with it rather than nested.
- **Ordering is fff's.** Label sorting is switched off through an undocumented `sortByLabel`, so if a future VS Code stops honouring it you go back to rows re-sorted by label score (grouped headers disappear at the same time).
- **No definitions-only filter.** fff's `definition_only` mode requires the newer native library; in the shipped `0.11.0` the classifier does not run at all — `isDefinition` stays `false` even for `export function foo` — and passing `classifyDefinitions: true/false` changes nothing. Modes `2`/`3` throw `BooleanExpected` because the C side still takes a boolean.
- **No file scoping.** `GrepOptions` has no `paths`/`globs`; those exist only in fff's MCP layer. fff's query parser can still scope by glob (`*.ts`) or by path segment (`/src/`), but filename-token constraints are off for grep (`enable_filename_constraint` defaults to `false` and the JS SDK does not expose it), so a file header cannot be turned into "search this file only" without scanning everything.
- **No context lines.** A row spends its second line on the line number in grouped mode and on the relative path otherwise; a context line would have to displace one of them.
- **No syntax-highlighted preview.** VS Code offers no floating window API, so the picker is a QuickPick and the preview is the real editor.
- **Single folder per picker.** In a multi-root workspace the index follows the folder of the active editor.
- **Definition detection is a line heuristic.** The classifier looks at the start of the matched line after skipping modifiers (`pub`, `export`, `default`, `async`, …) and checks for a declaration keyword. It handles `function`, `class`, `interface`, `type`, `enum`, `struct`, `fn`, `def`, `func` and `const x = () => …` / `= async () => …` / `= function …`; it does not recognise `let`/`var`, decorator-prefixed declarations, or a definition written as a call: `export const requestCouponPackage = async2Invoke(...)` is not flagged. In a 20-form corpus it scored 18 correct, 0 false positives, 2 missed.
- **The SDK is pinned to a nightly.** `0.11.0` reports `isDefinition` from struct padding instead of the real field (upstream #888), so the classifier is unusable there; `0.11.1-nightly.3004e2d` is the first build where `classifyDefinitions` works through the Node binding. The version is pinned exactly and should be revisited when `0.11.1` ships.
- **Native dependency.** The package ships prebuilt `fff` libraries (~5 MB per platform) for macOS, Linux, Windows and Android; the packaged `.vsix` is a few MB.

## Development

```bash
npm install
npm test                                      # picker behaviour, no VS Code needed
npx @vscode/vsce package                      # build fff-search-<version>.vsix
code --install-extension fff-search-*.vsix --force
```

There is no bundler and no build step: `extension.js` is loaded as-is and production dependencies are packed into the `.vsix`. `test/picker.js` stubs `vscode` and `@ff-labs/fff-node` and drives the picker through its events, which is where the preview de-duplication, dismiss restore and paging logic can actually regress without a host.

## Credits

- [fff](https://github.com/dmtrKovalenko/fff) by Dmitry Kovalenko (MIT) — the index and search engine
- Inspired by [Quick Grep](https://github.com/sangsoonam/vscode-extension-quick-grep)'s quick-pick UX
