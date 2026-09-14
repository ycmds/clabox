#!/usr/bin/env node
// clabox — run Claude Code in a sandbox for super-safe YOLO mode.
// SPDX-License-Identifier: MIT
//
// Configure in plain JS: clabox.config.mjs (CWD) or
// ~/.config/clabox/config.mjs. See clabox.config.example.mjs.

import path from 'node:path';
import { createLogger } from '@lsk4/log';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runDaemon } from './daemon/daemon.js';
import { formatInfo, gatherInfo } from './info/info.js';
import { buildShellCommand, bundleId } from './init/ghostty.js';
import { runInit } from './init/scaffold.js';
import {
  buildOpenScript,
  GHOSTTY_BUNDLE_ID,
  runAppleScript,
  SPLIT_DIRECTIONS,
  type SplitDirection,
  type SurfaceMode,
} from './sandbox/applescript.js';
import { generateProfile, profilePath, resolveProjectDir, runClaude } from './sandbox/run.js';
import {
  type Config,
  configsDir,
  expandHome,
  FLAG_FETCH_BLOCKERS,
  loadConfig,
  resolveBox,
  withExtraEnv,
  withExtraPaths,
} from './utils/config.js';

/** Pick the explicit config path: a `--box <name>` wins over `--config <path>`. */
// Index signature so any yargs argv (incl. commands with an empty builder)
// is assignable — `box`/`config` are global options, present on every command.
function explicitConfig(argv: {
  box?: unknown;
  config?: unknown;
  [k: string]: unknown;
}): string | undefined {
  if (argv.box) return resolveBox(argv.box as string);
  return (argv.config as string | undefined) ?? undefined;
}

/** Layer the ad-hoc `--ro`/`--rw`/`--rc`/`--env` CLI overrides onto the config. */
function withCliPaths(
  config: Config,
  argv: { ro?: unknown; rw?: unknown; rc?: unknown; env?: unknown },
): Config {
  const withPaths = withExtraPaths(config, {
    readOnly: (argv.ro as string[] | undefined) ?? [],
    readWrite: (argv.rw as string[] | undefined) ?? [],
  });
  // `--rc` entries come first so an explicit `-e KEY=VALUE` after them still
  // wins (last entry takes the key): the flag is a default, not an override of
  // what you typed.
  return withExtraEnv(withPaths, [
    ...(argv.rc ? FLAG_FETCH_BLOCKERS : []),
    ...((argv.env as string[] | undefined) ?? []),
  ]);
}

/**
 * Rebuild the global flags for the `clabox` invocation `tab` launches in the new
 * surface. They're declared as yargs options, so `clabox -b x tab --rc --ro ~/d`
 * parses them *here* and they'd never reach the box otherwise — the new tab has
 * to be the same launch you typed, one surface over.
 */
function forwardedGlobals(argv: {
  rc?: unknown;
  env?: unknown;
  ro?: unknown;
  rw?: unknown;
}): string[] {
  const out: string[] = [];
  if (argv.rc) out.push('--rc');
  for (const e of (argv.env as string[] | undefined) ?? []) out.push('-e', e);
  for (const p of (argv.ro as string[] | undefined) ?? []) out.push('--ro', p);
  for (const p of (argv.rw as string[] | undefined) ?? []) out.push('--rw', p);
  return out;
}

