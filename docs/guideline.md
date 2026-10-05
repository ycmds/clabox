# Project Guidelines

> **This file contains project documentation for developers.** For AI assistant instructions see [CLAUDE.md](../CLAUDE.md).

Guidelines for clabox — run Claude Code in a sandbox for super-safe YOLO mode, configured in plain JavaScript.

**Important:**
- Update this file after large project changes
- Run `bun run fix` and `bun run test` after each code change

## Stack

| Tool | Choice | Notes |
|---|---|---|
| Runtime (published) | Node.js ≥ 18 | `lib/` is plain ESM; macOS only (`sandbox-exec`) |
| Runtime (dev) | Bun | install / test / run TS source directly |
| Language | TypeScript (ESM) | strict `tsconfig`, `module`/`moduleResolution` nodenext |
| Build | tsdown (rolldown) | `src/**/*.ts` → `lib/` (ESM + `.d.ts` + sourcemaps) |
| Lint / Format | Biome | `recommended` preset, `.js`-import enforcement |
| Test | bun:test | `tests/` (configured in `bunfig.toml`) |
| Type-check | `tsc --noEmit` | strict, `src/` only |
| Size budget | size-limit | `@size-limit/preset-small-lib`, `lib/index.js` (13 kB) |
| Release | semantic-release | fully automatic on push to `main` |
| CI/CD | GitHub Actions | `macos-latest` (real `sandbox-exec`) |
| CLI | yargs ^17 | command/flag parsing |
| Logging | @lsk4/log ^4 | pretty leveled CLI logging (`cli.ts` only) |
| Sandbox | macOS `sandbox-exec` (Seatbelt/SBPL) | profile generated as plain text |

## Project Structure

**Rule:** Only entry-point files live in `src/` root — `index.ts` (public API aggregator) and `cli.ts` (the CLI, built to `lib/cli.js` = the `clabox` bin). All other code lives in subdirectories. The build emits to `lib/`; `bin`/`main`/`exports` point at built `lib/*.js`.

```
src/
├── index.ts              # public API aggregator — re-exports config / profile / run / init / info / daemon
├── cli.ts                # CLI entry (yargs): run / generate / profile / info / init / daemon / tab → lib/cli.js (bin)
├── sandbox/
│   ├── profile.ts        # pure SBPL builder: buildProfile, detectPackagePaths,
│   │                     #   subpath/literal/regex/globalName/ipcName/reEscape helpers
│   ├── extras.ts         # pure: boxSlug, buildBoxExtras (per-box mcp/systemPrompt/hooks → args+files)
│   ├── tab.ts            # pure: buildTabDecor (tab title/background OSC — marks a `--rc` tab)
│   ├── notify.ts         # pure: OSC 777 banner / OSC 9;4 progress / bell → claude hooks
│   ├── applescript.ts    # pure buildOpenScript + osascript I/O (open a box as a Ghostty tab)
│   ├── tty.ts            # I/O: suppressEcho — `stty -echo` over the launch handoff
│   ├── proctools.ts      # I/O: ensureProcTools — de-privileged `ps` copy;  pure: needsRefresh
│   └── run.ts            # I/O: profilePath, buildProfileText, generateProfile,
│   │                     #   writeExtraFiles, runClaude, which
├── info/
│   └── info.ts           # pure: formatInfo;  I/O: gatherInfo, resolveClaboxPackage, claboxVersion
├── daemon/
│   └── daemon.ts         # pure: buildDaemonArgs/buildDaemonEnv/daemonLogPath;  I/O: runDaemon
├── init/
│   ├── aliases.ts        # pure: aliasName, buildIndex, buildWrapper, buildAliasFiles
│   ├── ghostty.ts        # pure: buildGhosttyConfig, buildCommand/buildShellCommand,
│   │                     #   ghosttyHomeDir/ghosttyHomeConfigPath/buildHomeConfigShim,
│   │                     #   appBundlePath, bundleId, GHOSTTY_*_DEFAULTS,
│   │                     #   assertSafeAppName/assertSingleLine (input validation)
│   ├── raycast.ts        # pure: buildRaycastCommand, raycastIcon
│   ├── app.ts            # I/O (macOS): buildApp, canBuildApps, validateGhosttyConfig,
│   │                     #   conflictingUserConfig
│   └── scaffold.ts       # I/O: discoverProfiles, runInit (scan configs → scripts + apps + raycast)
└── utils/
    ├── config.ts         # defaultConfig, expandHome, mergeConfig, findConfigFile, loadConfig,
    │                     #   configsDir/resolveBox/listBoxes (named-box resolution),
    │                     #   boxWritableRoots/assertConfigNotBoxWritable, assertSafeBoxName
    └── trust.ts          # the trust gate for config files: configTrustState,
                          #   assertConfigTrusted, trustConfig/untrustConfig/listTrusted
tests/
├── profile.test.ts       # bun:test — unit (profile text) + functional (real sandbox-exec)
├── init.test.ts          # bun:test — alias/ghostty text + scaffold & app boxes (tmp-dir fs)
├── extras.test.ts        # bun:test — per-box mcp/systemPrompt/hooks → claude args + mcp/settings json
├── info.test.ts          # bun:test — formatInfo text + gatherInfo/resolveClaboxPackage
├── tab.test.ts           # bun:test — tab title/background OSC builders (`--rc` marking)
├── notify.test.ts        # bun:test — OSC banner/progress/bell + hook compilation
├── applescript.test.ts   # bun:test — the Ghostty AppleScript (tab/window/split, quoting)
├── tty.test.ts           # bun:test — the `stty -echo` launch guard (save/restore/degrade)
├── proctools.test.ts     # bun:test — de-privileged `ps` copy (unit + real sandbox-exec)
├── opener.test.ts        # bun:test — the opener broker: protocol, policy, handleRequest
├── daemon.test.ts        # bun:test — `clabox daemon` argv/env builders
├── trust.test.ts         # bun:test — the config trust gate + box-writable check (tmp-dir fs)
├── run.test.ts           # bun:test — ulimit/env builders + profile materialization (0600, no symlink)
└── box.test.ts           # bun:test — named-box resolution + box-name charset (tmp-dir fs)
lib/                      # build output (tsdown) — gitignored
docs/
├── guideline.md          # this file
├── troubleshooting.md    # findings from real debugging sessions (sandbox EPERM, login)
└── logo.png              # README logo
.github/workflows/
├── test.yml              # PR → install + build + test (macos-latest)
└── release.yml           # push main → semantic-release (macos-latest)
clabox.config.example.mjs  # copyable user config (object or (defaults) => config)
```

## Commands

```bash
# Build
bun run build                 # tsdown --out-dir lib (release build: ESM + .d.ts + maps)
bun run build:tsdown          # tsdown → lib-tsdown (default outDir)
bun run build:tsdown:release  # tsdown --out-dir lib
bun run dev                   # tsdown --watch

# Run
bun run cli                   # bun run src/cli.ts  (pass args after `--`)
bun run cli -- --ro ~/dir2 run       # ad-hoc read-only grant (repeatable)
bun run cli -- --ro ~/a --rw ~/b run # ad-hoc RO + RW grants (both repeatable)
bun run cli -- --stat ~/Library run  # ad-hoc stat-only grant: metadata, no contents
bun run cli -- -b ax-mg --rc                   # unset every var that blocks feature flags (→ /rc) + mark the tab
bun run cli -- -b ax-mg -e DISABLE_TELEMETRY   # unset a preset/shell var for this tab (→ /rc)
bun run cli -- -b ax-mg -e KEY=VALUE           # …or set one, this launch only
bun run generate              # bun run src/cli.ts generate (build a profile, print its path)
bun run cli -- info           # version + resolved box/config/extras report (pretty via @lsk4/log)
bun run cli -- init           # aliases per box + build Ghostty apps for `app` boxes
bun run cli -- init --no-apps # aliases only (skip the Ghostty-app build)
bun run cli -- init --app "AX Manager"  # (re)build just one app box
bun run cli -- -b ax daemon            # claude's Remote Control daemon, OUTSIDE the sandbox
bun run cli -- --name ax daemon --detach  # …in the background (`--name` is an alias of `-b`)
bun run cli -- -b ax daemon status     # passthrough: run | status | stop [--any] | logs
bun run cli -- -b ax-mg tab            # open the box in a new tab of the RUNNING Ghostty
bun run cli -- -b ax-mg tab --split right --rc  # …as an --rc split next to this one
bun run cli -- -b ax-mg tab --print    # print the AppleScript instead of running it

# Testing
bun run test                  # lint + types + unit + size (the full gate)
bun run test:unit             # bun test
bun run test:unit:coverage    # bun test --coverage
bun run test:unit:watch       # bun test --watch
bun run test:types            # tsc --noEmit
bun run test:lint             # biome lint
bun run test:size             # size-limit

# Fixing
bun run fix                   # biome check --write
bun run fix:lint              # biome check --write
bun run fix:lint:unsafe       # biome check --write --unsafe

# Release (normally automatic in CI)
bun run version:release       # semantic-release --no-ci --dry-run (preview next version)
bun run release               # build + test + dry-run + npm publish (local fallback)
```

## Architecture

`sandbox-exec` runs a process inside a Seatbelt profile that starts with `(deny default)` — everything is forbidden unless explicitly allowed.

```
clabox run  →  loadConfig()  →  buildProfile()  →  <TMPDIR>/…sb
            →  sh -c 'ulimit -u N; exec sandbox-exec -f <sb> env … claude …'
```

