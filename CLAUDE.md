# clabox

> **This file contains instructions for AI assistants (Claude).** For project documentation see [docs/guideline.md](docs/guideline.md).

Run Claude Code in a sandbox for super-safe YOLO mode, configured in plain JavaScript.

**Important:**
- **ALWAYS** update this file and docs/guideline.md when changing scripts, structure, dependencies, commands, env vars, or the generated SBPL rules — do it in the same step, not after
- Run `bun run fix` and `bun run test` after each code change
- **Before saying "done"**, run the full `bun run test` (lint + types + unit + size). Functional tests shell out to real `sandbox-exec` and auto-skip off macOS or when nested in a sandbox — on macOS they must run, not be skipped
- Always write tests for new functionality — for profile changes, assert the generated SBPL text in `tests/profile.test.ts`
- Never invent SBPL rules: the profile must pass `sandbox-exec` validation. Test profile changes against real `sandbox-exec`
- Default to **Bun** for dev/test/build. The published `lib/` is plain ESM that runs on **Node ≥ 18**; the only runtime dependency is `yargs`

## Main Commands
```bash
bun install              # install deps (lockfile: bun.lock)
bun run build            # tsdown → lib/ (ESM + .d.ts + sourcemaps)
bun run test             # lint + types + unit + size (run before "done")
bun run fix              # biome check --write (format + lint + import order)
bun test                 # unit only (bun:test)
bun run cli -- profile   # run the CLI from source (also: generate, run, init)
bun run cli -- init      # gen clabox-<name> aliases + build Ghostty apps for `app` boxes
bun run cli -- init --no-apps        # aliases only (skip the Ghostty-app build)
bun run cli -- init --app "AX Manager" # (re)build just one app box
bun run cli -- -b ax-root # run a named box from ~/.config/clabox/configs/*.config.mjs
```

## Structure

**Rule:** Only entry-point files live in `src/` root — `index.ts` (public API aggregator) and `cli.ts` (the CLI, built to `lib/cli.js` = the `clabox` bin). All other code lives in subdirectories. The build emits to `lib/`; `bin`/`main`/`exports` point at built `lib/*.js`.

```
src/
├── index.ts              # public API aggregator — re-exports config/profile/run/init
├── cli.ts                # CLI entry (yargs): run / generate / profile / init → lib/cli.js
├── sandbox/
│   ├── profile.ts        # pure SBPL profile builder + package-manager autodetect
│   ├── extras.ts         # pure: compile per-box `mcp`/`systemPrompt` → claude args + files
│   └── run.ts            # I/O: locate claude/sandbox-exec, write profile + extras, launch it
├── init/
│   ├── aliases.ts        # pure builder for the `clabox init` shell aliases (text only)
│   ├── ghostty.ts        # pure builders: Ghostty config text + C launcher source + app paths
│   ├── raycast.ts        # pure builder for the per-app Raycast script command (text only)
│   ├── app.ts            # I/O (macOS): clone Ghostty.app, swap binary, icon, codesign
│   └── scaffold.ts       # I/O: discover <base>/configs boxes, (re)write <base>/scripts/*, build apps
└── utils/
    └── config.ts         # defaults, env overrides, JS config load/merge, ~ expansion, box resolution
tests/
├── profile.test.ts       # bun:test — unit (profile text) + functional (real sandbox-exec)
├── init.test.ts          # bun:test — alias/ghostty text + scaffold & app boxes (tmp-dir fs)
├── extras.test.ts        # bun:test — per-box mcp/systemPrompt → claude args + mcp json
└── box.test.ts           # bun:test — named-box resolution (tmp-dir fs)
clabox.config.example.mjs  # copyable user config
```

