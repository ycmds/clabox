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
bun run cli -- profile   # run the CLI from source (also: generate, run)
```

## Structure

**Rule:** Only entry-point files live in `src/` root — `index.ts` (public API aggregator) and `cli.ts` (the CLI, built to `lib/cli.js` = the `clabox` bin). All other code lives in subdirectories. The build emits to `lib/`; `bin`/`main`/`exports` point at built `lib/*.js`.

```
src/
├── index.ts              # public API aggregator — re-exports config/profile/run
├── cli.ts                # CLI entry (yargs): run / generate / profile → lib/cli.js
├── sandbox/
│   ├── profile.ts        # pure SBPL profile builder + package-manager autodetect
│   └── run.ts            # I/O: locate claude/sandbox-exec, write profile, launch it
└── utils/
    └── config.ts         # defaults, env overrides, JS config load/merge, ~ expansion
tests/
└── profile.test.ts       # bun:test — unit (profile text) + functional (real sandbox-exec)
clabox.config.example.mjs  # copyable user config
```

## Key Architecture
- **3 CLI commands** (`run` / `generate` / `profile`) over a pure builder (`sandbox/profile.ts`) and an I/O launcher (`sandbox/run.ts`) — keep that pure/I-O split
- The Seatbelt profile starts with `(deny default)` — nothing is allowed unless an explicit rule grants it
- Config resolution, later wins: **defaults → env vars → JS config file** (`./clabox.config.mjs` or `~/.config/clabox/config.mjs`, or `CLABOX_CONFIG`, or the `--config` CLI flag which overrides `CLABOX_CONFIG`)
- Personal secrets stay denied even over the allows: `~/.ssh/id_*`, `*.pem`, `*.key`, `denyHome` dirs, `denyDotConfigs`. Only the bot key subdir is readable
- Profiles are deterministic per project: `$TMPDIR/clabox-<dir>-<hash>.sb` (sha256 of the absolute project path)
- Tool-owned env vars use the `CLABOX_` prefix; `CLAUDE_CONFIG_DIR` is Claude's own var, passed straight through to `claude`

## Dependencies
- `yargs` — CLI command/flag parsing (the only runtime dependency)
- Node built-ins otherwise: `fs`, `path`, `os`, `crypto`, `child_process`, `url`
- Dev: `tsdown` (build), `@biomejs/biome` (lint/format), `typescript`, `size-limit`, `semantic-release`

## Testing
- Framework: `bun:test` (`tests/` via `bunfig.toml`), run with `bun test` or `bun run test:unit`
- **Unit** tests check the generated SBPL text and run anywhere. **Functional** tests run a real `sandbox-exec` against a generated profile (`test.skipIf` auto-skips off macOS or when nested in a sandbox)

## More Info
- Full guideline available at [docs/guideline.md](docs/guideline.md)
