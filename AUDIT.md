# SideX Codebase Audit

Audit date: 2026-08-10
Branch: `main`
HEAD: `999b851 fix: platform-aware VSIX download + long timeout (Kilo Code install)`
Worktree: clean
Target: Windows 10 x64, Tauri 2 + Vite + TypeScript + Rust workspace

## 1. What the last agent completed

The previous agent's work (top of history) was focused on one vertical slice: **extension installation from Open VSX**, plus the CI that proves it.

| Commit | Change |
|---|---|
| `b16993a` | README: Windows 10 x64 only, Open VSX, CI-built binaries |
| `51dd8b5` `cb15c69` | CI workflow trigger experiments |
| `1b29aa0` | `workflow_dispatch` on build/test workflows |
| `75b2d10` | Fix smoke test arg order; drop Windows rustfmt step (CRLF repo) |
| `94d5ccb` | Match real Open VSX schema in marketplace client |
| `a7a588d` | Clippy report-only (pre-existing lints break `-D warnings`) |
| `fad31b6` `be98565` `8b05626` | Formatting cleanup (rustfmt, prettier) |
| `e8a8285` | Lock Open VSX schema behavior + install/list/uninstall round-trip tests |
| `999b851` | Platform-aware VSIX download (win32-x64 preferred) + long timeout; Kilo Code regression test |

Delivered:
- `crates/sidex-extensions`: real Open VSX client, schema-matched types, platform-aware VSIX download, disk-backed install, registry scan, uninstall.
- `crates/sidex-extensions/tests/marketplace_install.rs`: network regression tests (`#[ignore]`, run in CI with `--ignored`).
- 8 CI workflows: `audit`, `build`, `fmt`, `lint-js`, `lint-rust`, `release`, `test`, `udeps`.
- README rewritten for Windows 10 x64 + CI-built releases.

## 2. Repository shape

```
sidex-src/                       git repo (origin Sidenai/sidex, fork airdropia/sidex)
├── src/                         VSCode-derived TypeScript workbench + SideX services
│   ├── main.ts                  frontend entry, Tauri boot, native menu wiring
│   ├── vs/platform/sidex/       SideX-owned platform services (IPC adapters)
│   └── vs/workbench/            workbench shell (upstream VSCode port)
├── src-tauri/                   Rust backend (Tauri 2)
│   └── src/commands/            ~40 command modules, all registered in lib.rs
├── crates/                      18 sidex-* Rust crates (git, db, lsp, tasks, dap, ...)
├── sidex-extension-sdk/         Rust SDK for building native extensions
├── extensions-rust/             sample Rust extensions (cpp/css/go/python/rust/typescript)
├── src-wasm/                    WASM helpers (hash, scroll, tfidf)
├── infrastructure/marketplace-proxy/  Cloudflare worker proxy (Open VSX)
├── examples/hello-extension/
├── scripts/                     generate-extension-meta.js, postbuild.js, setup-extensions.sh
└── .github/workflows/           8 CI workflows
```

## 3. Feature matrix (verified against code)