await yargs(hideBin(process.argv))
  .scriptName('clabox')
  // Keep unknown flags (e.g. --dangerously-skip-permissions) as positionals so
  // they pass straight through to claude instead of erroring out.
  .parserConfiguration({ 'unknown-options-as-args': true })
  // clabox-owned flag: a config-file path that wins over CLABOX_CONFIG.
  .option('config', {
    type: 'string',
    describe: 'Path to a JS config file (overrides CLABOX_CONFIG)',
  })
  // clabox-owned flag: run a named config from the global configs dir,
  // or straight from a config-file path (`-b path/vibe.mjs`, `-b path/vibe`).
  // (`-p` is left for claude's --print; `-c/-r/-d/-v` are claude flags too.)
  .option('box', {
    alias: ['b', 'name'],
    type: 'string',
    describe: 'Box name from ~/.config/clabox/configs, or a path to a box config',
  })
  // Ad-hoc sandbox path grants, additive over the config's `paths` (repeatable).
  // `nargs: 1` keeps each flag greedy for exactly one value, so it never swallows
  // the `run`/`generate`/… command or a trailing claude arg.
  .option('ro', {
    type: 'string',
    array: true,
    nargs: 1,
    describe: 'Extra read-only path granted to the sandbox (repeatable)',
  })
  .option('rw', {
    type: 'string',
    array: true,
    nargs: 1,
    describe: 'Extra read-write path granted to the sandbox (repeatable)',
  })
  // Ad-hoc env override for this launch only: `KEY=VALUE` sets, a bare `KEY`
  // UNsets (`env -u KEY`) — the only way to drop a var a preset/shell exported,
  // e.g. `-e DISABLE_TELEMETRY` to get feature flags (and `/rc`) in one tab.
  .option('env', {
    alias: 'e',
    type: 'string',
    array: true,
    nargs: 1,
    describe: 'Env override for this run: KEY=VALUE to set, bare KEY to unset (repeatable)',
  })
  // Shorthand for unsetting every var that blocks claude's feature-flag fetch —
  // any one of them is enough to hide Remote Control, so `--rc` clears the set.
  .option('rc', {
    type: 'boolean',
    default: false,
    describe: `Unset the vars that block feature-flag fetching (${FLAG_FETCH_BLOCKERS.join(', ')}) so /rc works, and mark the tab (badge + background)`,
  })
  .command(
    ['run [claudeArgs..]', '$0 [claudeArgs..]'],
    'Generate the profile and run claude inside the sandbox (default)',
    (y) =>
      y.positional('claudeArgs', {
        describe: 'Arguments passed through to claude',
        array: true,
        default: [] as string[],
      }),
    async (argv) => {
      const { config, configFile } = await loadConfig(explicitConfig(argv));
      const claudeArgs = (argv.claudeArgs ?? []) as string[];
      const code = runClaude(withCliPaths(config, argv), claudeArgs, {
        configFile,
        // Also drives the tab decoration (badge + background) — a Remote-Control
        // tab should look different from a private one.
        rc: Boolean(argv.rc),
      });
      process.exit(code);
    },
  )
  .command(
    'generate',
    'Build the sandbox profile only and print its path',
    (y) => y,
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      console.log(generateProfile(withCliPaths(config, argv)));
    },
  )
  .command(
    'profile',
    'Print the sandbox profile path (no build)',
    (y) => y,
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      console.log(profilePath(resolveProjectDir(withCliPaths(config, argv))));
    },
  )
  .command(
    'info',
    'Print clabox/version/box/config diagnostics for the resolved config',
    (y) => y,
    async (argv) => {
      const { config, configFile } = await loadConfig(explicitConfig(argv));
      const data = gatherInfo(withCliPaths(config, argv), {
        configFile,
        box: argv.box as string | undefined,
      });
      const log = createLogger('clabox');
      // `.log` is the raw passthrough — keeps the aligned table intact (vs. the
      // per-line `ℹ clabox` prefix of `.info`); colorize only for a real TTY.
      log.log(formatInfo(data, { color: Boolean(process.stdout.isTTY) }));
      // Surface a hard blocker as a real warn (clabox can't run without these).
      if (!data.claudeBin) log.warn('claude binary not found on PATH');
      if (!data.sandboxExec) log.warn('sandbox-exec not found — clabox needs macOS');
    },
  )
  // Open a box as a surface of the *running* Ghostty (AppleScript), instead of
  // its own cloned .app — the lightweight counterpart of `init`'s app boxes.
  .command(
    'tab [claudeArgs..]',
    'Open this box in a new Ghostty tab (or --window / --split) via AppleScript',
    (y) =>
      y
        .positional('claudeArgs', {
          describe: 'Extra args for the clabox run in the new surface (e.g. --rc)',
          array: true,
          default: [] as string[],
        })
        .option('window', { type: 'boolean', default: false, describe: 'New window instead' })
        .option('split', {
          type: 'string',
          choices: SPLIT_DIRECTIONS,
          describe: 'Split the focused surface in this direction instead',
        })
        .option('app', {
          type: 'boolean',
          default: false,
          describe: "Target this box's own built .app instead of the main Ghostty",
        })
        .option('print', {
          type: 'boolean',
          default: false,
          describe: 'Print the AppleScript instead of running it',
        }),
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      const box = (argv.box as string | undefined) ?? null;
      const projectDir = resolveProjectDir(config);
      const mode: SurfaceMode = argv.split ? 'split' : argv.window ? 'window' : 'tab';
      const script = buildOpenScript({
        command: buildShellCommand({
          boxName: box,
          projectDir,
          // Only bake the configs dir when it isn't the runtime default — the
          // new surface is a login shell, so it resolves the default itself.
          configsDir: process.env.CLABOX_CONFIGS_DIR ? configsDir() : null,
          claboxBin: config.appBuilder.claboxBin
            ? expandHome(config.appBuilder.claboxBin)
            : 'clabox',
          extraArgs: [...forwardedGlobals(argv), ...((argv.claudeArgs ?? []) as string[])],
        }),
        cwd: projectDir,
        mode,
        direction: argv.split as SplitDirection | undefined,
        bundleId: argv.app && config.app && box ? bundleId(box, config.app) : GHOSTTY_BUNDLE_ID,
      });
      if (argv.print) {
        console.log(script);
        process.exit(0);
      }
      const res = runAppleScript(script);
      if (!res.ok) {
        const log = createLogger('clabox');
        log.warn(`ghostty ${mode} failed: ${res.output}`);
        log.log('  macOS may need Automation permission for this terminal (System Settings →');
        log.log('  Privacy & Security → Automation). `--print` shows the script it tried to run.');
        process.exit(1);
      }
      process.exit(0);
    },
  )
  .command(
    'daemon [daemonArgs..]',
    "Run claude's Remote Control daemon for this box OUTSIDE the sandbox",
    (y) =>
      y
        .positional('daemonArgs', {
          describe: 'Passed to `claude daemon` (run | status | stop | logs). Default: run',
          array: true,
          default: [] as string[],
        })
        .option('detach', {
          type: 'boolean',
          default: false,
          describe: 'Start it in the background and return instead of holding the terminal',
        }),
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      const { status, pid, logFile, configDir } = runDaemon(
        config,
        (argv.daemonArgs ?? []) as string[],
        { detach: argv.detach as boolean },
      );
      if (pid !== null) {
        const log = createLogger('clabox');
        log.info(`daemon started unsandboxed: pid ${pid}`);
        log.log(`  configDir  ${configDir}`);
        log.log(`  log        ${logFile}`);
      }
      process.exit(status);
    },
  )
  .command(
    'init',
    'Generate clabox-<name> shell aliases and build Ghostty apps for `app` boxes',
    (y) =>
      y
        .option('dir', {
          type: 'string',
          describe: 'Base dir holding configs/ and scripts/ (default: ~/.config/clabox)',
        })
        .option('apps', {
          type: 'boolean',
          default: true,
          describe: 'Build Ghostty apps for `app` boxes (use --no-apps to skip)',
        })
        .option('app', {
          type: 'string',
          describe: 'Build only this app box (by box name or app display name)',
        }),
    async (argv) => {
      const { profiles, indexFile, written, apps, raycastCommands, extraFiles, warnings } =
        await runInit({
          baseDir: argv.dir as string | undefined,
          buildApps: argv.apps as boolean,
          only: (argv.app as string | undefined) ?? null,
        });
      console.log(`clabox init: ${profiles.length} profile(s) → ${profiles.join(', ')}`);
      for (const f of written) console.log(`  ${path.basename(f)}`);
      for (const f of extraFiles) console.log(`  🔌 ${f}`);
      for (const a of apps) console.log(`  📦 ${a.appPath} (${a.signed})`);
      for (const r of raycastCommands) console.log(`  🚀 ${r}`);
      for (const w of warnings) console.warn(`  ⚠️  ${w}`);
      console.log(`\nAdd to ~/.zshrc:  source ${indexFile}`);
      if (raycastCommands.length > 0) {
        console.log(`Add to Raycast (Script Commands dir):  ${path.dirname(raycastCommands[0])}`);
      }
    },
  )
  .example('$0 run --dangerously-skip-permissions', 'YOLO mode inside the sandbox')
  .example('$0 --ro ~/dir2 run', 'Grant the sandbox read-only access to ~/dir2')
  .example('$0 --ro ~/a --rw ~/b run', 'Extra RO + RW grants (both flags repeatable)')
  .example('$0 -b ax-mg --rc', 'Unset every var that would hide Remote Control (/rc)')
  .example('$0 -b ax-mg -e DISABLE_TELEMETRY', 'Unset a preset var for this tab (re-enables /rc)')
  .example('$0 -b ax-mg -e DISABLE_TELEMETRY=1', 'Or force it on for this tab only')
  .example('$0 -b ax-root', 'Run the ~/.config/clabox/configs/ax-root.config.mjs box')
  .example('$0 -b ax daemon --detach', "Start that box's Remote Control daemon outside the sandbox")
  .example('$0 -b ./boxes/vibe.mjs', 'Run a box straight from a config-file path')
  .example('$0 -b ax-mg tab', 'Open that box in a new tab of the running Ghostty')
  .example('$0 -b ax-mg tab --split right --rc', 'Same box as an --rc split next to this one')
  .example('$0 info', 'Print version/box/config diagnostics for the resolved config')
  .example('$0 init', 'Generate shell aliases from ~/.config/clabox/configs/*.config.mjs')
  .example('$0 --config ./my.clabox.mjs run', 'Use a specific JS config file')
  .example('CLAUDE_CONFIG_DIR=~/.claude_work $0 run', 'Use a different Claude profile')
  .epilogue(
    [
      'Config (later wins): defaults -> env vars -> JS config file.',
      'File: ./clabox.config.mjs or ~/.config/clabox/config.mjs',
      '(or --config /path, or CLABOX_CONFIG=/path).',
      'Named boxes: -b <name> -> ~/.config/clabox/configs/<name>.config.mjs',
      '(dir overridable via CLABOX_CONFIGS_DIR).',
      'Path boxes: -b path/vibe.mjs (explicit file) or -b path/vibe',
      '(box `vibe` resolved inside path/).',
    ].join('\n'),
  )
  .version(false)
  .help()
  .alias('h', 'help')
  .fail((msg, err) => {
    console.error(`Error: ${err?.message ?? msg}`);
    process.exit(1);
  })
  .parseAsync();
