#!/usr/bin/env node
// clabox — run Claude Code in a sandbox for super-safe YOLO mode.
// SPDX-License-Identifier: MIT
//
// Configure in plain JS: clabox.config.mjs (CWD) or
// ~/.config/clabox/config.mjs. See clabox.config.example.mjs.

import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { runInit } from './init/scaffold.js';
import { generateProfile, profilePath, resolveProjectDir, runClaude } from './sandbox/run.js';
import { loadConfig, resolveBox } from './utils/config.js';

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
  // clabox-owned flag: run a named config from the global configs dir.
  // (`-p` is left for claude's --print; `-c/-r/-d/-v` are claude flags too.)
  .option('box', {
    alias: 'b',
    type: 'string',
    describe: 'Run a named config from ~/.config/clabox/configs/<name>.config.mjs',
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
      const code = runClaude(config, claudeArgs, { configFile });
      process.exit(code);
    },
  )
  .command(
    'generate',
    'Build the sandbox profile only and print its path',
    (y) => y,
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      console.log(generateProfile(config));
    },
  )
  .command(
    'profile',
    'Print the sandbox profile path (no build)',
    (y) => y,
    async (argv) => {
      const { config } = await loadConfig(explicitConfig(argv));
      console.log(profilePath(resolveProjectDir(config)));
    },
  )
  .command(
    'init',
    'Generate clabox-<name> shell aliases and build Ghostty apps for `app` boxes',
    (y) =>
      y
        .option('dir', {
          type: 'string',
          describe: 'Base dir holding configs/ and scripts/ (default: ./__)',
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
  .example('$0 -b ax-root', 'Run the ~/.config/clabox/configs/ax-root.config.mjs box')
  .example('$0 init', 'Generate shell aliases from __/configs/*.config.mjs')
  .example('$0 --config ./my.clabox.mjs run', 'Use a specific JS config file')
  .example('CLAUDE_CONFIG_DIR=~/.claude_work $0 run', 'Use a different Claude profile')
  .epilogue(
    [
      'Config (later wins): defaults -> env vars -> JS config file.',
      'File: ./clabox.config.mjs or ~/.config/clabox/config.mjs',
      '(or --config /path, or CLABOX_CONFIG=/path).',
      'Named boxes: -b <name> -> ~/.config/clabox/configs/<name>.config.mjs',
      '(dir overridable via CLABOX_CONFIGS_DIR).',
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