## Key Architecture
- **4 CLI commands** (`run` / `generate` / `profile` / `init`) over a pure builder (`sandbox/profile.ts`) and an I/O launcher (`sandbox/run.ts`) — keep that pure/I-O split
- `init` mirrors that split: `init/aliases.ts` + `init/ghostty.ts` are the pure text builders, `init/scaffold.ts` + `init/app.ts` do the fs/exec I/O. It discovers boxes in `<dir>/configs` (default `<dir>` = `defaultBaseDir()` = the parent of the global `configsDir()`, i.e. `~/.config/clabox`, honoring `CLABOX_CONFIGS_DIR`; overridable via `--dir` for a project-local `<dir>/configs` layout) via the same `listBoxes` rules as `-b` (both `<name>.mjs`/`<name>.config.mjs`, `_`-partials skipped) and (re)writes `<dir>/scripts/`: a source-able `index.sh` plus one `clabox-<name>.sh` wrapper per box. Each command runs `clabox -b <name>` — yolo vs. safe is decided by the box's own preset (`claudeArgs`), **not** by `init`. It prunes its own stale artifacts (`index.sh`, `clabox-*.sh`) on each run. **Paths are resolved at run time, not frozen at init time**: the `clabox` command is emitted bare so the shell's PATH resolves it at launch (survives package-manager moves, e.g. bun → npm/homebrew); `CLABOX_CONFIGS_DIR=<dir>` is baked **only when `<dir>/configs` doesn't already resolve (realpath, symlinks included) to the runtime default `~/.config/clabox/configs`** (`bakeConfigsDir`) — when it does, the prefix is omitted and `-b` finds the box via the default. The project `cd` dir stays absolute (it doesn't move with the package manager). An explicit `appBuilder.claboxBin` still pins an absolute binary path
- **Ghostty apps from `init`**: a box opts in by carrying an `app` object (`AppConfig`) in its config — only then does `init` `loadConfig` that box, write a Ghostty config to `<dir>/ghostty/<name>.config` (a `command = zsh -lic '…'` — login+interactive so the GUI app inherits the user's PATH, not launchd's minimal one — that `cd`s into `config.cwd` and runs `clabox -b <name>`, plus `title`/`macos-icon`/extra lines from `app`), and build a cloned `<appsDir>/<name>.app` (replacing the old `ghostty-app-builder.sh`). The clone steps live in `init/app.ts` (macOS-only): extract entitlements, `cp -R` Ghostty.app, patch `Info.plist`, swap the binary for a compiled C launcher (`init/ghostty.ts#buildLauncherSource`, bakes `--config-file=<config>`), set the icon (`.icns` copy or `.png`→`sips`+`iconutil`, then `plutil -remove CFBundleIconName` so macOS uses our loose `.icns` instead of the icon baked into Ghostty's `Assets.car`), disable Sparkle, `codesign` (`appBuilder.signId` or ad-hoc `-`). Machine-wide build settings live in `config.appBuilder`. It also writes a Raycast script command per app box to `<dir>/raycast/<name>.sh` (`init/raycast.ts#buildRaycastCommand`: `@raycast.*` metadata + `open <appPath>`; icon = `app.emoji` → the title's leading emoji → 👻). `--no-apps` skips the build; `--app <box|name>` (re)builds one. Builds are best-effort: if the host can't build (`canBuildApps`: not macOS / no Ghostty / no `cc`) or a build throws, it records a warning and still emits the aliases (and the ghostty config + raycast script, which point at where the app will live). It prunes its own `<dir>/ghostty/*.config` and `<dir>/raycast/*.sh` on a full run (not with `--app`, which would orphan other apps' artifacts). `.app` bundles are **not** auto-deleted
- The Seatbelt profile starts with `(deny default)` — nothing is allowed unless an explicit rule grants it
- Config resolution, later wins: **defaults → env vars → JS config file** (`./clabox.config.mjs` or `~/.config/clabox/config.mjs`, or `CLABOX_CONFIG`, or the `--config` CLI flag which overrides `CLABOX_CONFIG`)
- `config.cwd` (env `CLABOX_CWD`, `~`-expanded → absolute; default null → shell CWD) sets the dir `claude` runs in and the dir granted RW as the project. `resolveProjectDir(config)` in `sandbox/run.ts` computes it; `runClaude`/`generateProfile`/`profile` all key off it (and `spawnSync` runs with that `cwd`). Useful for named boxes that always target one project regardless of where `clabox` is invoked
- **Per-box MCP & pre-prompt** (one shared `configDir`, separate MCP/system-prompt per box): user config stays pure data — `config.mcp` (a `Record<string, McpServer>`) and `config.systemPrompt` (`string | string[]`). `sandbox/extras.ts` is the pure builder: `buildBoxExtras(config, slug)` compiles `mcp` to `<configDir>/mcp/<slug>.json` and emits `--strict-mcp-config --mcp-config <file>` (so a shared configDir's *global/plugin* MCP servers are ignored — each box gets exactly its own), and appends `systemPrompt` inline via `--append-system-prompt` (no file). `slug` = `boxSlug(configFile, projectDir)` (config-file basename sans `.config.mjs`/`.mjs`, else project-dir basename). The json lives under `configDir` precisely because the sandbox grants it RW (and `~/.config/*` is hard-denied, so it can't live next to the box config). Materialized both at **run** (`run.ts#writeExtraFiles`, args spliced after `config.claudeArgs`, before CLI args) and at **init** (`scaffold.ts#materializeExtras`, slug = box name, best-effort per box). Arrays *replace* on merge, so presets can't pre-seed `mcp`; declare it on the box
- **Named boxes** (`-b`/`--box <name>`): resolve `<name>` to a config file in the global configs dir (`~/.config/clabox/configs/<name>.config.mjs`, falling back to `<name>.mjs`; dir overridable via `CLABOX_CONFIGS_DIR`) and feed it to `loadConfig` as the explicit config — so `-b` is a global shortcut that wins over `--config`. `_`-prefixed files are shared partials (e.g. `_presets.mjs`), not boxes. `resolveBox`/`listBoxes`/`configsDir` live in `utils/config.ts`. (`init` defaults to the same global dir — `defaultBaseDir()` = the parent of `configsDir()` — so it works from any cwd; pass `--dir` for a project-local `<dir>/configs` layout.)
- Two deny tiers (SBPL = last matching rule wins, so order is load-bearing): a **soft** privacy deny (`denyHome` dirs + `paths.deny`) is emitted *before* the extra `readOnly`/`readWrite` and the project dir, so an explicit grant may override it (e.g. a project under `~/Documents`, or a broad `readOnly` for a debug box); a **hard** secret deny (`~/.ssh/id_*`, `*.pem`, `*.key`, `denyDotConfigs` credential dirs) is emitted as the **very last file rule**, after every allow, so it always wins — personal credentials are never readable however wide the grants. Only the bot key subdir (not matched by the patterns) stays readable
- Profiles are deterministic per project: `$TMPDIR/clabox-<dir>-<hash>.sb` (sha256 of the absolute project path)
- Tool-owned env vars use the `CLABOX_` prefix; `CLAUDE_CONFIG_DIR` is Claude's own var, passed straight through to `claude`. The app builder adds `CLABOX_GHOSTTY_APP`, `CLABOX_APPS_DIR`, `CLABOX_SIGN_ID`, `CLABOX_GHOSTTY_BASE_CONFIG`, `CLABOX_CLABOX_BIN` (defaults for `config.appBuilder`)
- The sandboxed `claude` inherits the shell env (sandbox-exec filters files/network, not env). `config.env` declares extra `KEY=VALUE` vars (e.g. `GITHUB_TOKEN`), appended last in `buildEnvArgs` so they win over the built-in hardening vars

## Dependencies
- `yargs` — CLI command/flag parsing (the only runtime dependency)
- Node built-ins otherwise: `fs`, `path`, `os`, `crypto`, `child_process`, `url`
- Dev: `tsdown` (build), `@biomejs/biome` (lint/format), `typescript`, `size-limit`, `semantic-release`

## Testing
- Framework: `bun:test` (`tests/` via `bunfig.toml`), run with `bun test` or `bun run test:unit`
- **Unit** tests check the generated SBPL text and run anywhere. **Functional** tests run a real `sandbox-exec` against a generated profile (`test.skipIf` auto-skips off macOS or when nested in a sandbox)

## More Info
- Full guideline available at [docs/guideline.md](docs/guideline.md)