| Feature | Backend | Frontend | Status |
|---|---|---|---|
| File system | `commands/fs.rs` | `sidexFileSystemProvider.ts` | Working |
| Terminal (PTY) | `commands/terminal.rs` | `tauriTerminalBackend.ts` | Working (portable-pty) |
| Git | `commands/git.rs` + `crates/sidex-git` | `sidexSCMProvider.ts`, `sidexGitService.ts` | Working, wide surface |
| Search | `commands/search.rs` | `sidexSearchProvider.ts` | Working |
| Index search | `commands/index.rs` | (frontend?) | Registered; usage unverified |
| Storage | `commands/storage.rs` | storage service | Working |
| Settings | `commands/settings.rs` + `crates/sidex-settings` | `sidexSettingsService.ts` | Working |
| Themes | `commands/theme.rs` + `crates/sidex-theme` | `sidexThemeService.ts` | Working |
| TextMate | `commands/textmate.rs` + `crates/sidex-textmate` | `sidexTextMateService.ts` | Working |
| Keymap | `commands/keymap.rs` + `crates/sidex-keymap` | `sidexKeymapService.ts` | Working |
| Extensions (marketplace) | `commands/extensions.rs` + `crates/sidex-extensions` | `sidexExtensionService.ts` | Working (this cycle) |
| Extension host | `commands/ext_host.rs`, `extension_platform.rs` | `sidexExtensionApiService.ts` | Partial / in progress |
| WASM extensions | `commands/extension_wasm.rs` | (frontend?) | Registered; usage unverified |
| DAP/debug | `commands/debug.rs` + `crates/sidex-dap` | `sidexDapService.ts` | Partial |
| Tasks | `commands/tasks.rs` + `crates/sidex-tasks` | `sidexTaskService.ts` | Partial |
| LSP | `commands/lsp.rs` + `crates/sidex-lsp` | `sidexLspService.ts` | Registered; partial |
| Updater | `commands/updater.rs` + `crates/sidex-update` | update service | Complete (native) |
| Profiles | `commands/profiles.rs` + `crates/sidex-profiles` | (frontend?) | Registered |
| Secrets | `commands/secrets.rs` + `crates/sidex-auth` | (frontend?) | Registered |
| Watcher | `commands/watch.rs` | (frontend?) | Registered |
| Editor intel | `commands/editor.rs` | editor | Working |
| Text/compress/crypto | `commands/text.rs`, `compress.rs`, `crypto.rs` | editor plumbing | Working |
| Window/menu | `commands/window.rs`, `menu.rs` | `main.ts` | Working |
| Remote | none | `sidexRemoteService.ts` | **Broken: calls unregistered command** |

## 4. Concrete findings

### 4.1 Dead IPC surface: `remote_disconnect`
`src/vs/platform/sidex/browser/sidexRemoteService.ts` invokes `remote_disconnect`, which is **not registered** in `src-tauri/src/lib.rs`. The remote UI (SSH/WSL/containers/codespaces) is a stub with no backend. Either implement or remove.

### 4.2 Two terminal implementations
- `commands/terminal.rs` (portable-pty, `terminal_spawn`/`terminal_write`/...) is the live path used by `tauriTerminalBackend.ts`.
- `commands/process.rs` (`term_spawn`/`term_read`/`term_info`/...) is registered but **not called anywhere in the frontend**. Dead surface from the app's perspective.
- Both define their own `ShellInfo`; `get_default_shell`/`check_shell_exists`/`get_available_shells` exist in both.

### 4.3 Duplicate shell discovery
`resolve_windows_shell()` in `terminal.rs` vs shell discovery in `process.rs` + `crates/sidex-terminal`. Three sources of truth for "which shell to spawn".

### 4.4 Stub/partial modules with registered commands
- `commands/debug.rs`: DAP spawn/send/kill implemented; launch-config and adapter registry also present. `sidexDapService.ts` only calls `dap_stop_adapter`.
- `commands/lsp.rs`: registered but frontend integration thin (`sidexLspService.ts` only stops servers).
- `commands/extension_wasm.rs`: ~40 registered commands; no frontend caller found in `src/vs/platform/sidex`.
- `commands/index.rs`, `watch.rs`, `profiles.rs`, `secrets.rs`: registered, frontend usage not evident.

### 4.5 Security validation coverage
`commands/validation.rs` is wired into `fs.rs` (all 10 commands), `git.rs` (all commands), `search.rs` (all 6 commands), `watch.rs` (`watch_start` per-path), and `tasks.rs` (`task_spawn` cwd, `tasks_detect`, `tasks_parse_config`). Remaining path-taking surfaces not yet covered: `debug.rs`, `terminal.rs`, `extensions.rs`, `extension_wasm.rs`, `lsp.rs` — extend or explicitly justify per module. `validate_args` (NUL check for arg arrays) still has no call sites.

### 4.6 `sidex-asset` protocol
`lib.rs` registers `sidex-asset` custom protocol that serves arbitrary user files (Monaco image/asset preview). Hardened: rejects empty/NUL paths, directories, and files > 256 MB; MIME whitelist retained. `Access-Control-Allow-Origin: *` remains (app-origin specific value not feasible across webview origins) — acceptable for localhost-only asset serving.