### `utils/config.ts`
Builds the effective config in three layers (later wins): `defaultConfig` → env vars → a JS config file. `findConfigFile(explicit?)` looks up the explicit path (the `--config` CLI flag, falling back to `CLABOX_CONFIG`) → `./clabox.config.mjs` / `./clabox.config.js` → `~/.config/clabox/config.mjs`; the `--config` flag wins over `CLABOX_CONFIG`. `loadConfig(explicit?)` forwards that path, dynamically imports the file and accepts either a plain object (merged via `mergeConfig`, a deep merge over the defaults) or a function `(defaults) => config`. `expandHome()` expands a leading `~`. `FLAG_FETCH_BLOCKERS` lists the four env vars that disable claude's feature-flag fetching (`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `DISABLE_GROWTHBOOK`) — what the `--rc` flag unsets. `withExtraEnv(config, entries)` layers the ad-hoc `--env`/`-e` overrides onto `config.env`: each entry is `KEY=VALUE` (set — split on the **first** `=`, so a value may contain more) or a bare `KEY` (**unset**, stored as `null`); later entries win, the CLI wins over the box, nameless entries (`=1`) are dropped, and an empty list returns the same object. `config.env` is `Record<string, string | null>` for exactly that reason — the sandboxed claude inherits the shell env, so a var a preset or the login shell exported can only be removed explicitly. `parsePathGrant(grant, path?)` normalizes a per-path rights value (`'rw'` / `['r','w']` / `['read','write']`, plus the `ro`/`rw` words) into a letter set, throwing on an unknown letter, an empty grant or `'d'` combined with a grant. `resolvedPathRules(paths)` folds **both** spellings into one list per right — the legacy `readOnly`/`readWrite` aliases into the canonical `read`/`write` (aliases first, concatenated), then every `'<path>': '<rights>'` entry into the classes its letters name, in declaration order — and hands `buildProfile`/`formatInfo` one `ResolvedPathRules` shape, so neither has to care which spelling a box used. A key that is neither a known field nor path-shaped throws (typo guard). `withExtraPaths(config, { readOnly?, readWrite?, stat? })` layers ad-hoc grants (from the `--ro`/`--rw`/`--stat` CLI flags) onto `config.paths` by **concatenation** — unlike the config-file `mergeConfig` where arrays *replace*, these are additive so a CLI grant never wipes a box's own paths; it returns the config untouched when nothing extra is passed. Exports the `Config`/`BotConfig`/`PathRules`/`McpServer`/`HookCommand`/`HookMatcher`/`HooksConfig`/`LoadedConfig` types. The `Config` carries optional `mcp` (`Record<string, McpServer>`), `systemPrompt` (`string | string[]`) and `hooks` (`HooksConfig` = claude's settings.json `hooks` map) — declarative per-box MCP / pre-prompt / hooks compiled by `sandbox/extras.ts` (see below).

**Named boxes.** `configsDir()` returns the global box dir (`~/.config/clabox/configs`, overridable via `CLABOX_CONFIGS_DIR`). `resolveBox(ref, dir?)` maps a `-b` ref to its config file in three forms. **Name** (`ax-root`): looked up in `dir` (default `configsDir()`), preferring `<name>.config.mjs` over a bare `<name>.mjs` and throwing (with the available boxes listed) when none exists; a `_`-prefixed name is refused (it's a shared partial, not a box), so `-b` matches exactly what `listBoxes` advertises. **Explicit file path** (`path/vibe.mjs` — any ref ending in `.mjs`): `~`-expanded, resolved against the CWD and used as-is; it must exist as a regular file (a directory named `*.mjs` doesn't count), else it throws. Pointing at the file is explicit intent (like `--config`), so even a `_*.mjs` partial is accepted here. **Dir-qualified name** (`path/vibe` — contains a separator, no `.mjs` suffix): resolved as box `vibe` inside `path/`, with the same suffix preference and `_`-refusal as a plain name. The path forms let a repo carry its own boxes (e.g. an alias `exec clabox -b path/vibe.mjs "$@"`). `listBoxes(dir?)` returns the sorted, de-duplicated box names, skipping `_`-prefixed shared partials (e.g. `_presets.mjs`). The CLI's `-b`/`--box` flag resolves the ref and feeds the path to `loadConfig` as the explicit config (so `-b` wins over `--config`).

### `opener/` — the brokered slice of `open`

`config.allowOpen` is all-or-nothing, because `lsopen` takes no filters: to
Seatbelt, "reveal this folder in Finder" and "launch the `.app` the agent just
wrote into /tmp" are one operation. The broker exists because the *useful* part
of that operation is narrow, and can be granted without the escape.

`opener/server.ts` (`clabox opener`) runs **outside** the sandbox and listens on
`<claboxHome>/opener/opener-<uid>.sock` (`0600`). There is **one** broker per
machine and every box talks to it: a box only ever *sends a path*, and the result
— a Finder window, an editor tab — lands in front of the user rather than back in
the box, so there is nothing per-box to isolate. Policy (`roots`, `editor`)
therefore belongs to the broker (its own config, or `--root`/`--editor`), and the
profile grants the socket to every box unless it sets `opener: { enabled: false }`
— harmless on its own, since the socket exists only while a broker runs. In-box,
`clabox reveal <dir>` / `clabox open <file>` (`opener/client.ts`) send one line.
Every decision lives in `opener/protocol.ts`, which is pure, so the security
claim is unit-tested rather than argued:

- the wire format is `<action> <absolute path>` — **no flags**. One `-a`, `-b` or
  `--args` in a request and the agent is picking what runs again, which is the
  entire thing being avoided; the action vocabulary (`reveal`/`edit`) is closed
  for the same reason, and control characters or >4 KB lines are refused.
- `reveal` compiles to `open -R`, documented as "reveals the file(s) in the
  Finder **instead of opening them**" — it cannot launch anything, bundles
  included. `edit` compiles to `open -a <app>`, where the app comes from
  `opener/routing.ts` — never from the request.
- **Routing** (`routing.ts` pure + `apps.ts` I/O): code and text → the first
  installed of `CODE_EDITORS` (Zed, Cursor, VS Code, Sublime, Nova, BBEdit,
  TextMate, IntelliJ, WebStorm); a `.md` under an Obsidian vault (a `.obsidian`
  directory above it) → Obsidian; a `.md` **outside** a vault → the first
  installed of `MARKDOWN_APPS` (Typora, MacDown, Marked 2) before the code
  editor, because `open`ing a doc is a request to *read* it — the agent edits
  markdown through the file tools, never through an app — falling through to
  `CODE_EDITORS` when no reader is installed, so a machine without one is
  unchanged; images and PDFs → Preview; nothing installed →
  `open -t`. `--editor`/`opener.editor` overrides the lot. The first two
  attempts are recorded in the code because both failed in use: the type's
  registered handler sends `.md` to **Xcode** on a stock Mac (which then asks to
  install system components), and `-t` sends it to **TextEdit**. `apps.ts` lists
  `.app` names from /Applications, ~/Applications and /System/Applications —
  plain `readdir`, no Spotlight, and it runs in the broker because a sandboxed
  process cannot read /Applications at all.
- the path is `realpath`ed before judging (a symlink inside a root is exactly how
  an in-root path aims at `/Applications`), must sit inside `opener.roots`
  (default: `$HOME`), must not touch a `.app`/`.bundle`/
  `.framework`/`.xpc`/`.appex`, and for `edit` must match
  `DEFAULT_EDIT_EXTENSIONS` — a list that contains no type LaunchServices or a
  shell would execute.
- a **missing** path is refused with the same reason as an out-of-root one, so the
  broker never becomes an existence oracle for the rest of the disk.
- requests are rate-limited (`RateLimiter`, 12/min by default): a broker that
  opens windows on request is a way to flood the screen, and fifty Finder windows
  hide the one action you'd have objected to. Everything, allowed or not, is
  appended to `<claboxHome>/opener/opener.log`. Socket, pid file and log all come from `openerDir()` = `<claboxHome>/opener`, so the broker's whole on-disk footprint is one `ls` — and the log path is derived from that dir rather than walked up from the socket with two `dirname`s, which silently followed the socket wherever it moved.

**The shell helpers are generated, not documented** (`opener/aliases.ts` pure → `runOpener` writes `<claboxHome>/opener/claude-aliases.sh`, `0644`).

They talk to the socket **directly, with `nc -U`, and never run `clabox`**. That is the load-bearing part: exec'ing clabox inside a box requires a grant on wherever its binary *physically resolves*, and for a dev install (`npm link` / `bun link`) that is clabox's own source repo — `/opt/homebrew/bin/clabox → ../lib/node_modules/clabox/lib/cli.js → ~/projects/clabox/lib/cli.js` — a path granted by exactly one box. So the first version of these helpers died with `operation not permitted: clabox` in every *other* box, before the socket was ever touched. `nc` lives in `/usr/bin`, which `BASE_PATH_GROUPS` already grants `rme`, so the helpers need **no new grant**: the socket grant a box gets from `opener.enabled` is the whole dependency. The socket path is baked in at generation time — the broker writes the file, so the path cannot drift from the broker that serves it — and `_cb_abs` makes a relative path absolute with `cd`/`pwd` instead of `realpath` (not on every system, and redundant: the broker realpaths and roots-checks the target itself).

**One request per connection**, for the same reason. The server used to answer with `conn.write` and leave the connection open for further lines, which nothing ever sent — and which made the broker unusable from a plain shell: `printf … | nc -U <socket>` printed the reply and then hung forever waiting for EOF. It now answers with `conn.end`. The node client is unaffected (it already destroyed the socket on the first reply).

Reaching the broker by hand wants a helper, and the correct one is not a one-liner:

- `clabox open` **refuses a directory** — a dir has no extension in `DEFAULT_EDIT_EXTENSIONS`, so `o .` answers `denied: file type not allowed`. A folder goes to `reveal`, a file to `open`; the helper picks the verb with `[ -d "$t" ]`.
- a **URL** can't go to the broker at all (the wire format is an absolute path), so it falls through to the native `open`.
- **outside** a box the native `open` is still the right answer — `o .` should open a Finder window exactly as before, not reveal the dir in its parent. The branch is `_cb_inbox`, implemented as `[ ! -r /Applications ]`: clabox exports no in-box marker env var, and `/Applications` is granted to no box, so that read is the cheapest reliable probe. (A real marker would be better and is not there yet.)
- **functions, not aliases**, and POSIX only: claude's `!` bash mode runs a *non-interactive* shell, where zsh aliases are not expanded — `!o .` used to die with `command not found: o` — and the same file has to source in both bash and zsh.

It is rewritten on every broker start, so it carries opener business only; personal shell functions belong in the rc that sources it. `clabox opener` prints the path together with the `source` line, because the file is useless unsourced and nobody guesses where it is. It lives under the clabox home rather than in the user's dotfiles because a **box** has to read it — the helpers are what the agent types *inside* the sandbox — and the post-deny carve-out already grants that tree read-only.
- `open` is `execFile`d, never run through a shell.

The profile grants the socket only when `opener.enabled` (`profile.ts` folds it
into `socketPaths` via `resolvedOpener`), so a box without the block cannot even
connect. Binding, as opposed to connecting, needs `network-bind` — which no box
has — so a broker started *inside* a box fails with `cannot listen on … EPERM`
and a message that says where it belongs.

**The residual, stated plainly:** an editor may execute what it opens (Obsidian
runs vault plugins and `dataviewjs`; VS Code has tasks). The broker does not
create that exposure — the agent already writes those files and the user already
opens them by hand — but it does let the agent choose the moment. Hence
`editor` defaulting to null, which leaves reveal-only: Finder does not execute
what it shows.

### `utils/trust.ts` — the gate in front of `import()`

A box config is JavaScript, and `loadConfig` `import()`s it **before `sandbox-exec` is anywhere in the picture**: its top-level code runs as the user, and the object it returns *is* the sandbox policy. Three documented paths led there from a tree a sandboxed agent can write:

- a repo's `./clabox.config.mjs`, auto-loaded by a bare `clabox` (`findConfigFile` probes the CWD);
- `-b ./boxes/vibe.mjs` — "a repo can carry its own boxes";
- `clabox init --dir <repo>`, which imports **every** config under `<repo>/configs`. `--no-apps` only skips the app *build*, not the import, so `git clone && clabox init --dir .` was remote code execution.

So the agent writes the file and the next launch runs it unsandboxed. Two independent checks now stand in the way, and both can be waived with `--trust` / `CLABOX_TRUST=1` for a single run.

**1. Trust (location or record).** `configTrustState(file, claboxHome)` returns `home` when the file resolves inside `claboxHomeDir()` (trusted by location — that tree is read-only in-box), else `trusted`/`stale`/`unknown` by looking the **real path** up in `<claboxHome>/trusted.json` and comparing the recorded `sha256:<hex>` against the file's current content. `assertConfigTrusted` throws for `unknown`/`stale` with a message that names the file, the reason and the two ways forward. Content-keying is the point: an edit — by you or by an agent that can write the repo — invalidates the approval instead of inheriting it. `trustConfig`/`untrustConfig` maintain the store (`0600`, written to a `.tmp` stage and `rename`d so a crash can't leave a truncated file that silently de-trusts every box), `listTrusted` reports each record with its current state. The CLI surface is `clabox trust [file] [--list] [--remove]`.

**2. Not writable by the box it configures.** Trust answers "did a human look at this file?", not "can the agent rewrite it before the next launch?". After the merge, `config.ts#assertConfigNotBoxWritable` refuses a config that sits inside any of `boxWritableRoots(config)` — the project dir, `configDir`, `$TMPDIR` and every `write` grant, minus the trees the hard secret deny buries (`~/.<denyDotConfigs>`, which is why a box asking for `'~/.config/clabox': 'w'` is correctly *not* counted) and minus the box's own `deny` entries. The config **file** is tested against the hard deny before any of that (`hardDeniedPath`) — without it a whole-disk box (`paths: {'/': 'w'}`) refuses to start, since `/` is writable and therefore "contains" its own config, even though `~/.config` is denied by the profile's last rule and is the one tree that box cannot write. This is the check for the symlinked-clabox-home layout: nominally the config lives in the read-only home, physically it's in a repo the box writes, and Seatbelt matches the resolved path. `trust.ts#realpath` therefore resolves as far as the path exists and keeps the rest lexical, so a missing last component can't hide a symlinked parent; `isInside` compares resolved paths with a separator-aware prefix test (`/a/b` does not contain `/a/bc`).

