# FFF Search

A floating, typo-tolerant search box for VS Code — the shape of `cmd+p`, but searching file *contents*.

Press `cmd+shift+f`, type, watch results appear in milliseconds, and preview each hit in the editor behind the picker. Results are ranked by [frecency](https://en.wikipedia.org/wiki/Frecency), so files you actually work in come first.

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

## Features

- `cmd+shift+f` opens a picker; input stays focused, results update as you type
- Literal match with smart case; **falls back to fuzzy on zero hits**, so `requestCouponPkg` still finds `requestCouponPackage`
- Two toggle buttons in the input box: regular expressions, and grouping results by file (current mode is shown in the picker title)
- Preview: moving through results opens the file behind the picker and selects the match
- Seeds the query from the current selection; remembers the last query
- Index is built once per workspace folder and kept fresh by a background watcher
- Frecency: files you open from the picker rank higher, persisted across sessions

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
| `fffSearch.maxResults` | `200` | Maximum matches per search |
| `fffSearch.maxMatchesPerFile` | `20` | Matches kept per file, so one huge file cannot fill the list |
| `fffSearch.smartCase` | `true` | Case-insensitive while the query is lowercase; off means always ignore case |
| `fffSearch.fuzzyFallback` | `true` | Retry as fuzzy when a literal search finds nothing |
| `fffSearch.timeBudgetMs` | `150` | Wall-clock budget per search; larger returns more but blocks the picker longer |
| `fffSearch.maxFileSizeMb` | `10` | Files larger than this are skipped |
| `fffSearch.persistFrecency` | `true` | Store frecency and query history in global storage |
| `fffSearch.preview` | `true` | Preview results in the editor behind the picker |
| `fffSearch.seedFromSelection` | `true` | Use the current selection as the query |

Press `esc` to dismiss. `cmd+shift+f` is remapped from the built-in files search; that command is still available from the Command Palette ("Files: Find in Files").

## How it works

The extension is a thin layer between the QuickPick widget and `@ff-labs/fff-node`:

1. **Index lifecycle.** `FileFinder.create()` starts a file scan plus a content index. Both `waitForScan()` and `waitForIndexReady()` must resolve — `grep` silently returns nothing until the content index exists. One index per workspace folder, kept for the window's lifetime and destroyed on deactivate. With `persistFrecency` on, the frecency and query databases live in the extension's global storage; if another window holds them, the index falls back to in-memory.
2. **Search.** `finder.grep()` with `plain` mode and smart case, or `regex` when the regex button is active. On zero results (for queries of 3+ chars) it retries in `fuzzy` mode and labels the result as fuzzy — the same fallback fff's MCP server performs. An invalid regex is reported in the prompt and matched literally, which is what fff does internally.
3. **Time budget.** `grep` is a synchronous call across the FFI boundary: it blocks the extension host, and a zero-match query would otherwise scan every candidate file. `timeBudgetMs` bounds it, and the picker reports truncation via `nextCursor`.
4. **Keeping fff's ordering.** Every item sets `alwaysShow: true`. QuickPick would otherwise re-filter items against their `label`, hiding fuzzy matches whose lines do not contain the literal query, and would discard fff's frecency order.
5. **Grouping.** The group button inserts `QuickPickItemKind.Separator` entries between files. fff returns matches ordered by file, so this splits an already grouped list rather than re-sorting it.
6. **Preview.** `showTextDocument(..., { preview: true, preserveFocus: true })` keeps focus in the picker while the editor scrolls to the match. fff reports UTF-8 byte offsets, so they are converted to UTF-16 indices before building the selection.

## Limitations

- **No definitions-only filter.** fff's `definition_only` mode requires the newer native library; in the shipped `0.11.0` the classifier does not run at all — `isDefinition` stays `false` even for `export function foo` — and passing `classifyDefinitions: true/false` changes nothing. Modes `2`/`3` throw `BooleanExpected` because the C side still takes a boolean.
- **No path scoping.** `GrepOptions` has no `paths`/`globs`; those exist only in fff's MCP layer, so "search this folder only" cannot be implemented without breaking pagination.
- **No context lines.** fff can return surrounding lines, but a QuickPick item renders a single label line.
- **No syntax-highlighted preview.** VS Code offers no floating window API, so the picker is a QuickPick and the preview is the real editor.
- **Single folder per picker.** In a multi-root workspace the index follows the folder of the active editor.
- **Native dependency.** The package ships prebuilt `fff` libraries (~5 MB) for macOS, Linux, Windows and Android; the `.vsix` is ~2.6 MB.
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
