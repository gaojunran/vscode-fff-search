# FFF Search

<img width="959" height="603" alt="FFF Search" src="https://github.com/user-attachments/assets/6af7a55d-6c97-424f-9e0f-ac97fce12838" />

A floating, typo-tolerant search box for VS Code — the shape of `cmd+p`, but searching file **contents**.

Press `cmd+shift+f`, type, and preview each hit in the editor behind the picker. An in-memory index makes a keystroke a lookup instead of a directory walk.

Powered by [fff](https://github.com/dmtrKovalenko/fff), which keeps a resident index of the workspace.

## Why not ripgrep

Extensions that shell out to `rg` per keystroke re-walk the tree every time, inherit the extension host's `PATH`, and drop every result if `rg` writes to stderr.

Measured on an 11k-file TypeScript repo, Apple Silicon:

| | fff (resident index) | `rg` per keystroke |
| --- | ---: | ---: |
| Index build, once per workspace | 1.5–3 s | — |
| Query, warm | 2–12 ms | ~100 ms |
| Query, cold | ~100 ms | ~100 ms |
| Files read for a warm query | 177 | all |

Warm means the query's files are in fff's content cache; cold means they are not.

## Features

- `cmd+shift+f` opens a picker, a second press closes it; results update as you type
- Literal search with smart case; **fuzzy on zero hits** by default, so `requestCouponPkg` still finds `requestCouponPackage`
- Two toggle buttons in the input box: regular expressions, and grouping matches under their file
- Moving through results previews the hit behind the picker, placed in the lower third so the box does not cover it; `esc` restores your cursor and scroll position
- Row buttons preview without leaving the search, or open the result to the side
- **Definitions first**: lines the engine classifies as declarations are lifted above call sites and marked with a symbol glyph, in the same pass
- **Honours your excludes**: enabled `search.exclude` and `files.exclude` entries are applied to the index, so hidden files are never walked; `.gitignore`, `.ignore`, `.git/info/exclude` and git's global excludes apply too
- Recent searches on an empty input; frecency ranking persisted across sessions
- Index is built once per workspace folder and kept fresh by a watcher, with progress shown while it builds

## Install

Not on the Marketplace yet:

```bash
git clone https://github.com/gaojunran/vscode-fff-search
cd vscode-fff-search
npm install
npx @vscode/vsce package
code --install-extension fff-search-*.vsix
```

Then reload the window.

`cmd+shift+f` replaces the built-in files search, which stays available from the Command Palette ("Files: Find in Files").

## Settings

| Key | Default | |
| --- | --- | --- |
| `fffSearch.fuzzy` | `auto` | When to search fuzzy: `auto` retries a zero-hit literal pass, `manual` offers a retry row, `off` disables it |
| `fffSearch.definitionsFirst` | `true` | Rank classified definitions above the rest |
| `fffSearch.useExcludeSettings` | `true` | Apply `search.exclude` and `files.exclude` to the index; editing either rebuilds it |
| `fffSearch.preview` | `true` | Preview results in the editor behind the picker |
| `fffSearch.restoreEditorOnDismiss` | `true` | Return to the editor, cursor and scroll position the picker was opened from |
| `fffSearch.smartCase` | `true` | Ignore case unless the query has an uppercase letter |
| `fffSearch.maxResults` | `200` | Matches per page |
| `fffSearch.maxMatchesPerFile` | `20` | Matches kept per file |
| `fffSearch.timeBudgetMs` | `150` | Budget per search; larger returns more but blocks the picker longer |
| `fffSearch.maxFileSizeMb` | `10` | Larger files are skipped |
| `fffSearch.seedFromSelection` | `true` | Use the current selection as the query |
| `fffSearch.persistFrecency` | `true` | Keep frecency and query history in global storage |
| `fffSearch.eagerIndex` | `true` | Start indexing when the window opens, so the first search is warm |

## Limitations

- **Headers are not rows.** A file header is a line above its first match, not a focusable group, and the matches are not indented under it. VS Code drops separators whenever it sorts the list, so label sorting is disabled to keep them.
- **A click cannot preview.** QuickPick reports a click and an Enter press identically, and its accept veto is not exposed, so preview is a row button rather than a click.
- **No definitions-only filter** and no context lines: one row is one match, and the classifier is a line heuristic — `export const x = factory(...)` is not recognised as a definition.
- **No file or glob scoping.** The SDK's grep has no `paths`/`globs`, and hidden dot-directories inside a git repo cannot be skipped — fff exposes neither yet ([#992](https://github.com/dmtrKovalenko/fff/issues/992)).
- **Native dependency**, ~5 MB of prebuilt libraries per platform; the SDK is pinned to `0.11.1-nightly.b3b8ced` because the definition tier is broken in `0.11.0`.
- **One folder per picker** in a multi-root workspace: the index follows the active editor.

## Development

```bash
npm install
npm test                      # picker behaviour, no VS Code needed
npx @vscode/vsce package      # build fff-search-<version>.vsix
```

No bundler and no build step: `extension.js` is loaded as-is and production dependencies are packed into the `.vsix`. `test/picker.js` stubs `vscode` and `@ff-labs/fff-node` and drives the picker through its events.

## Credits

- [fff](https://github.com/dmtrKovalenko/fff) by Dmitry Kovalenko (MIT) — the index and search engine
- Inspired by [Quick Grep](https://github.com/sangsoonam/vscode-extension-quick-grep)'s quick-pick UX