The profile backs both up: `clabox.config.*` inside the project is write-denied by `DEFAULT_DENY_WRITE_GLOBS`, so the plant should fail before any of this matters.

### `sandbox/profile.ts` (pure)
Assembles the SBPL profile text from typed helpers (`subpath`, `literal`, `regex`, `globalName`, `ipcName`, `reEscape`) — no I/O beyond `fs.existsSync` for autodetection. `detectPackagePaths()` finds installed package managers (Homebrew `/opt/homebrew` or `/usr/local/Homebrew`, `~/.local`, Nix `/nix/store`) to grant read/exec. `buildProfile(config, { projectDir, detectedPaths })` returns the full profile and sanity-checks it carries `(version 1)`.

Inside `buildProfile`, every **allow** rule builds its path matcher through the local `sp()`/`lit()` wrappers instead of the bare `subpath`/`literal`. They are identical except that they record the path in a `granted` set, which the final `stat(2)`-ancestors section consumes (`pathAncestors(p)` → every directory above `p`, up to `/`). Deny rules keep using the bare helpers — a denied path's ancestors are nobody's business. A new allow rule that bypasses the wrappers doesn't break anything visibly; it just silently leaves its ancestors unstat-able, which surfaces much later as an `EPERM` partway down a path. `pathAncestors` is exported and unit-tested on its own.

