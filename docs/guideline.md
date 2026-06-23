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
| Size budget | size-limit | `@size-limit/preset-small-lib`, `lib/index.js` |
| Release | semantic-release | fully automatic on push to `main` |
| CI/CD | GitHub Actions | `macos-latest` (real `sandbox-exec`) |
| CLI | yargs ^17 | the only runtime dependency |
| Sandbox | macOS `sandbox-exec` (Seatbelt/SBPL) | profile generated as plain text |

## Project Structure

**Rule:** Only entry-point files live in `src/` root — `index.ts` (public API aggregator) and `cli.ts` (the CLI, built to `lib/cli.js` = the `clabox` bin). All other code lives in subdirectories. The build emits to `lib/`; `bin`/`main`/`exports` point at built `lib/*.js`.

```
src/
├── index.ts              # public API aggregator — re-exports config / profile / run / init
├── cli.ts                # CLI entry (yargs): run / generate / profile / init → lib/cli.js (bin)
├── sandbox/
│   ├── profile.ts        # pure SBPL builder: buildProfile, detectPackagePaths,
│   │                     #   subpath/literal/regex/globalName/ipcName/reEscape helpers
│   └── run.ts            # I/O: profilePath, generateProfile, runClaude (sandbox-exec launch)
├── init/
│   ├── aliases.ts        # pure: aliasName, buildIndex, buildWrapper, buildAliasFiles
│   ├── ghostty.ts        # pure: buildGhosttyConfig, buildCommand, buildLauncherSource,
│   │                     #   appBundlePath, bundleId
│   ├── raycast.ts        # pure: buildRaycastCommand, raycastIcon
│   ├── app.ts            # I/O (macOS): buildApp, canBuildApps (clone Ghostty.app + sign)
│   └── scaffold.ts       # I/O: discoverProfiles, runInit (scan configs → scripts + apps + raycast)
└── utils/
    └── config.ts         # defaultConfig, expandHome, mergeConfig, findConfigFile, loadConfig,
                          #   configsDir/resolveBox/listBoxes (named-box resolution)
tests/
├── profile.test.ts       # bun:test — unit (profile text) + functional (real sandbox-exec)
├── init.test.ts          # bun:test — alias/ghostty text + scaffold & app boxes (tmp-dir fs)
└── box.test.ts           # bun:test — named-box resolution (tmp-dir fs)
lib/                      # build output (tsdown) — gitignored
docs/
├── guideline.md          # this file
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
bun run generate              # bun run src/cli.ts generate (build a profile, print its path)
bun run cli -- init           # aliases per box + build Ghostty apps for `app` boxes
bun run cli -- init --no-apps # aliases only (skip the Ghostty-app build)
bun run cli -- init --app "AX Manager"  # (re)build just one app box

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
Builds the effective config in three layers (later wins): `defaultConfig` → env vars → a JS config file. `findConfigFile(explicit?)` looks up the explicit path (the `--config` CLI flag, falling back to `CLABOX_CONFIG`) → `./clabox.config.mjs` / `./clabox.config.js` → `~/.config/clabox/config.mjs`; the `--config` flag wins over `CLABOX_CONFIG`. `loadConfig(explicit?)` forwards that path, dynamically imports the file and accepts either a plain object (merged via `mergeConfig`, a deep merge over the defaults) or a function `(defaults) => config`. `expandHome()` expands a leading `~`. Exports the `Config`/`BotConfig`/`PathRules`/`LoadedConfig` types.

**Named boxes.** `configsDir()` returns the global box dir (`~/.config/clabox/configs`, overridable via `CLABOX_CONFIGS_DIR`). `resolveBox(name, dir?)` maps a name to its config file there, preferring `<name>.config.mjs` over a bare `<name>.mjs` and throwing (with the available boxes listed) when none exists; a `_`-prefixed name is refused (it's a shared partial, not a box), so `-b` matches exactly what `listBoxes` advertises. `listBoxes(dir?)` returns the sorted, de-duplicated box names, skipping `_`-prefixed shared partials (e.g. `_presets.mjs`). The CLI's `-b`/`--box <name>` flag resolves the name and feeds the path to `loadConfig` as the explicit config (so `-b` wins over `--config`).

### `sandbox/profile.ts` (pure)
Assembles the SBPL profile text from typed helpers (`subpath`, `literal`, `regex`, `globalName`, `ipcName`, `reEscape`) — no I/O beyond `fs.existsSync` for autodetection. `detectPackagePaths()` finds installed package managers (Homebrew `/opt/homebrew` or `/usr/local/Homebrew`, `~/.local`, Nix `/nix/store`) to grant read/exec. `buildProfile(config, { projectDir, detectedPaths })` returns the full profile and sanity-checks it carries `(version 1)`.

### `sandbox/run.ts` (I/O)
`profilePath()` returns the deterministic `$TMPDIR/clabox-<dir>-<hash>.sb` path. `resolveProjectDir(config)` returns the effective project dir — `config.cwd` (with `~` expanded) when set, else `process.cwd()` — and is what `generateProfile`/`runClaude` default to. `generateProfile()` requires `sandbox-exec`, builds the profile and writes it. `runClaude()` resolves the project dir + `claude` binary (config → PATH → `~/.local/bin/claude`), forces the bot git identity + hardening env (`buildEnvArgs`, with `config.env` appended last so it wins), sets the terminal title, and execs `sh -c 'ulimit -u N; exec sandbox-exec -f <sb> env … claude …'` **in the resolved project dir** (`spawnSync` `cwd`), returning the exit code.

### `init/aliases.ts` (pure) + `init/scaffold.ts` (I/O)
`clabox init` turns a directory of box configs into ready-to-use shell commands. `aliases.ts` is pure text: `aliasName(profile)` yields `clabox-<name>`; `buildIndex()` renders the source-able `index.sh` (a `_clabox_run` helper that runs `CLABOX_CONFIGS_DIR=<configsDir> clabox -b "$1"` plus one function per box); `buildWrapper()` renders a standalone `.sh` that sources `index.sh` and calls one function; `buildAliasFiles()` returns the full file set. There is **one command per box** — yolo vs. safe is decided by the box's own preset (`claudeArgs`), not by a `-safe` alias. `scaffold.ts` does the I/O: `discoverProfiles(configsDir)` returns the sorted box names via `listBoxes` (both `<name>.mjs`/`<name>.config.mjs`, `_`-partials skipped; throws if the dir is missing or has no boxes), and `runInit({ baseDir, buildApps, only })` (async) resolves `<baseDir>/configs` + `<baseDir>/scripts` (default `<cwd>/__`), prunes its own prior artifacts (`index.sh`, `clabox-*.sh`), then writes the new ones `chmod +x`. Absolute paths are baked in so the scripts run from any cwd. It returns `{ profiles, written, apps, ghosttyConfigs, warnings, … }`.

### `init/ghostty.ts` + `init/raycast.ts` (pure) + `init/app.ts` (I/O) — standalone Ghostty apps
A box becomes a real macOS app by carrying an `app` object (`AppConfig`: `name`, `title?`, `emoji?`, `icon?`, `macosIcon?`, `ghostty?`, `bundleId?`). When `runInit` runs with `buildApps` (the default), it `loadConfig`s each box and, for every box with an `app`, writes `<baseDir>/ghostty/<name>.config`, a `<baseDir>/raycast/<name>.sh` Raycast command, and clones a `.app`. `ghostty.ts` is pure text: `buildGhosttyConfig()` renders the config (a `command = bash -c 'cd <cwd> && CLABOX_CONFIGS_DIR=<dir> <claboxBin> -b <name>; exec zsh'` plus `title`/`macos-icon`/extra `app.ghostty` lines and an optional leading `config-file`); `buildLauncherSource()` renders a tiny C launcher that finds `ghostty.real` next to itself and re-execs it with `--config-file=<config>` baked in; `appBundlePath()`/`bundleId()` derive the bundle path/id. `raycast.ts` renders the Raycast script command (`buildRaycastCommand()`: `@raycast.*` metadata + `open <appPath>`; `raycastIcon()` picks `app.emoji`, else the title's leading emoji, else 👻). `app.ts` is the macOS-only I/O (replaces the old `ghostty-app-builder.sh`): `canBuildApps(builder)` gates on darwin + donor app + `cc`; `buildApp()` extracts the donor's entitlements, `cp -R` clones Ghostty.app into `<appsDir>/<name>.app`, patches `Info.plist` (identity + Sparkle off), swaps the binary for the compiled launcher, installs the icon (`.icns` copy or `.png`→`sips`+`iconutil`), and `codesign`s (`appBuilder.signId`, else ad-hoc `-`). Machine-wide build settings live in `config.appBuilder` (`ghosttyApp`, `appsDir`, `signId`, `baseGhosttyConfig`, `claboxBin`). Builds are best-effort: a non-buildable host or a thrown build records a `warning` and the aliases (plus the ghostty config + raycast script) are still emitted. `init` prunes its own `<baseDir>/ghostty/*.config` and `<baseDir>/raycast/*.sh` on a full run (not under `--app`, which would orphan other apps' artifacts); built `.app` bundles are **not** auto-deleted.

### `cli.ts`
The yargs CLI (`scriptName('clabox')`). Commands: `run [claudeArgs..]` (default), `generate`, `profile`, `init`. `unknown-options-as-args` keeps unknown flags as positionals so they pass straight through to `claude` (e.g. `--dangerously-skip-permissions`). clabox-owned flags: `--config <path>` (a JS config file that overrides `CLABOX_CONFIG`) and `-b`/`--box <name>` (a named box from the global configs dir; resolved via `resolveBox` and winning over `--config`) — both forwarded to `loadConfig()` by `run` and `generate` through the `explicitConfig(argv)` helper. (`-b` deliberately avoids `-p`/`-c`/`-r`/`-d`/`-v`, which are claude's own `--print`/`--continue`/`--resume`/`--debug`/`--verbose`.) `init` takes `--dir <path>` (the base dir holding `configs/` and `scripts/`, default `./__`), `--no-apps` (skip the Ghostty-app build), and `--app <box|name>` ((re)build a single app box, by box name or `app.name`).

### What the profile allows and denies
- **Read-only:** system dirs (`/System`, `/usr`, `/bin`, `/sbin`, `/Library/Frameworks`), Command Line Tools / Xcode, tzdata, system + user `Library/Preferences`, detected package paths.
- **Read-write:** the project dir (`config.cwd` if set, else the shell CWD), the Claude config dir (`configDir`), `/tmp`, `/private/tmp`, `/private/var/folders/…`, `~/Library/Keychains` (OAuth refresh), plus `paths.readWrite`.
- **Network:** `(allow network*)` when `network: true` (default).
- **Two deny tiers** (Seatbelt evaluates rules in order — the *last* match wins — so placement is deliberate):
  - **Soft privacy deny (overridable):** `denyHome` (`~/Documents`, `~/Desktop`, …) and `paths.deny`, emitted *before* the extra `readOnly`/`readWrite` and the project dir. An explicit grant therefore overrides it — handy for a project that lives under `~/Documents`, or a debug box that wants `readOnly: ['/']` to roam the disk.
  - **Hard secret deny (always wins):** `denyDotConfigs` (`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config`) and personal SSH keys `~/.ssh/id_*`, `*.pem`, `*.key`, emitted as the **very last file rule** — after every allow, the extra paths and the project dir. No `readOnly`/`readWrite` grant can re-expose these. Only the bot key subdir (`bot.sshDir`, not matched by the patterns) stays readable. (The `~/.config/git` RO carve-out is shadowed by the hard deny on `~/.config`; git still reads `~/.gitconfig` outside `~/.config`.)

### Git/ssh bot identity
`ulimit -u <ulimitProcs>` (fork-bomb guard, `0` to disable); `GIT_AUTHOR_*` / `GIT_COMMITTER_*` from `bot.name`/`bot.email`; if `bot.sshDir/id_ed25519` exists, `GIT_SSH_COMMAND` is pinned to it (`IdentitiesOnly=yes`, `IdentityAgent=none`); gpg signing disabled; `NPM_CONFIG_USERCONFIG=/dev/null`; `DISABLE_AUTOUPDATER=1`.

### Passing environment variables
`sandbox-exec` restricts files and network, not the environment, and `runClaude` spawns through `/bin/sh` without an `env` option — so the sandboxed `claude` **inherits the parent shell env** (e.g. `export GITHUB_TOKEN=… && clabox`). For a declarative alternative, `config.env` (a `KEY=VALUE` map) is appended **last** in `buildEnvArgs`, so it layers over both the inherited env and the built-in hardening vars and a colliding key wins. Don't hard-code secrets in a repo-committed `clabox.config.mjs` (the project dir is mounted RW and readable from inside): read them from `process.env`, or keep the config in `~/.config/clabox/config.mjs`. Anything in the env is readable by `claude` and, with `network: true`, exfiltratable.

## Lint

Biome (`biome.json`), scoped to `src/**/*.ts` + `tests/**/*.ts`:
- `recommended` preset; `noExplicitAny` and `noNonNullAssertion` off.
- `useImportExtensions` (error, `forceJsExtensions`) — relative imports must use `.js` specifiers.
- Formatter: 2-space indent, line width 100, single quotes, always semicolons.

## CI/CD

Both workflows run on `macos-latest` so the functional tests can exercise the real `sandbox-exec`.

- **`test.yml`** — on PR to `main`: checkout → setup Bun + Node 20 → `bun install --frozen-lockfile` → `bun run build` → `bun run test`.
- **`release.yml`** — on push to `main`: checkout (`fetch-depth: 0`) → setup Bun + Node 20 (`registry-url`) → install → build → test → `npx semantic-release`. Releases are **fully automatic**: semantic-release reads the Conventional Commits, decides the version, updates `CHANGELOG.md`, publishes to npm (provenance) + GitHub Releases, and commits the bump back with `[skip ci]`. Nobody bumps a version by hand.

## Size Limits

| Entry | Limit | Note |
|---|---|---|
| `lib/index.js` | 10 kB | brotlied, `node:*` ignored (the CLI bin uses top-level await and is not size-budgeted) |

## Package Exports

```typescript
import { loadConfig, buildProfile, runClaude, runInit } from 'clabox'; // lib/index.js
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
| `CLABOX_HOOKS_DIR` | hooks dir (RO + exec inside the sandbox) | — (off) |
| `CLABOX_GHOSTTY_APP` | donor app cloned by `init` for `app` boxes (`config.appBuilder.ghosttyApp`) | `/Applications/Ghostty.app` |
| `CLABOX_APPS_DIR` | where `init` writes built `.app`s (`config.appBuilder.appsDir`) | `~/Applications` |
| `CLABOX_SIGN_ID` | codesign identity for built apps (`config.appBuilder.signId`); unset → ad-hoc | — |
| `CLABOX_GHOSTTY_BASE_CONFIG` | leading `config-file = …` in generated Ghostty configs | — |
| `CLABOX_CLABOX_BIN` | `clabox` path baked into the Ghostty `command` (`config.appBuilder.claboxBin`) | autodetect |
| `CLABOX_DEBUG` | print profile/config/dir diagnostics on launch | — |
| `TMPDIR` | where the generated profile is stored | `/tmp` |

## Limitations

- **macOS only** — needs `sandbox-exec` (Seatbelt). Formally deprecated, still works on macOS 14/15.
- **No nested sandbox** — you cannot launch the sandbox from inside another sandbox (`sandbox_apply: Operation not permitted`). Run from a bare host.
- **Keychain is writable** for OAuth refresh (else tokens hit 401 after ~24h). For a stricter setup, swap the RW Keychain block for RO in `src/sandbox/profile.ts` (the "Keychain access" section).