### 4.7 CI lints are soft
- `lint-js.yml`: both jobs `continue-on-error: true`.
- `lint-rust.yml`: runs on **ubuntu** (system deps), not Windows x64; clippy without `-D warnings`.
- `build.yml`: clippy without `--all-targets`, no `-D warnings`.
- `fmt.yml` rustfmt runs on ubuntu while the repo is CRLF (previous agent dropped the Windows fmt step).
- `audit.yml` runs `cargo audit` against `src-tauri/Cargo.lock` only; ignores `RUSTSEC-2023-0071`.

### 4.8 `udeps.yml` and `lint-rust.yml` need Linux system deps
Both install webkit2gtk etc. on ubuntu — this is Linux-platform cruft in CI for a Windows-only product. They only exist because the crates/workspace uses Tauri. Could run `--no-default-features` style checks or restrict to pure crates.

### 4.9 Platform cruft remaining
- `src-tauri/src/main.rs`: linux WEBKIT env block.
- `src-tauri/tauri.macos.conf.json`, `entitlements.plist` remain.
- `notify` crate built with `macos_fsevent` feature.
- `[target.'cfg(unix)'.dependencies] libc` in `src-tauri/Cargo.toml`; `sidex-terminal` has unix-only deps.
- README/ARCHITECTURE still reference macOS (WKWebView) and "contributors welcome" text inconsistent with single-owner project.

### 4.10 Local machine policy
Per project rule: **no builds/tests on this machine**. All validation happens on GitHub Actions Windows x64. The repo already follows this (no local `.cargo` cache, CI-only installs), and this audit made no build attempts.

## 5. Risk register (top items)

1. Path validation enforced in `fs`, `git`, `search`, `watch`, `tasks`; `debug`, `terminal`, `extensions`, `extension_wasm`, `lsp` still take paths/args without traversal checks.
2. `sidex-asset` protocol now guards NUL/empty paths, directories, and > 256 MB files; MIME whitelist applies.
3. VSIX unpack now enforces limits: ≤ 2048 entries, ≤ 64 MB per entry, ≤ 256 MB total, zip-slip entries rejected.
4. `git_run`-style commands pass user strings to `git` → argument injection if args are not array-validated.
5. Extension host runs Node with full user permissions; no manifest API-allowlist.
6. Duplicate terminal paths → future divergence between the two implementations.
7. Remote stub calling a missing command → broken UI path shipped.

## 6. What's left (gap list, ordered by value)

1. Extend `validate_path`/`validate_args` coverage to `debug`, `terminal`, `extensions`, `extension_wasm`, `lsp` (fs, git, search, watch, tasks already covered).
2. Harden `sidex-asset` protocol with a base-directory allowlist — **done**: NUL/empty/dir/size guards + MIME whitelist (arbitrary user files intentionally served for editor preview).
3. Archive extraction limits in extension install — **done**: entry count, per-entry size, total size, zip-slip rejection (test added).
4. Decide the terminal story: keep `terminal.rs` as the single PTY path; mark `process.rs` `term_*` as extension-facing or remove.
5. Fix or remove the remote stub (`sidexRemoteService.ts` / `remote_disconnect`).
6. Wire WASM/LSP/index/watch/profile/secrets surfaces to frontend or unregister until implemented.
7. Tighten CI: run lint-rust on windows x64 with `-D warnings` (after fixing lints), remove `continue-on-error`, scope `udeps` to Windows, keep audit coverage.
8. Drop macOS/Linux cruft: configs, entitlements, unix deps where safe.
9. Update docs to reflect verified status and single-owner workflow.

## 7. Method

- Read-only inspection only. No builds, no downloads, no local tooling.
- Findings verified by grep/read of the actual tree, not by CI logs (no CI logs accessible from this machine).
- Feature matrix is code-verified, not runtime-verified; CI workflows are the runtime proof.