`resolvedDeveloperDirs()` covers the Xcode/CLT toolchain. The profile grants `/Library/Developer/CommandLineTools` and `/Applications/Xcode.app` statically, but `/usr/bin/python3` — like `clang`, `git` and `swift` — is a shim that execs whatever `xcode-select -p` currently selects, and Seatbelt matches the **symlink-resolved** path. On a developer mac `Xcode.app` is a real directory and the static grant is enough; on a CI runner the bundle is versioned (`/Applications/Xcode_16.4.app`) with `Xcode.app` a symlink onto it, so the static grant matches nothing and CPython dies at preinit with `_Py_HashRandomization_Init: failed to get random numbers`. The symptom is a functional test that passes on every laptop and fails only in CI. The resolver therefore reads the realpath of the link `xcode-select` maintains (through `fs`, keeping the module's "no I/O beyond autodetection" rule) plus the realpaths of the static pair, drops anything already granted, and hands the rest to the same read/exec section. Best-effort: an absent or unreadable link contributes nothing, exactly like `resolvedClaboxHome()`.

**The link itself has to be granted, and Apple moved it.** Resolving the bundle is only half the job: a shim reads the selector link *before* it execs anything, so a granted bundle behind an ungranted link gets you nothing — every shim dies with `xcode-select: error: unable to read data link at '/var/select/developer_dir', expected symbolic link (Operation not permitted)`, which means **no `git` and no `python3` inside the box at all**, not merely a broken Xcode. The location changed between releases — `/var/db/xcode_select_link` through macOS 15, `/var/select/developer_dir` on 26+ — so `XCODE_SELECT_LINKS` lists both (newest first) and `BASE_PATH_GROUPS` grants both; an absent one costs nothing, while reading only the old path silently resolves to nothing on a current mac and presents as "no developer tools installed". `/var/select` is granted as a tree rather than one literal because it is the system's alias dir: `/var/select/sh` (the default-shell selector) is read on *every* `/bin/sh` startup, and denying it makes each shell print `Error opening /private/var/select/sh: Operation not permitted` into the middle of unrelated command output.

**A symlinked system dir needs both forms granted.** Seatbelt matches the resolved path, so the resolved grant authorizes the open — but walking a path through a symlinked ancestor *also reads the link*, and the stat-ancestors pass only climbs **above** granted paths. `/private/etc` was granted while `/etc` was not, and since no grant lives *under* `/etc`, no ancestor rule ever covered it: every lookup through `/etc/...` failed on the link itself. The symptom was the system `curl` refusing all HTTPS — `error setting certificate verify locations: CAfile: /etc/ssl/cert.pem`, exit 77, `http_code 000` — which reads as a box with no network even though `node`'s `fetch` works and `curl --cacert /private/etc/ssl/cert.pem` returns 200. `/etc` is now granted `'sl'`: `file-read-metadata` on the link alone, never a tree below it, with contents still coming from `/private/etc`. `/tmp` + `/private/tmp` were already written as such a pair — that is the pattern to follow for any symlinked root, not a historical quirk.

**And the resolved half is the load-bearing one.** The pairing above is easy to
misread as "either spelling works, grant both to be safe". It isn't: Seatbelt
matches the resolved vnode path, so `'/private/var/db/timezone'` is what
authorizes opening `/var/db/timezone`, and a rule written `'/var/db/…'`
authorizes **nothing at all** — the rule sits in the profile, `sandbox-exec`
accepts it, and the access is still denied. The `literal` form that makes `/etc`
work does not generalize either, because `/etc` *is* the symlink (reading the
link is reading that path) while a path *below* a symlinked root is a different
vnode. That distinction has shipped broken twice — `/etc/ssl` above, and then
the `xcode-select` fix, whose first version granted `'/var/select': 'r'` plus a
literal `'/var/db/xcode_select_link'` and so left every box without `git` or
`python3`, which is the exact symptom it was written for. The invariant is now
data plus a test: `PRIVATE_SYMLINK_ROOTS` + `resolvedTwin(path)` in
`utils/config.ts`, and a unit test in `tests/profile.test.ts` that fails unless
**every** base-policy path under `/etc`, `/tmp` or `/var` has its `/private`
twin in the table. `resolvedTwin` is deliberately **lexical** — it must give the
same answer inside a box, where the path it describes may be unreadable, as it
does on a bare host, so it cannot use `realpath`.

Related, and the other half of every "my profile fix did nothing" report: a
Seatbelt profile is applied at `exec` and never re-read, so **a running box
keeps the policy it was launched with**. Editing a config or upgrading clabox
changes nothing for an open box — including the one you are typing in. Probe the
live box (`ls -ld <path>`) rather than re-reading the rule, then open a new box.
See [troubleshooting.md](troubleshooting.md#a-profile-fix-doesnt-help-two-traps-before-you-debug-anything-else).

### `sandbox/extras.ts` (pure)
Compiles a box's **declarative** `mcp` / `systemPrompt` / `hooks` config into claude args (and the files they reference), so user config stays pure data and clabox owns the wiring. `boxSlug(configFile, projectDir)` derives a stable slug — the config-file basename minus `.config.mjs`/`.mjs`, else the project-dir basename. `buildBoxExtras(config, slug)` returns `{ claudeArgs, files }`: when `config.mcp` (a `Record<string, McpServer>`) is non-empty it writes `<claboxHome>/mcp/<slug>.json` (`{ mcpServers: … }`) and emits `--mcp-config <file>`, preceded by `--strict-mcp-config` unless the box sets `strictMcp: false` (see below); `config.systemPrompt` (`string | string[]`, joined with blank lines) is appended inline via `--append-system-prompt` (no file); `config.hooks` (a `HooksConfig` = claude's settings.json `hooks` map) is merged into a settings object written to `<claboxHome>/settings/<slug>.json` and loaded with `--settings <file>`. The merge matters because a second `--settings` flag *replaces* the first rather than deep-merging, so `readInlineSettings()` first parses any inline `--settings` JSON already in `config.claudeArgs` (e.g. `{"includeCoAuthoredBy": false}`) and folds the hooks into it — emitted after `config.claudeArgs`, the file then wins the last-`--settings`-takes-all race while carrying the merged result. Both json files live under clabox's **own** home (`claboxHomeDir()` = `~/.config/clabox`, via `claboxMcpDir()`/`claboxSettingsDir()`) — **not** the Claude `configDir`, so clabox never writes into Claude's profile dir. Since `~/.config` is hard-denied, the sandbox profile re-grants **READ-ONLY** to the whole `~/.config/clabox` home *after* the hard deny so the box can read them — clabox writes the files from outside the sandbox before launch, so the box never needs (and never gets) write access to its own configs.

**`strictMcp` — the box's own servers vs. the account's cloud connectors.** `--strict-mcp-config` is documented as *"Only use MCP servers from `--mcp-config`, ignoring all other MCP configurations"*, and that phrase is wider than it sounds: besides the file-based servers (a shared `configDir`'s global ones, a project `.mcp.json`, plugin-provided servers) it also drops the account's **claude.ai connectors** — Linear, Slack, Figma, Influencer Analytics and friends, which no local config declares because they're proxied through `mcp-proxy.anthropic.com` (`transport: claudeai-proxy` in `~/Library/Caches/claude-cli-nodejs/<proj>/mcp-logs-claude-ai-*`). Only the built-ins survive, `claude-in-chrome` among them, listed in `/mcp` under *"Built-in MCPs (always available)"*. The practical consequence is that `config.mcp` is **not additive**: adding one server to a box that relied on cloud connectors silently takes all of them away, and the box's `/mcp` drops to its own list plus the built-ins. `config.strictMcp` (default `true`, env `CLABOX_STRICT_MCP=0`) is the switch — `false` emits a bare `--mcp-config`, which *merges* the box's servers with everything else claude knows. Keep it `true` for an isolated box (the original point: each box loads exactly its own servers out of a shared configDir), set it `false` on a box that wants its MCP *in addition to* the cloud ones.

### `sandbox/tab.ts` (pure)
Builds the OSC escape sequences the launcher writes around a run, so two tabs of the *same* box are distinguishable — the motivating pair being `clabox -b ax-mg` (private) vs `clabox -b ax-mg --rc` (feature flags on, session reachable from the Claude app). `buildTabDecor(config, { projectDir, rc })` returns `{ enter, leave, title, background, foreground, cursor }`: `enter` is the title (`OSC 0`, `config.tab.title` or the `~`-shortened project dir, prefixed with `config.tab.rcBadge` when `rc`) plus whichever colors resolved — background `OSC 11`, foreground `OSC 10`, cursor `OSC 12`; `leave` resets exactly those, each with its code +100 (`111`/`110`/`112`), or `''`. Every color is a pair — `rcBackground`/`rcForeground`/`rcCursor` win for an `--rc` launch and fall back to the plain field when null. `normalizeColor()` accepts `#rgb` / `#rrggbb` (expanded) / a bare X11 name and returns **null** for anything else — a color carrying `ESC`/`BEL` would otherwise be an injection point into the terminal stream, and a typo must not fail a launch, so a bad value silently means "leave the terminal alone". Titles are sanitized the same way. `run.ts` writes `enter`/`leave` **only when `process.stdout.isTTY`** (piped output would just collect escape garbage) and restores the colors whatever exit code claude returns; a `kill -9` of clabox itself can still leave the tab repainted. Note claude rewrites the terminal title while it works — unless the box exports `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`, which is what makes the badge stick — so the colors are the durable marker and the badge is a hint. Defaults live in `defaultConfig.tab`: `rcBadge: '📡 RC'`, `rcBackground: '#5c1a00'`, `rcCursor: '#ff8c1a'`, everything else null. Background **and** cursor by design: on macOS Ghostty the native tab takes the surface background, so `rcBackground` colors the tab itself, but `background-opacity`/blur washes it out — a bright blinking cursor doesn't wash out, and `rcForeground` is left off because repainting all text is the one change that can hurt readability. Each field is overridable by its `CLABOX_TAB_*` env var, where an **empty** value means "off".

### `sandbox/notify.ts` (pure) — notifications that survive the sandbox
Notification Center is out of reach from a box: `terminal-notifier` hangs (wedging every later Stop hook) and `osascript display notification` dies with `NSNotificationCenter connection invalid`, because both need mach services a sandboxed process doesn't get. The terminal emulator, however, runs **outside** every box and already reads a file the profile grants — the tty. Ghostty (verified on 1.3.1) implements `OSC 777;notify` (a real macOS banner), `OSC 9;4` (the ConEmu progress indicator on the tab/dock) and BEL (whatever `bell-features` is set to); kitty, WezTerm and iTerm2 understand the same OSCs, and a terminal that doesn't just ignores them.

`buildNotifyHooks(config.notify, slug)` compiles that into claude hooks: **Stop** (the reply landed) = banner + bell + progress cleared, **Notification** (claude is blocked on you) = banner + bell + progress parked at `paused`, i.e. a yellow tab — which, unlike a banner, is still there when you come back. A `null` body drops that event's banner (progress/bell still fire); `enabled: false` compiles to `{}`. `ttyWrite(seq)` wraps raw sequences into `printf '<escapes>' > /dev/tty 2>/dev/null || true` — **the redirect is the point**, since a hook's stdout is captured by claude and a banner printed there reaches nobody; the escaping order (backslash → `%` → ESC/BEL → `'`) matters because each step would otherwise mangle the next. `sanitizeOscText` strips control chars, turns the `;` field separator into a comma and caps the length. `mergeHooks(...)` concatenates matchers per event, so the injected hooks are added to a box's own (`afplay` pings keep working) instead of replacing them. Opt-in via `config.notify.enabled` / `CLABOX_NOTIFY=1`.

### `sandbox/applescript.ts` (pure builder + `osascript` I/O) — `clabox tab`
The lightweight counterpart of an `app` box: instead of a cloned `.app`, open the box as a surface of the Ghostty you're already running. Ghostty ships a scripting dictionary (`Ghostty.sdef`) with a `surface configuration` record — `command`, `initial working directory`, `initial input`, `environment variables`, `font size`, `wait after command` — plus `new window`, `new tab`, `split`, `focus`, `input text`, `send key` and `perform action`. `buildOpenScript({ command, cwd, mode, direction, bundleId, activate, input })` renders the `tell application id …` block for `tab` (default) / `window` / `split`; the split branch targets `focused terminal of selected tab of front window` and falls back to a new window when no window is open. `asQuote` escapes `\` and `"` and **drops** control characters rather than escaping them — a raw newline would end the statement and let the remainder run as its own AppleScript command. `runAppleScript` is the only I/O and never throws: a missing Ghostty, a refused Automation permission or a syntax error all come back as `{ ok: false, output }`, which the CLI prints along with a pointer at System Settings → Privacy & Security → Automation. The surface runs the same `zsh -lic '…'` string as an app box (`init/ghostty.ts#buildShellCommand`), and `cli.ts#forwardedGlobals` re-emits `--rc`/`-e`/`--ro`/`--rw` into it — those are global yargs options, so they're consumed by the outer parse and would otherwise never reach the new tab. `--print` dumps the script instead of running it. `osascript` itself is unreachable from inside a box (binary and Apple-events mach service both denied), so this is a user-facing command, not an agent capability.

### `sandbox/tty.ts` (I/O)
Keeps claude's own startup handshake off the screen. Claude probes the terminal as it boots — XTVERSION (`CSI > 0 q`), an OSC 11 background query for light/dark detection, and a DA1 (`CSI c`) flush sentinel — and reads the answers back off **stdin**. Those answers are *input*, so anything that arrives before claude has raw mode up is printed by the line discipline instead of being consumed, and the welcome banner comes out shredded:

```
^[P>|ghosttClaude1Code[v2.1.26352c  ▐▛███▛█
```

(the terminal's replies, `ESC` rendered as `^[` by `ECHOCTL`, interleaved with the logo). The window is wider inside a box — every startup read goes through Seatbelt — and it's Ghostty that surfaces it first, because it answers in microseconds while a slower terminal tends to reply once claude is already in raw mode. The launcher owns the terminal right up to the handoff, so `suppressEcho(io)` closes the window: `stty -g` to snapshot the termios, `stty -echo -icanon` (`MUTE_ARGS`) to mute it, and a `restore()` that writes the snapshot back verbatim (idempotent, called from a `finally` around `spawnSync`). **The `-icanon` is not cosmetic**: ECHO off *with* ICANON on is precisely the termios state a password prompt leaves (`read -s`, `sudo`), and emulators watch for it — Ghostty's `macos-auto-secure-input` (default on) `tcgetattr`s the pty and enables macOS **Secure Input** (`EnableSecureEventInput`: the padlock in the title bar, no app may read keyboard events, and per Ghostty's own docs it interferes with accessibility software). A `-echo`-only guard therefore made every box launch look like a password prompt. Clearing ICANON as well makes the window look like the TUI handoff it is; ISIG stays on, so Ctrl+C still works in it. Two side effects worth knowing: libuv snapshots the tty state on claude's **first** `setRawMode`, so claude's own raw-mode toggles (early input capture → Ink mount) restore *our* echo-less state instead of a noisy one; and a claude that dies without restoring the terminal no longer leaves the shell mute, since the restore lives out here. `sttyIo(env)` is the real `stty` (fd 0 inherited, `CLABOX_TTY_GUARD=0` opts out); every failure — not a tty, no saved state, `-echo` refused — degrades to the shared `NO_GUARD`, because a terminal left without echo would be much worse than a garbled banner.

### `sandbox/proctools.ts` (I/O) — the `ps` a box can actually run
Gives the agent back the ability to *see* what it started. `/bin/ps` and `/usr/bin/top` are setuid **root**, and Seatbelt denies `exec` of any setuid/setgid binary — the denial is `forbidden-exec-sugid` and it holds no matter how wide `process-exec` is, so no profile rule can fix it (Apple was asked for a de-privileging directive for exactly this case and declined). The way around it is to *remove* privilege rather than grant any: a plain copy of `/bin/ps` carries no setuid bit, and `ps` only needs root for processes owned by **other** users (`KERN_PROCARGS2` and most of `proc_pidinfo()` are gated by `PRIV_GLOBAL_PROC_INFO`; same-uid lookups are not). So the copy still lists everything the agent itself spawned — the whole point — while root's and other users' processes become invisible, i.e. strictly *less* visibility than the profile granted before.

`PROC_TOOLS` declares the set (just `ps`; `top` is an interactive full-screen tool an agent has no use for, and every copy is one more thing to keep in sync with the OS). `needsRefresh(src, dst)` is the pure staleness rule: refresh when the copy is missing, empty, or **older** than its source — the last one catches a macOS update replacing `/bin/ps`. It deliberately does **not** compare the copy's size against the source's, because re-signing rewrites the signature and changes it, which would reinstall on every single launch. `ensureProcTools(dir = claboxBinDir())` does the I/O, best-effort by construction: a failure is returned as a `warning` and never throws, since a missing `ps` must not keep a box from launching.

**The re-signing is load-bearing, not hygiene.** A bare copy is SIGKILLed at launch (exit 137): `/bin/ps` carries the restricted entitlement `com.apple.system-task-ports.read`, which is only honored for Apple platform binaries, and the copy is not one — so AMFI kills it. `codesign -f -s -` drops Apple's signature along with the entitlement and the copy runs normally. The install therefore stages into `<name>.new`, `chmod 0755`, signs, and only then `rename`s atomically onto the final path: a box must never be able to exec a half-copied or still-Apple-signed binary.

Everything here runs **outside** the sandbox, before launch, into `claboxBinDir()` = `<claboxHome>/bin` — a dir that already carries the post-deny read + `process-exec` carve-out, so this whole feature adds **no rule to the profile**. `run.ts#buildEnvArgs` puts that dir first on the box's PATH, so an agent typing `ps aux` transparently gets the copy. `clabox info` reports the state per tool (`procTools   ps: ready` / `stale (refreshed on next run)` / `missing (installed on next run)`) without installing anything — `info` is a read-only report.

Not fixed here, on purpose: `pgrep`/`pkill`. They aren't setuid, so they would work with `(allow mach-lookup (global-name "com.apple.sysmond"))` — they link `libsysmon.dylib` and die with `sysmon request failed with error: sysmond service not found` without it. That rule is the one candidate fix that opens a **new channel out of the box** (a mach service), and the `ps` copy answers the same question while opening nothing, so it stays unemitted.

### `sandbox/run.ts` (I/O)
`buildProfileText(config, projectDir)` returns the SBPL text, and that text is what `runClaude` hands to **`sandbox-exec -p`** — there is no profile *file* in the launch path at all. There used to be: `$TMPDIR/clabox-<dir>-<hash>.sb`, written with a plain `writeFileSync` and read back by `sandbox-exec -f`. The base policy grants the whole `$TMPDIR` read-write, so that file — which *is* the box's policy — was writable by the box itself at a path derived deterministically from the project dir. Two ways to use that: overwrite it with `(version 1)(allow default)` in the window between the write and the exec (the launcher does several more fork/execs in there — extras, proctools, `ps`, `sysctl`, `stty` — and nothing reaps a process the box left behind), so the next launch of that box runs claude **unsandboxed**; or plant a symlink at the path and let `writeFileSync` (no `O_EXCL`, no `O_NOFOLLOW`) truncate the target. An 8 KB profile against a 1 MB `ARG_MAX` means the file was never needed.

`profilePath()` still returns a deterministic path — now `<claboxHome>/profiles/clabox-<dir>-<hash>.sb`, under the clabox home, which the profile re-grants **read-only** in-box — and `generateProfile()` (the `clabox generate` command, plus `info`'s "has it been generated" check) materializes a copy there for inspection: `0600`, written to an `O_EXCL` stage and `rename`d into place, so it neither follows a planted symlink nor exposes a half-written profile. `resolveProjectDir(config)` returns the effective project dir — `config.cwd` (with `~` expanded) when set, else `process.cwd()` — delegating to `utils/config.ts#projectDirOf` so the config layer can reason about the project dir without importing the launcher. `writeExtraFiles(files)` `mkdir -p`s and writes the per-box extras (the mcp/settings json under `~/.config/clabox`). `runClaude()` resolves the project dir + `claude` binary (config → PATH → `~/.local/bin/claude`), compiles + materializes the box extras (`buildBoxExtras` + `writeExtraFiles`), refreshes the de-privileged tool copies (`proctools.ts#ensureProcTools`, whose dir `buildEnvArgs` puts first on the box's PATH), forces the bot git identity + hardening env (`buildEnvArgs`, with `config.env` appended last so it wins — and its `null` values emitted as `env -u KEY` **before** the assignments, since `env` only accepts `-u` ahead of the `KEY=VALUE` list), decorates the tab (`tab.ts#buildTabDecor` — title, plus badge + background for an `--rc` launch, written only onto a TTY and reset after claude exits), mutes input echo for the handoff (`tty.ts#suppressEcho`, restored in the same `finally` as the tab reset), and execs `sh -c 'ulimit -u N; exec sandbox-exec -p <profile text> env … claude <config.claudeArgs> <extras> <CLI args>'` **in the resolved project dir** (`spawnSync` `cwd`), returning the exit code. The profile text is one argv entry passed through `exec "$@"`, so its newlines and quotes are never re-parsed by the shell. (`runInit` also materializes the extras at `init` time via `scaffold.ts#materializeExtras`, slug = box name.)

Part of that hardening env is `SANDBOX_ESCAPE_GUARDS` (from `utils/config.ts`), emitted unless the box sets `allowBackgroundTasks: true`. It closes claude's **background-task escape hatch**, which is a genuine hole rather than a nicety: a background task is not forked by the sandboxed process (a macOS sandbox is inherited and cannot be dropped, so a real fork would stay confined) — the in-box claude asks the singleton `claude daemon run` supervisor over its control socket, and that daemon runs **outside every box** (PPID 1, started by launchd, no `sandbox-exec` in its ancestry). It answers by launching `claude --fork-session --resume <same-session-id>`, so the work continues with the identical transcript under an empty Seatbelt policy — measured: reading `~/Library/Logs/DiagnosticReports`, writing `~/Desktop`, all while the box's system prompt still says "you're in a sandbox". Any detach/re-attach of a session (tabbing away and back) is enough to trigger it. The guard is `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`; the opt-out is deliberately the `allowBackgroundTasks` flag (or `CLABOX_ALLOW_BACKGROUND_TASKS=1`) rather than an `env` entry, because `env` only accepts its `-u` flags ahead of the assignments — an `env: { …: null }` would emit `-u KEY … KEY=1` and leave the var set, so skipping the guard is the only opt-out that can work. An explicit `env: { …: '0' }` still wins, since the guard is emitted before `config.env`. Diagnosing a suspect session: `echo "$CLAUDE_PID"` plus `ps -eo pid,ppid,command | grep sandbox-exec` — no `sandbox-exec` in the ancestry means no profile, whatever the box says. See [troubleshooting.md](troubleshooting.md#a-box-escapes-its-own-sandbox-via-a-background-task).

### `info/info.ts` (pure `formatInfo` + I/O `gatherInfo`)
Backs `clabox info`, the introspection report — version, the resolved box/project/profile, the effective config, the compiled per-box extras, and the clabox-relevant env vars. `gatherInfo(config, { configFile, box })` is the I/O snapshot: it resolves `claude` and `sandbox-exec` (via the now-exported `run.ts#which`), records the running `process.argv[1]`/`process.execPath`, the deterministic profile path (+ whether it's been built), the compiled `buildBoxExtras` args/files, and the present `CLABOX_*` / `CLAUDE_CONFIG_DIR` env, returning a flat serializable `InfoData`. `formatInfo(data, { color })` is the **pure** aligned-text builder — sections (`[clabox]`/`[box]`/`[config]`/`[extras]`/`[env]`), label-padded rows, multiline args collapsed to one line; `color` (off by default, on for a TTY) wraps headers/labels/placeholders in ANSI. **Version + self-path** come from `resolveClaboxPackage()`, which walks up from `import.meta.url` to the `package.json` whose `name === 'clabox'`: a fixed `../../package.json` is wrong once tsdown hoists shared code into a hashed chunk (`lib/info-<hash>.js`) at a different depth, but the walk-up holds across the source tree, the built tree and an installed `node_modules/clabox/`. `cli.ts` prints the report through `@lsk4/log` (`createLogger('clabox').log(report)` keeps the table clean; `.warn(…)` flags a missing `claude`/`sandbox-exec`).

### `daemon/daemon.ts` (pure builders + I/O `runDaemon`) — Remote Control, unsandboxed
Backs `clabox daemon`, which runs claude's Remote Control supervisor **outside** the Seatbelt profile. Remote Control (`/rc`, sessions driven from the Claude app) needs that supervisor; it is a **singleton per Claude config dir** — socket `/tmp/cc-daemon-<uid>/<hash(configDir)>/control.sock` — and claude starts it **on demand**, so whichever process asks first owns it. If that first ask comes from inside a box, the daemon is born sandboxed and is crippled two ways: (1) it probes its own start time by exec'ing `/bin/ps`, a setuid-**root** binary Seatbelt refuses to exec (`forbidden-exec-sugid`) however wide the `process-exec` grant is, so it logs `own process start-time probe failed twice — writing a procStart-less lock; kill paths will refuse to signal this daemon` — it can then no longer be stopped by `claude daemon stop`, while an on-demand daemon "never displaces a running one"; (2) a macOS sandbox is inherited by children and **cannot be dropped**, so every worker it spawns for a remote session stays confined to *that* box's profile and dies on any other project (`bg settled … (crashed): exit 1 before init`). `buildDaemonArgs(args)` is pure (`['daemon', ...args]`, defaulting to `['daemon', 'run']`); `buildDaemonEnv(config, base?)` is pure too — the inherited env plus `CLAUDE_CONFIG_DIR = expandHome(config.configDir)` (what the daemon keys its socket/lock/roster/log off) and `config.env` layered last; `daemonLogPath(config)` is `<configDir>/daemon.log`. `runDaemon(config, args, { detach })` spawns `claude daemon …` in the box's project dir with **no `sandbox-exec` and no `ulimit`** — foreground `spawnSync` with inherited stdio by default, or `detached` + `stdio: 'ignore'` + `unref()` under `--detach`, returning `{ status, pid, logFile, configDir }`. Start it once (a shell rc line, or a launch agent) and every box's `/rc` reuses the healthy daemon instead of spawning a sandboxed one. See [troubleshooting.md](troubleshooting.md#remote-control-rc-and-remote-sessions-in-a-box).

### `init/aliases.ts` (pure) + `init/scaffold.ts` (I/O)
`clabox init` turns a directory of box configs into ready-to-use shell commands. `aliases.ts` is pure text: `aliasName(profile)` yields `clabox-<name>`; `buildIndex()` renders the source-able `index.sh` (a `_clabox_run` helper that runs `clabox -b "$1"`, prefixed with `CLABOX_CONFIGS_DIR=<configsDir>` only when `configsDir` is non-null — see `bakeConfigsDir` below — plus one function per box); `buildWrapper()` renders a standalone `.sh` that sources `index.sh` and calls one function; `buildAliasFiles()` returns the full file set. There is **one command per box** — yolo vs. safe is decided by the box's own preset (`claudeArgs`), not by a `-safe` alias. `scaffold.ts` does the I/O: `discoverProfiles(configsDir)` returns the sorted box names via `listBoxes` (both `<name>.mjs`/`<name>.config.mjs`, `_`-partials skipped; throws if the dir is missing or has no boxes), and `runInit({ baseDir, buildApps, only })` (async) resolves `<baseDir>/configs` + `<baseDir>/scripts` (default `baseDir` = `defaultBaseDir()` = the parent of the global `configsDir()`, i.e. `~/.config/clabox`, honoring `CLABOX_CONFIGS_DIR`; pass `--dir` for a project-local `<dir>/configs`), prunes its own prior artifacts (`index.sh`, `clabox-*.sh`), then writes the new ones `chmod +x`. It also materializes each box's MCP json (`materializeExtras`, best-effort per box). **Generated commands resolve at run time, not init time**: `clabox` is emitted bare (PATH-resolved at launch — survives package-manager moves like bun → npm/homebrew), and `bakeConfigsDir(dir)` returns `null` (omit the `CLABOX_CONFIGS_DIR` prefix) when `<dir>/configs` already resolves (realpath, symlinks included) to the runtime default `~/.config/clabox/configs`, else the absolute path. The project `cd` dir stays absolute. It returns `{ profiles, written, apps, ghosttyConfigs, raycastCommands, extraFiles, warnings, … }`.

### `init/ghostty.ts` + `init/raycast.ts` (pure) + `init/app.ts` (I/O) — standalone Ghostty apps
A box becomes a real macOS app by carrying an `app` object (`AppConfig`: `name`, `title?`, `emoji?`, `icon?`, `macosIcon?`, `ghostty?`, `bundleId?`). When `runInit` runs with `buildApps` (the default), it `loadConfig`s each box and, for every box with an `app`, writes `<baseDir>/ghostty/<name>.config`, a `<baseDir>/raycast/<name>.sh` Raycast command, and clones a `.app`. `ghostty.ts` is pure text: `buildGhosttyConfig()` renders the config (a `command = zsh -lic 'cd "<cwd>" && [CLABOX_CONFIGS_DIR="<dir>" ]"<claboxBin>" -b <name>; exec zsh'` — `<cwd>`/`<dir>`/`<claboxBin>` are double-quoted (`shQuote`, nested inside the outer single quotes) so a path with spaces — e.g. iCloud's `~/Library/Mobile Documents/…` — isn't split into two `cd` arguments (`string not in pwd`) — a **login + interactive** zsh so the GUI-launched app inherits the user's PATH (`/etc/zprofile`→`path_helper` for Homebrew, `~/.zshrc` for fnm/nvm/volta); a bare `bash -c` gets only launchd's minimal PATH and can't find `node` for clabox's `#!/usr/bin/env node` shebang. `<claboxBin>` defaults to a bare `clabox` (PATH-resolved at launch by that login shell — `appBuilder.claboxBin` pins an absolute path instead); the `CLABOX_CONFIGS_DIR=<dir> ` prefix is present only when `configsDir` is non-null (`bakeConfigsDir`, same rule as the aliases). Plus `title`/`macos-icon`/extra `app.ghostty` lines and an optional leading `config-file`); `ghosttyHomeDir()`/`ghosttyHomeConfigPath()`/`buildHomeConfigShim()` derive the box's private `XDG_CONFIG_HOME` (`<baseDir>/ghostty-home/<name>`) and the one-line `config-file = <baseDir>/ghostty/<name>.config` pointer Ghostty reads inside it; `appBundlePath()`/`bundleId()` derive the bundle path/id. `raycast.ts` renders the Raycast script command (`buildRaycastCommand()`: `@raycast.*` metadata + `open <appPath>`; `raycastIcon()` picks `app.emoji`, else the title's leading emoji, else 👻). `app.ts` is the macOS-only I/O (replaces the old `ghostty-app-builder.sh`): `canBuildApps(builder)` gates on darwin + donor app; `buildApp()` builds into a staging `<appsDir>/<name>.app.new` and atomically `rename`s it onto `<appsDir>/<name>.app` **only after all steps succeed** (so a failed build never destroys an existing working bundle): it extracts the donor's entitlements, `cp -R` clones Ghostty.app into the stage, patches `Info.plist` (identity, Sparkle off, and `LSEnvironment = {XDG_CONFIG_HOME: <baseDir>/ghostty-home/<name>}`), installs the icon (`.icns` copy or `.png`→`sips`+`iconutil`, plus `plutil -remove CFBundleIconName` — Ghostty's plist references an icon inside its compiled `Assets.car`, which macOS prefers over the loose `.icns`, so the name must be dropped for our icon to take effect), and `codesign`s (`appBuilder.signId`, else ad-hoc `-`). Machine-wide build settings live in `config.appBuilder` (`ghosttyApp`, `appsDir`, `signId`, `baseGhosttyConfig`, `claboxBin`). Builds are best-effort: a non-buildable host or a thrown build records a `warning` and the aliases (plus the ghostty config + raycast script) are still emitted. `init` prunes its own `<baseDir>/ghostty/*.config`, `<baseDir>/ghostty-home/*` and `<baseDir>/raycast/*.sh` on a full run (not under `--app`, which would orphan other apps' artifacts); built `.app` bundles are **not** auto-deleted.

**The clone must keep the donor's own binary.** The config is delivered through `LSEnvironment`, not through a launcher — because a wrapper binary silently destroys the bundle's identity. See [troubleshooting.md](troubleshooting.md#a-cloned-app-is-invisible-to-window-managers-pid--1).

**`baseGhosttyConfig` is inherited by every clone**, since it is emitted as the leading `config-file`. A `keybind = global:…` there makes *each* app box ask for Accessibility at *every* launch (it needs a global event tap) — keep global keybinds in the personal `~/.config/ghostty/config`. See [troubleshooting.md](troubleshooting.md#every-app-box-asks-for-accessibility-on-each-launch).

Two things every generated config carries, emitted **after** the optional base `config-file` (so they beat it) and **before** the box's own `app.ghostty` (so a box can still override — Ghostty takes the last value of a scalar key). `GHOSTTY_SECURITY_DEFAULTS` closes a hole Seatbelt structurally cannot see: the terminal protocol is **bidirectional**, so an agent that can print to its own stdout can ask the emulator — which runs outside every box — to hand data back. `OSC 52` reads the **system clipboard** (`clipboard-read = deny`) and `OSC 21` reports the window/tab title as input (`title-report = false`); neither touches the filesystem, so no path rule would have stopped them. `GHOSTTY_APP_DEFAULTS` adds `window-colorspace = display-p3`, which is what makes a marker color (the `--rc` background, a box's own tint) look saturated instead of muddy on a modern display. Existing configs pick both up on the next `clabox init`.

`validateGhosttyConfig(builder, configPath)` (in `app.ts`) then asks the donor's own binary — `<Ghostty.app>/Contents/MacOS/ghostty +validate-config --config-file=<generated>` — whether it understood what we wrote, and `scaffold.ts` turns a complaint into a `warning`. Ghostty does **not** fail on an unknown key: it logs and carries on, so a typo in `app.ghostty` (or a key dropped in a Ghostty upgrade) would otherwise surface much later as settings that mysteriously don't apply. It's a nicety, never a blocker: a missing donor app or a Ghostty without the subcommand returns null.

### `cli.ts`
The yargs CLI (`scriptName('clabox')`). Commands: `run [claudeArgs..]` (default), `generate`, `profile`, `info`, `init`, `daemon`, `tab`, `trust`, `opener`, `reveal`, `open`. `unknown-options-as-args` keeps unknown flags as positionals so they pass straight through to `claude` (e.g. `--dangerously-skip-permissions`). `info` honors the same `--config`/`-b` selection (via `explicitConfig(argv)`) and renders `formatInfo(gatherInfo(...))` through `@lsk4/log` — the one place a non-`yargs` runtime dep is used. clabox-owned flags: `--config <path>` (a JS config file that overrides `CLABOX_CONFIG`) and `-b`/`--box <ref>` (a named box from the global configs dir, or a path form — `path/vibe.mjs` for an explicit config file, `path/vibe` for a dir-qualified name; resolved via `resolveBox` and winning over `--config`) — both forwarded to `loadConfig()` by `run` and `generate` through the `explicitConfig(argv)` helper. A third global flag, `--env`/`-e <KEY=VALUE|KEY>` (repeatable, `nargs: 1`), overrides the environment for one launch — `KEY=VALUE` sets, a bare `KEY` unsets — so one box can serve two kinds of tab without a second config (`clabox -b ax-mg -e DISABLE_TELEMETRY` re-enables feature-flag fetching, and with it `/rc`, for that tab only). `-e` is free: claude's own short flags are `-c -d -h -n -p -r -v -w`. `--rc` is the shorthand for the common case — it prepends `FLAG_FETCH_BLOCKERS` (the four vars that turn claude's feature-flag fetching off) as unsets, ahead of the `-e` entries so an explicit one still wins. All four, deliberately: any single var from any source blocks the fetch, so clearing a subset silently leaves `/rc` hidden. `--rc` is also forwarded to `runClaude` as `RunOptions.rc` (purely cosmetic there) so the tab gets `config.tab.rcBadge` + `rcBackground` — the two tab kinds are otherwise indistinguishable, and one of them is remotely reachable. Three more global flags, `--ro <path>`, `--rw <path>` and `--stat <path>` (all repeatable, `nargs: 1` so a greedy array never swallows the subcommand or a trailing claude arg), add ad-hoc grants of the three access classes without a config file: `withCliPaths(argv)` collects them and calls `withExtraPaths` to *append* them onto `config.paths` before `run`/`generate`/`profile`/`info` build the profile (additive — a box's own paths survive; the hard secret deny still wins, so `--ro /` can't expose credentials, and `--stat ~/.ssh` can't uncover `id_*`). `--stat` is the narrowest: existence/size/mode/mtime and nothing else, which is the only way to re-open `stat(2)` on a path now that the profile grants no metadata globally. (`-b` deliberately avoids `-p`/`-c`/`-r`/`-d`/`-v`, which are claude's own `--print`/`--continue`/`--resume`/`--debug`/`--verbose`.) `init` takes `--dir <path>` (the base dir holding `configs/` and `scripts/`, default `~/.config/clabox` = parent of the global `configsDir()`, honoring `CLABOX_CONFIGS_DIR`), `--no-apps` (skip the Ghostty-app build), and `--app <box|name>` ((re)build a single app box, by box name or `app.name`). `tab [claudeArgs..]` opens the box as a surface of the running Ghostty via AppleScript (`sandbox/applescript.ts`): `--window` / `--split <right|left|down|up>` pick the surface kind, `--app` addresses the box's own cloned bundle id instead of the stock Ghostty, `--print` dumps the script instead of running it. Because the interesting flags (`--rc`, `-e`, `--ro`, `--rw`) are *global* options, they're consumed by this parse and would never reach the new tab — `forwardedGlobals(argv)` re-emits them into the launched `clabox` command, so `clabox -b ax-mg tab --rc` really does open an `--rc` tab. `daemon [daemonArgs..]` forwards its positionals to `claude daemon` (default `run`; `status`/`stop [--any]`/`logs` pass through untouched thanks to `unknown-options-as-args`) and takes `--detach`; `--name` is an alias of `-b`/`--box`, so `clabox --name ax daemon` reads naturally.

Two more things `--rc` now does beyond the env unsets: it sets `remoteControl: true` on the effective config, which is what grants the `cc-daemon-<uid>` socket Remote Control talks over (a box that doesn't ask for `/rc` doesn't get the channel to the one process that can re-host its session without a profile), and it marks the tab as before. And one new global flag: `--trust` (env `CLABOX_TRUST=1`), which accepts a config file that is either untrusted or box-writable **for this run only** — see `utils/trust.ts` below. `trust [file]` is its persistent counterpart: with no argument it records the config the current flags resolve to (`-b`/`--config`, else the CWD/`~/.config` lookup), `--list` prints the records (marking the ones whose content changed since), `--remove` drops one. `init` takes `--trust` too, because it `import()`s every config under `<dir>/configs`.

### What the profile allows and denies

The built-in grants are **data, not code**: `BASE_PATH_GROUPS` in `utils/config.ts` lists them as `path: rights` with a one-line reason each, grouped into the sections they're emitted as, and `basePaths()` seeds them into `defaultConfig.paths`. `profile.ts` compiles tables (`grantBlock`) and never spells out an SBPL rule for a base path. Consequences worth knowing:

- A box can **change the base policy** the same way it adds its own paths — `'/System': 'r'` narrows, `'/': 'w'` widens, `'~/Library/Keychains': 'd'` removes.
- Placement decides whether an override bites, since SBPL is last-match-wins. A path left at its default is emitted in its base section, *before* the soft privacy deny (that's what `untouchedBaseKeys` detects); an override is emitted with the box's own grants, *after* it. So a whole-disk `'/': 'w'` box still beats `denyHome`, exactly as the old `readWrite: ['/']` did, and a `'d'` joins the soft deny tier where it buries the default grant above it.
- Two rights letters exist only for the base rules: `m` = `file-map-executable` (dyld maps libraries executable) and `i` = `file-ioctl` (termios on a tty). `l` is a matcher modifier — this path only, not the tree — and a key beginning with `^` is an SBPL regex.
- What can't be static stays in code: the autodetected package managers (`detectPackagePaths`), the `xcode-select` toolchain (`resolvedDeveloperDirs`), `config.configDir`, `config.bot.sshDir`, the project workspace, clabox's own home, and every non-path grant (mach services, `sysctl-read`, `signal`, `process-info*`).
- **Per-path grants (the preferred spelling):** `paths: { '~/scratch': 'w', '~/some/hooks': ['r','e'], '~/Library/Group Containers': 's', '~/secret': 'd' }` — the key is the path, the value its rights: `r` read, `w` write, `s` stat-only, `e` exec, `d` deny. A value is a letter run (`'rw'`), a list of letters (`['r','w']`) or a list of words (`['read','write']`); `parsePathGrant` normalizes all three. `resolvedPathRules` then folds the entries into the same per-class lists the profile has always emitted, so the two spellings mix freely in one `paths` object. Two reasons to prefer it: a path reads as one line with its rights next to it, and a box building on a preset stops spreading *per class* — `paths: { ...presets.root.paths, '~/x': 'w' }` replaces the `readWrite: [...presets.root.paths.readWrite, '~/x']` + `exec: [...]` + `readOnly: [...]` dance, because a path key simply lands next to the preset's keys (and a path declared twice collapses to one entry instead of being emitted twice). The **outer** `...preset.paths` spread is still needed: spreading a preset inside a config file is plain JS, so `paths:` replaces the preset's object wholesale — clabox's `deepMerge` only applies between `defaultConfig` and the file (there, path keys survive while arrays replace). Strict on input, because a typo here silently widens a sandbox: an unknown letter, an empty grant, `'d'` mixed with a grant, and a key that is neither a known field nor path-shaped (`/`, `~`, `.`) all throw — the last one is what catches `readWritte: [...]` instead of taking it for a relative path.
- **Three access classes, narrowest first — `stat` ⊂ `read` ⊂ `write`** (`PathRules`, compiled by `resolvedPathRules`). `read` grants `file-read*`, which in SBPL already *includes* `file-read-metadata`, and `write` adds `file-write*` — so each wider class implies the ones below it and a path only needs its widest class listed. `read`/`write`/`stat` are the canonical config names; `readOnly`/`readWrite` are kept as aliases and concatenated with them, so existing box configs keep working. On the CLI: `--ro`, `--rw`, `--stat` (all repeatable).
- **`stat` is a path-scoped right, not a global one.** The profile used to carry a bare `(allow file-read-metadata)` in the introspection block — unfiltered, i.e. `stat(2)` over the whole disk. Because `file-read-metadata` and `file-read-data` are **separate operations**, every deny tier below (which denies `file-read*`/`file-write*`) hid *contents* while leaving *existence, size, mode and mtime* readable everywhere: a box could not `ls ~/Library/Group Containers/<team>.com.1password` yet could confirm, file by file, exactly what lived in it. Now metadata comes only from (a) a read/write grant, (b) `paths.stat` (`--stat`), (c) the ancestors rule below.
- **`stat(2)` on granted paths' ancestors (the last file rule in the profile):** `pathAncestors(p)` yields every directory above a granted path, and the final section grants `file-read-metadata` on all of them as `literal`s (never `subpath` — a stat-able ancestor must not drag its children in). Needed because a path lookup walks the chain: resolving `~/.config/clabox/mcp/<box>.json` touches `~/.config`, which the hard deny covers, so without a later metadata rule the box's own `--mcp-config` could fail on the way down. That's also why this rule is emitted **after** the hard deny and the clabox-home carve-out. Paths that already carry a read grant are skipped; roots of `regex` rules (notably `/private/var/folders`, the `$TMPDIR` container) are registered by hand, since a regex carries no path to walk up from. Net effect: `~/.ssh` is stat-able, `~/.ssh/id_ed25519` is not; `~/Library` is, `~/Library/Group Containers/<anything>` is not.
- **Read-only:** system dirs (`/System`, `/usr`, `/bin`, `/sbin`, `/Library/Frameworks`), Command Line Tools / Xcode, tzdata, system + user `Library/Preferences`, detected package paths, plus `paths.read`/`readOnly` (and any `--ro <path>` CLI grants appended to it).
- **Entropy devices (RO):** `/dev/random` + `/dev/urandom`. Language runtimes read these at startup — CPython seeds hash randomization from `/dev/urandom` and dies at preinit (`_Py_HashRandomization_Init: failed to get random numbers`) if it's denied; Node's `crypto`, openssl and git need it too. Granted read-only (writing to the entropy pool is never needed). The rest of `/dev` stays limited to `tty*`, `null`, `zero`, `dtracehelper`.
- **Read-write:** the project dir (`config.cwd` if set, else the shell CWD), the Claude config dir (`configDir`), `/tmp`, `/private/tmp`, `/private/var/folders/…`, `~/Library/Keychains` (OAuth refresh), plus `paths.write`/`readWrite` (and any `--rw <path>` CLI grants appended to it).
- **Claude runtime state & caches (RW):** `~/.local/state/claude` and `~/Library/Caches/claude-cli-nodejs`. Claude takes a version lock at startup (`~/.local/state/claude/locks/<version>.lock`, written via a `.lock.tmp.<rand>` sibling) and writes per-MCP-server log batches into `~/Library/Caches/claude-cli-nodejs`; a read-only grant surfaces in-box as `NON-FATAL: Lock acquisition failed` and `Dropping log batch for …`. Neither holds credentials — OAuth tokens live in the keychain — so RW here widens nothing that matters. `~/.cache/claude` stays read-only (nothing has been observed writing to it).
- **Package-manager caches (RW):** `~/.npm`. npm `mkdir`s `_cacache/tmp` on *every* invocation — `npm view` included — so read-only is not enough and a missing grant breaks npm outright. It's listed here mainly because npm **misreports the cause**: any EPERM under its cache produces `Your cache folder contains root-owned files, due to a bug in previous versions of npm … To permanently fix this problem, please run: sudo chown -R <uid>:<gid> "~/.npm"`, which sends you after a permissions problem that doesn't exist (the `chown` changes nothing, because the denial is the profile). No credentials live under `~/.npm` — registry auth tokens are in `~/.npmrc`, which this does not grant. Other package managers may need the same treatment per host; `~/.local` (mise, pipx) already comes in through `detectPackagePaths()`.
- **Signals, scoped to the box:** `(allow signal (target self) (target children) (target same-sandbox))`. Without any `signal` rule, `(deny default)` covers `kill(2)` too, so every process the agent spawned was immortal until the box exited — it could start `npm run dev` and never stop it. The `target` filter is what keeps the grant from being global: `children` covers direct spawns, `same-sandbox` the rest of the tree (the profile is inherited across `fork`/`exec` and **cannot be dropped**, so a grandchild — `npm` → `node` → `frpc` — is still confined to *this* box even after being reparented to launchd), and processes outside the box remain unsignalable. `(target others)` is what an unscoped grant would look like, and it is never emitted. The filter is undocumented by Apple — it is known from reverse-engineered notes, Chromium's `renderer.sb`, and Apple's own `application.sb`/`securityd.sb`/`WindowServer.sb` — so the boundary is pinned by a **functional test** that starts a process outside any sandbox and asserts a box cannot signal it, rather than by trusting the documentation. Alongside it, `(allow process-info-setcontrol (target self))` is `setpriority(2)`: zsh job control nices its background jobs, and without it a plain `cmd &` fails with `nice(5) failed: operation not permitted`. Note this grant only makes signalling *possible* — to *find* a pid the box also needs a runnable `ps`, which is what `sandbox/proctools.ts` installs.
- **Network, split by address family:** with `network: true` the profile emits `(allow network-outbound (remote ip))`, `(allow network-inbound (local ip))` and `(allow network-bind (local ip))` — IP in and out as before — and **never** the blanket `(allow network*)`. The reason is that `network*` is not "the internet": in Seatbelt a unix-socket `connect(2)` is authorized as `network-outbound` with a *path* filter (Apple writes it `(allow network-outbound (remote tcp) (literal "/private/var/run/mDNSResponder"))`), so the old single line granted every box every unix socket on the machine, with no file rule able to take it back — a box denied read, write *and* stat on `~/Library/Group Containers/<team>.com.1password` could still ask the ssh-agent inside it to sign, i.e. authenticate as the user. `/var/run/docker.sock` (root on the host) was reachable the same way.
- **Unix sockets are opt-in per path:** `paths.socket: ['/var/run/docker.sock']`, the per-path `'c'` right (`'/var/run/docker.sock': 'c'`), or `--socket <path>` on the CLI. Each entry is emitted as both `(literal …)` and `(subpath …)`, so naming either a socket file or a directory of sockets works. One path is allowlisted by default, because dropping it breaks something that doesn't look like a sandbox problem: `/private/var/run/mDNSResponder` (the system resolver — DNS failures read as "claude can't reach the API"). claude's daemon dir `/private/tmp/cc-daemon-<uid>` used to be the second one; it is now granted only when the box asks for the feature that needs it — `config.remoteControl` (what `--rc` sets) or `allowBackgroundTasks`. That dir is the channel to the singleton `claude daemon`, which runs outside every box and can re-host the session with `--fork-session --resume` and no profile. The escape itself is closed in the environment by `SANDBOX_ESCAPE_GUARDS` — but that guard is *cooperative*, living inside the very process the agent controls, so a box with no use for `/rc` should not be handed the channel either. Socket grants are emitted regardless of `config.network` (local IPC is not internet access), and a `paths.deny` entry also loses socket connect, because the soft deny tier now emits a matching `deny network-outbound`.
- **Glob read-deny (`paths.denyGlobs`):** gitignore-flavored patterns that deny **read** of matching files/dirs at any depth **inside the project dir**. **Empty by default** — it's opt-in per box, e.g. `['**/.env*', '!**/.env.example', '**/___*']` to hide every `.env*` secret (but keep the `.env.example` template) and any triple-underscore `___*` file. A `!`-prefixed pattern re-allows and the last match wins, exactly like `.gitignore`, so the order in `denyGlobs` is load-bearing. The pure `globToRegexBody(glob)` (in `profile.ts`) compiles one pattern to an SBPL regex body — `*` = a run of non-slash chars, `**` = any run, `?` = one non-slash char, every other metachar escaped; the caller anchors it under the project (`^<projectDir>/(.*/)?<body>(/|$)`) so a directory match also covers its contents. Emitted **after** the project RW grant (so it actually bites inside the project) but **before** the hard secret deny (so credentials stay supreme). It's **scoped to the project on purpose**: a global regex would also shadow the system runtimes granted earlier — e.g. a double-underscore `**/__*` vs CPython's `.../__init__.py` — and break them, since this is a *later* rule. The triple-underscore `___*` convention deliberately dodges those Python dunders (`__init__.py`, `__pycache__`), so it hides only your own private files. The patterns are pure data in the config; only the compiler is code.
- **Glob write-deny (`paths.denyWriteGlobs`) — the one deny tier with a non-empty default:** same compiler, same placement and the same `!`-re-allow as `denyGlobs`, but it denies `file-write*` only — the box keeps reading these files, it just cannot change them. The default is `DEFAULT_DENY_WRITE_GLOBS` = `['**/clabox.config.*', '**/.git/config', '**/.git/hooks', '**/.envrc']`, and what those four have in common is that **something outside the sandbox executes them later**, which turns a box-local write into unsandboxed code execution as the user: `clabox.config.*` is `import()`ed by the next `clabox` run before a profile exists (see `utils/trust.ts`); `.git/config` carries `core.pager`, `core.fsmonitor`, `core.sshCommand` and `core.hooksPath`, all of them commands git runs — a `[core] pager = sh -c '…'` fires on the user's next `git log`, in their own shell; `.git/hooks` is the same thing by its canonical name; `.envrc` is executed by direnv just for `cd`-ing into the directory. None of them is something an agent needs to write in order to do its work. Trade-off to know: `git worktree add`, `git submodule add` and `git remote add` write `.git/config` and will fail in-box — a box that needs them declares its own `denyWriteGlobs`.
- **`open` / Launch Services are off by default (`config.allowOpen`, `CLABOX_ALLOW_OPEN=1`):** `(allow lsopen)` and the Launch Services mach services (`com.apple.coreservices.launchservicesd`, `CoreServices.coreservicesd`, `lsd.modifydb`, `^com\.apple\.lsd(\..*)?$`) are emitted only for a box that opts in, and they are emitted **together** — the gate is enforced by the receiving service, so denying the operation while leaving its ports reachable would be half a fix. Why this belongs with `allowBackgroundTasks` rather than with the conveniences: `open` forks nothing in-box, it asks LaunchServices (which lives outside every sandbox) to start a target, and the target comes up under **launchd, PPID 1, with no Seatbelt profile**. The box can write `.app` bundles into `/tmp`, `$TMPDIR` and the project dir, so the two halves compose into arbitrary code execution as the user — measured: a three-line `Contents/MacOS/run` opened with `open -W` ran with `ppid 1` and wrote `$HOME/ESCAPE.txt`, a path the box cannot `touch` itself (and then could not `unlink`). Unlike the background-task escape it needs no running daemon, so it is always available. The same reasoning already kept `appleevent-send` out of the profile ("would let a sandboxed claude script your terminal"). `com.apple.lsd.mapdb` stays granted: it is the read-only type/UTI database many frameworks consult, and it cannot start anything. What to expect inside a box: no `open`, and `/login` cannot pop a browser — log in from an unsandboxed shell.
- **Two deny tiers** (Seatbelt evaluates rules in order — the *last* match wins — so placement is deliberate):
  - Both tiers deny `file-read*`, which **includes `file-read-metadata`** — so a deny takes `stat` away too, and the three access classes are symmetric with it. The extra grants are emitted in class order (`stat`, then `read`, then `write`) *after* the soft deny and *before* the hard one: a path listed in two classes resolves to the wider one (last match wins), a `--stat` can lift the soft deny, and nothing in any class can lift the hard one.
  - **Soft privacy deny (overridable):** `denyHome` (`~/Documents`, `~/Desktop`, …) and `paths.deny`, emitted *before* the extra `stat`/`read`/`write` grants and the project dir. An explicit grant therefore overrides it — handy for a project that lives under `~/Documents`, a debug box that wants `readOnly: ['/']` to roam the disk, or a **root box that wants `readWrite: ['/']`** to read *and write* anywhere on disk (the hard secret deny below still wins, so credentials and private keys stay protected even with a whole-disk RW grant).
  - **Hard secret deny (always wins):** `denyDotConfigs` (`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config`) and personal SSH keys `~/.ssh/id_*`, `*.pem`, `*.key`, emitted as the **last deny** — after every allow, the extra paths and the project dir. No `readOnly`/`readWrite` grant can re-expose these. Only the bot key subdir (`bot.sshDir`, not matched by the patterns) stays readable. (The `~/.config/git` RO carve-out is shadowed by the hard deny on `~/.config`; git still reads `~/.gitconfig` outside `~/.config`.)
  - **clabox-home RO carve-out (the only rule after the hard deny):** an `allow file-read*` plus an `allow process-exec` for `claboxHomeDir()` (`~/.config/clabox`, the parent of `configsDir()`). That tree holds clabox's **own** box configs and its compiled `--mcp-config`/`--settings` json, which the `~/.config` hard deny above would otherwise block; re-granting **read** (last match wins) lets the sandboxed claude load them, and the `process-exec` grant lets a box's hook scripts live there (e.g. a `notify.sh`) and actually run without a separate `paths.exec`.
    - **Read-only on purpose — the box cannot rewrite its own policy.** The box configs *are* the sandbox policy: a write grant here would let the sandboxed agent relax its own `paths`/`denyGlobs`/`claudeArgs` for the next run, which defeats the point of the box. Nothing in-box needs to write: clabox materializes the compiled `mcp`/`settings` json from **outside** the sandbox (`run.ts#writeExtraFiles`, before `claude` is spawned; `init` does the same via `scaffold.ts#materializeExtras`). To edit a box config, use an unsandboxed shell. A user `paths.readWrite` of `~/.config/clabox` can't reopen it either — that grant is emitted *before* the hard deny, so last-match-wins buries it.
    - It re-exposes exactly the `clabox` subdir and nothing credential-shaped (secrets come from `config.env`, not files), so the "credentials never readable" invariant still holds.
    - **Symlinked home:** the macOS sandbox matches rules against the *symlink-resolved* path (the reason both `/tmp` and `/private/tmp` are granted), so when `~/.config/clabox` is a symlink — e.g. relocated *into* a project repo so the box configs + compiled extras live in-tree — the files physically sit at the target and the nominal grant never matches, failing the in-box read with `EPERM`. `resolvedClaboxHome()` (in `profile.ts`) `realpath`s `claboxHomeDir()` and, when it differs, appends the resolved home to this carve-out; it returns `[]` when the home is absent or already canonical. (A relocated home that lives *inside the project dir* is still writable — but through the project's own RW grant, not through this rule.)

### Git/ssh bot identity
`ulimit -u <procs already running + ulimitProcs>` (fork-bomb guard, `0` to disable) — `resolveUlimit(headroom, {current, hard})` in `run.ts` makes the cap **relative**, because macOS counts `RLIMIT_NPROC` per *uid* machine-wide: a desktop login runs 1000+ processes, so an absolute `ulimit -u 1024` doesn't limit the box, it stops it forking at all (`security` never runs ⇒ `Not logged in` / `API Usage Billing`). Clamped to `kern.maxprocperuid`; with an unreadable process count no cap is set at all; `GIT_AUTHOR_*` / `GIT_COMMITTER_*` from `bot.name`/`bot.email`; if `bot.sshDir/id_ed25519` exists, `GIT_SSH_COMMAND` is pinned to it (`IdentitiesOnly=yes`, `IdentityAgent=none`); gpg signing disabled; `NPM_CONFIG_USERCONFIG=/dev/null`; `DISABLE_AUTOUPDATER=1`.

### Passing environment variables
`sandbox-exec` restricts files and network, not the environment, and `runClaude` spawns through `/bin/sh` without an `env` option — so the sandboxed `claude` **inherits the parent shell env** (e.g. `export GITHUB_TOKEN=… && clabox`). For a declarative alternative, `config.env` (a `KEY=VALUE` map) is appended **last** in `buildEnvArgs`, so it layers over both the inherited env and the built-in hardening vars and a colliding key wins. Don't hard-code secrets in a repo-committed `clabox.config.mjs` (the project dir is mounted RW and readable from inside): read them from `process.env`, or keep the config in `~/.config/clabox/config.mjs`. Anything in the env is readable by `claude` and, with `network: true`, exfiltratable.

## Lint

Biome (`biome.json`), scoped to `src/**/*.ts` + `tests/**/*.ts`:
- `recommended` preset; `noExplicitAny` and `noNonNullAssertion` off.
- `useImportExtensions` (error, `forceJsExtensions`) — relative imports must use `.js` specifiers. (It also rewrites a literal `.json` specifier to `.js`, which is why `info.ts` reads its own `package.json` by walking up from `import.meta.url` rather than `import`/`require`-ing it.)
- Formatter: 2-space indent, line width 100, single quotes, always semicolons.

## CI/CD

Both workflows run on `macos-latest` so the functional tests can exercise the real `sandbox-exec`.

- **`test.yml`** — on PR to `main`: checkout → setup Bun + Node 20 → `bun install --frozen-lockfile` → `bun run build` → `bun run test`.
- **`release.yml`** — on push to `main`: checkout (`fetch-depth: 0`) → setup Bun + Node 20 (`registry-url`) → install → build → test → `npx semantic-release`. Releases are **fully automatic**: semantic-release reads the Conventional Commits, decides the version, updates `CHANGELOG.md`, publishes to npm (provenance) + GitHub Releases, and commits the bump back with `[skip ci]`. Nobody bumps a version by hand.

## Size Limits

| Entry | Limit | Note |
|---|---|---|
| `lib/index.js` | 17 kB | brotlied, `node:*` ignored (the CLI bin uses top-level await and is not size-budgeted) |

The budget's job is to catch a dependency sneaking into the public bundle — it
is why `@lsk4/log` stays confined to `cli.ts`. It is *not* a cap on features, so
it has been raised deliberately as the policy layer grew: 11 → 15 kB with the
base-policy tables and per-path grants, 15 → 17 kB with `utils/trust.ts` and the
input validation (~2 kB of code, brotli-resistant because it's logic, not
prose — shortening the error messages recovered barely 100 B). Raise it when a
feature lands, never to make an import fit.

## Package Exports

```typescript
import { loadConfig, buildProfile, runClaude, runInit } from 'clabox'; // lib/index.js
import { gatherInfo, formatInfo, resolveClaboxPackage } from 'clabox'; // lib/index.js (info report)
import { runDaemon, buildDaemonArgs, buildDaemonEnv } from 'clabox';  // lib/index.js (unsandboxed daemon)
import { loadConfig, defaultConfig, mergeConfig } from 'clabox/config'; // lib/utils/config.js
import { buildProfile, detectPackagePaths } from 'clabox/profile';   // lib/sandbox/profile.js
import { generateProfile, profilePath, resolveProjectDir, runClaude } from 'clabox/run'; // lib/sandbox/run.js
// CLI entry: clabox/cli (lib/cli.js) — also the `clabox` bin
```

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | Claude config/profile dir (multi-account); passed through to `claude` | `~/.claude` |
| `CLABOX_CWD` | working dir to run `claude` in (also the RW project dir); `~` expanded | — (the shell CWD) |
| `CLABOX_CLAUDE_BIN` | path to the `claude` binary | PATH, then `~/.local/bin/claude` |
| `CLABOX_BOT_NAME` / `CLABOX_BOT_EMAIL` | git identity inside the sandbox | `claudeBOT` / `bot@example.com` |
| `CLABOX_BOT_SSH_DIR` | bot key dir (`id_ed25519`, `config`) | `~/.ssh/claudebot` |
| `CLABOX_CONFIG` | path to the JS config file (the `--config` flag overrides it) | — |
| `CLABOX_CONFIGS_DIR` | global dir of named boxes for `-b`/`--box <name>` (`<name>.config.mjs`) | `~/.config/clabox/configs` |
| `CLABOX_GHOSTTY_APP` | donor app cloned by `init` for `app` boxes (`config.appBuilder.ghosttyApp`) | `/Applications/Ghostty.app` |
| `CLABOX_APPS_DIR` | where `init` writes built `.app`s (`config.appBuilder.appsDir`) | `~/Applications` |
| `CLABOX_SIGN_ID` | codesign identity for built apps (`config.appBuilder.signId`); unset → ad-hoc | — |
| `CLABOX_GHOSTTY_BASE_CONFIG` | leading `config-file = …` in generated Ghostty configs | — |
| `CLABOX_CLABOX_BIN` | absolute `clabox` path to pin in the Ghostty `command` (`config.appBuilder.claboxBin`); unset → bare `clabox` (PATH-resolved at launch) | bare `clabox` |
| `CLABOX_TAB_TITLE` | fixed terminal-tab title (`config.tab.title`) | — (the `~`-shortened project dir) |
| `CLABOX_TAB_RC_BADGE` | title badge for a `--rc` tab (`config.tab.rcBadge`); empty value → no badge | `📡 RC` |
| `CLABOX_TAB_BACKGROUND` | tab background for every run (`config.tab.background`); empty → keep the terminal's own | — |
| `CLABOX_TAB_RC_BACKGROUND` | tab background for a `--rc` run (`config.tab.rcBackground`); empty → repaint off | `#5c1a00` |
| `CLABOX_TAB_FOREGROUND` / `CLABOX_TAB_RC_FOREGROUND` | text color (OSC 10) for every run / for `--rc` | — |
| `CLABOX_TAB_CURSOR` | cursor color (OSC 12) for every run (`config.tab.cursor`) | — |
| `CLABOX_TAB_RC_CURSOR` | cursor color for a `--rc` run (`config.tab.rcCursor`); empty → off | `#ff8c1a` |
| `CLABOX_TTY_GUARD` | `0` disables the `stty -echo` guard over the launch handoff (`sandbox/tty.ts`) | on |
| `CLABOX_STRICT_MCP` | `0` drops `--strict-mcp-config` (`config.strictMcp`), keeping the claude.ai cloud connectors next to the box's own `mcp` | strict |
| `CLABOX_NOTIFY` | `1` enables the in-sandbox OSC notifications (`config.notify.enabled`) | off |
| `CLABOX_NOTIFY_TITLE` | banner title (`config.notify.title`) | `Claude · <box>` |
| `CLABOX_ALLOW_BACKGROUND_TASKS` | `1` lets the box use claude's background tasks (`config.allowBackgroundTasks`) — **a sandbox escape**, see `sandbox/run.ts` | off |
| `CLABOX_ALLOW_OPEN` | `1` grants `lsopen` + the Launch Services mach services (`config.allowOpen`) — **a sandbox escape**: `open` starts processes outside the box | off |
| `CLABOX_REMOTE_CONTROL` | `1` grants claude's daemon socket (`config.remoteControl`), what `/rc` talks over; `--rc` sets it per launch | off |
| `CLABOX_TRUST` | `1` loads an untrusted / box-writable config file without `clabox trust` (same as `--trust`) | off |
| `CLABOX_DEBUG` | print profile/config/dir diagnostics on launch | — |
| `TMPDIR` | no longer holds the profile (it is passed inline); still the box's temp dir | `/tmp` |

## Limitations

- **macOS only** — needs `sandbox-exec` (Seatbelt). Formally deprecated, still works on macOS 14/15/26.
- **No nested sandbox** — you cannot launch the sandbox from inside another sandbox (`sandbox_apply: Operation not permitted`). Run from a bare host. (This also means the functional tests auto-skip when run *inside* a box: the security-relevant ones must be run on a plain host before trusting a profile change.)
- **Keychain is writable** for OAuth refresh (else tokens hit 401 after ~24h). For a stricter setup, swap the RW Keychain block for RO in `src/sandbox/profile.ts` (the "Keychain access" section).

### Residual risks — what a box can still do

These are known and currently accepted, so they belong in the threat model rather than in a wishlist. clabox is built to contain **accidents and casual reads**; an adversarial agent has the following left.

- **A box can read its own session token.** `security find-generic-password -s "Claude Code-credentials" -w` returns the full OAuth credential from inside the box, and outbound IP is granted, so it can be exfiltrated. This is partly inherent — claude has to refresh its own token — but the grant (`~/Library/Keychains` RW plus the `SecurityServer`/`security-agent` mach services) is wider than "my own item": other keychain items whose ACL admits `/usr/bin/security`, and the unlocked login keychain, are reachable the same way. Don't read the file denies as "the agent cannot get at any credential".
- **The background-task guard is cooperative.** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` lives in the environment of a process the agent controls, so it stops the feature, not a determined caller. The profile now withholds the daemon socket unless the box opts into `/rc` (`config.remoteControl`) or background tasks, which closes the channel rather than relying on the var — but a box that *does* use `/rc` has both the channel and a daemon that can re-host its session without a profile.
- **Escape hatches are real escapes.** `allowBackgroundTasks` and `allowOpen` each hand work to a process that does not carry the profile. `clabox info` prints them in the `escapes` row for exactly this reason; `(none)` is the default.
- **The agent writes the project, and the project is code.** The write-deny globs cover the paths that are executed *outside* the box by convention (`clabox.config.*`, `.git/config`, `.git/hooks`, `.envrc`), but a repo has many other ways to run code when a human next touches it — `package.json` scripts, a `Makefile`, a test helper, a CI workflow. Reviewing the diff is still the control there, and no sandbox replaces it.
- **Terminal and clipboard.** The terminal protocol is bidirectional and the emulator runs outside the box; `init`-generated app configs set `clipboard-read = deny` + `title-report = false`, but a box you run in your *own* terminal inherits whatever that terminal allows.
