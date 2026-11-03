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

- `cmd+shift+f` opens a picker; input stays focused, results update as you type
- Literal match with smart case; **falls back to fuzzy on zero hits**, so `requestCouponPkg` still finds `requestCouponPackage`. A zero-hit query also offers a "retry with fuzzy" row
- Three toggle buttons inside the input box: regular expressions, match case (smart case), and collapsing results to one row per file
- Preview: moving through results opens the file behind the picker and selects the match. The same row is never opened twice, and `esc` puts you back in the editor, cursor and scroll position you came from
- Each row shows the file-type icon, the match cropped around the hit, `file:line`, and the relative path. Row buttons open the result to the side or copy its path
- Paging: the last row is "Load more…", which fetches the next page from fff's cursor instead of re-running the search
- Empty input lists your recent searches from fff's query history
- Seeds the query from the current selection; remembers the last query
- Index is built once per workspace folder and kept fresh by a background watcher; with `eagerIndex` it starts at window open, and the picker shows live indexing progress
- The prompt reports file/match counts, truncation, regex fallback and how long the search took
- Frecency: files opened from the picker feed fff's ranking, persisted across sessions (VS Code re-sorts the visible rows by its own match score while the input is non-empty)

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
| `fffSearch.smartCase` | `true` | Case-insensitive while the query is lowercase; off means always ignore case |
| `fffSearch.fuzzyFallback` | `true` | Retry as fuzzy when a literal search finds nothing |
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
2. **Search.** `finder.grep()` with `plain` mode and smart case, or `regex` when the regex button is active. On zero results (3+ chars) it retries in `fuzzy` mode and labels the result as fuzzy — the same fallback fff's MCP server performs. An invalid regex is reported in the prompt and matched literally, which is what fff does internally.
3. **Time budget.** `grep` is a synchronous call across the FFI boundary: it blocks the extension host, and a zero-match query would otherwise scan every candidate file. `timeBudgetMs` bounds one keystroke, not one search: the fuzzy retry only runs when the literal pass finished inside 60% of the budget, so a keystroke can never block for twice the configured value. Truncation is reported through `nextCursor`, which also backs the "Load more…" row.
4. **Visibility, not ordering.** Every item sets `alwaysShow: true`; without it QuickPick hides fuzzy matches whose lines do not contain the literal query. Ordering is a different story: QuickPick's `sortByLabel` defaults to `true`, so while the input is non-empty it re-sorts visible rows by its own label match score. There is no public API to turn that off, so fff's frecency order survives only in the set of rows that make the page.
5. **Grouping.** QuickPick only renders separators when the input is empty (`sortByLabel && query` switches the list to items-only), so separators cannot be used for a live search. The group button instead collapses each file into one row: path as label, match count as description, first match as detail — accepting it opens that match.
6. **Buttons.** Both toggles use `QuickInputButtonLocation.Input` to sit inside the input box, and `toggle: { checked }` so QuickPick renders the pressed state; the checked flag is re-sent from the extension whenever it flips. Per-row buttons (open to the side, copy path) only render because the picker comes from `createQuickPick`.
7. **Preview.** `showTextDocument(..., { preview: true, preserveFocus: true })` keeps focus in the picker while the editor scrolls to the match. Every `items` update re-focuses row 0, so the extension remembers the last previewed `file:line:offset` and skips re-opening it — otherwise a floating preview would re-open the file on each keystroke. fff reports UTF-8 byte offsets, so they are converted to UTF-16 indices before building the selection.
8. **Stale matches.** The index can be behind the buffer. Before selecting, the match line is checked against the open document (and a few neighbours); when it no longer exists the extension opens the file without a selection and says why, instead of highlighting an unrelated line.

## Limitations

- **No separator rows.** `QuickPickItemKind.Separator` is only rendered when the input is empty, so grouped results are collapsed rows rather than headers with children.
- **Ordering is VS Code's.** `sortByLabel` cannot be disabled from an extension, so visible rows are re-sorted by label match score once you type.
- **No definitions-only filter.** fff's `definition_only` mode requires the newer native library; in the shipped `0.11.0` the classifier does not run at all — `isDefinition` stays `false` even for `export function foo` — and passing `classifyDefinitions: true/false` changes nothing. Modes `2`/`3` throw `BooleanExpected` because the C side still takes a boolean.
- **No per-file scoping.** `GrepOptions` has no `paths`/`globs`; those exist only in fff's MCP layer. fff's query parser can still scope by glob (`*.ts`) or by path segment (`/src/`), but filename-token constraints are off for grep (`enable_filename_constraint` defaults to `false` and the JS SDK does not expose it), so a grouped row cannot drill into one exact file without scanning everything.
- **No context lines.** A QuickPick item has one extra line (`detail`) and it currently carries the relative path; a context line would have to displace it.
- **No syntax-highlighted preview.** VS Code offers no floating window API, so the picker is a QuickPick and the preview is the real editor.
- **Single folder per picker.** In a multi-root workspace the index follows the folder of the active editor.
- **Native dependency.** The package ships prebuilt `fff` libraries (~5 MB per platform) for macOS, Linux, Windows and Android; the packaged `.vsix` is a few MB.
- fff is at `0.11.x` and its SDK is still moving; the version is pinned.

## Development

```bash
npm install
npx @vscode/vsce package                      # build fff-search-<version>.vsix
code --install-extension fff-search-*.vsix --force
```

There is no bundler and no build step: `extension.js` is loaded as-is and production dependencies are packed into the `.vsix`.

## Credits

- [fff](https://github.com/dmtrKovalenko/fff) by Dmitry Kovalenko (MIT) — the index and search engine
- Inspired by [Quick Grep](https://github.com/sangsoonam/vscode-extension-quick-grep)'s quick-pick UX
