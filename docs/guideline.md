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
├── index.ts              # public API aggregator — re-exports config / profile / run
├── cli.ts                # CLI entry (yargs): run / generate / profile → lib/cli.js (bin)
├── sandbox/
│   ├── profile.ts        # pure SBPL builder: buildProfile, detectPackagePaths,
│   │                     #   subpath/literal/regex/globalName/ipcName/reEscape helpers
│   └── run.ts            # I/O: profilePath, generateProfile, runClaude (sandbox-exec launch)
└── utils/
    └── config.ts         # defaultConfig, expandHome, mergeConfig, findConfigFile, loadConfig
tests/
└── profile.test.ts       # bun:test — unit (profile text) + functional (real sandbox-exec)
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

### `sandbox/profile.ts` (pure)
Assembles the SBPL profile text from typed helpers (`subpath`, `literal`, `regex`, `globalName`, `ipcName`, `reEscape`) — no I/O beyond `fs.existsSync` for autodetection. `detectPackagePaths()` finds installed package managers (Homebrew `/opt/homebrew` or `/usr/local/Homebrew`, `~/.local`, Nix `/nix/store`) to grant read/exec. `buildProfile(config, { projectDir, detectedPaths })` returns the full profile and sanity-checks it carries `(version 1)`.

### `sandbox/run.ts` (I/O)
`profilePath()` returns the deterministic `$TMPDIR/clabox-<dir>-<hash>.sb` path. `generateProfile()` requires `sandbox-exec`, builds the profile and writes it. `runClaude()` resolves the `claude` binary (config → PATH → `~/.local/bin/claude`), forces the bot git identity + hardening env (`buildEnvArgs`), sets the terminal title, and execs `sh -c 'ulimit -u N; exec sandbox-exec -f <sb> env … claude …'`, returning the exit code.

### `cli.ts`
The yargs CLI (`scriptName('clabox')`). Commands: `run [claudeArgs..]` (default), `generate`, `profile`. `unknown-options-as-args` keeps unknown flags as positionals so they pass straight through to `claude` (e.g. `--dangerously-skip-permissions`). The one clabox-owned flag is `--config <path>` (a JS config file that overrides `CLABOX_CONFIG`), forwarded to `loadConfig()` by `run` and `generate`.

### What the profile allows and denies
- **Read-only:** system dirs (`/System`, `/usr`, `/bin`, `/sbin`, `/Library/Frameworks`), Command Line Tools / Xcode, tzdata, system + user `Library/Preferences`, detected package paths.
- **Read-write:** the project dir (CWD), the Claude config dir (`configDir`), `/tmp`, `/private/tmp`, `/private/var/folders/…`, `~/Library/Keychains` (OAuth refresh), plus `paths.readWrite`.
- **Network:** `(allow network*)` when `network: true` (default).
- **Explicit deny — wins over the allows:** `denyHome` (`~/Documents`, `~/Desktop`, …), `denyDotConfigs` (`~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.config`) with a carve-out for `~/.config/git`, and personal SSH keys `~/.ssh/id_*`, `*.pem`, `*.key`. Only the bot key subdir (`bot.sshDir`) is readable.

### Git/ssh bot identity
`ulimit -u <ulimitProcs>` (fork-bomb guard, `0` to disable); `GIT_AUTHOR_*` / `GIT_COMMITTER_*` from `bot.name`/`bot.email`; if `bot.sshDir/id_ed25519` exists, `GIT_SSH_COMMAND` is pinned to it (`IdentitiesOnly=yes`, `IdentityAgent=none`); gpg signing disabled; `NPM_CONFIG_USERCONFIG=/dev/null`; `DISABLE_AUTOUPDATER=1`.

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
import { loadConfig, buildProfile, runClaude } from 'clabox';        // lib/index.js
import { loadConfig, defaultConfig, mergeConfig } from 'clabox/config'; // lib/utils/config.js
import { buildProfile, detectPackagePaths } from 'clabox/profile';   // lib/sandbox/profile.js
import { generateProfile, profilePath, runClaude } from 'clabox/run'; // lib/sandbox/run.js
// CLI entry: clabox/cli (lib/cli.js) — also the `clabox` bin
```

## Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `CLAUDE_CONFIG_DIR` | Claude config/profile dir (multi-account); passed through to `claude` | `~/.claude` |
| `CLABOX_CLAUDE_BIN` | path to the `claude` binary | PATH, then `~/.local/bin/claude` |
| `CLABOX_BOT_NAME` / `CLABOX_BOT_EMAIL` | git identity inside the sandbox | `claudeBOT` / `bot@example.com` |
| `CLABOX_BOT_SSH_DIR` | bot key dir (`id_ed25519`, `config`) | `~/.ssh/claudebot` |
| `CLABOX_CONFIG` | path to the JS config file (the `--config` flag overrides it) | — |
| `CLABOX_HOOKS_DIR` | hooks dir (RO + exec inside the sandbox) | — (off) |
| `CLABOX_DEBUG` | print profile/config/dir diagnostics on launch | — |
| `TMPDIR` | where the generated profile is stored | `/tmp` |

## Limitations

- **macOS only** — needs `sandbox-exec` (Seatbelt). Formally deprecated, still works on macOS 14/15.
- **No nested sandbox** — you cannot launch the sandbox from inside another sandbox (`sandbox_apply: Operation not permitted`). Run from a bare host.
- **Keychain is writable** for OAuth refresh (else tokens hit 401 after ~24h). For a stricter setup, swap the RW Keychain block for RO in `src/sandbox/profile.ts` (the "Keychain access" section).
