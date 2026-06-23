#!/usr/bin/env node
// clabox — run Claude Code in a sandbox for super-safe YOLO mode.
// SPDX-License-Identifier: MIT
//
// Configure in plain JS: clabox.config.mjs (CWD) or
// ~/.config/clabox/config.mjs. See clabox.config.example.mjs.

import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { generateProfile, profilePath, runClaude } from './sandbox/run.js';
import { loadConfig } from './utils/config.js';

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
      const { config, configFile } = await loadConfig(argv.config as string | undefined);
      const claudeArgs = (argv.claudeArgs ?? []) as string[];
      const code = runClaude(config, claudeArgs, { configFile });
      process.exit(code);
    },
  )
  .command('generate', 'Build the sandbox profile only and print its path', {}, async (argv) => {
    const { config } = await loadConfig(argv.config as string | undefined);
    console.log(generateProfile(config));
  })
  .command('profile', 'Print the sandbox profile path (no build)', {}, () => {
    console.log(profilePath());
  })
  .example('$0 run --dangerously-skip-permissions', 'YOLO mode inside the sandbox')
  .example('$0 --config ./my.clabox.mjs run', 'Use a specific JS config file')
  .example('CLAUDE_CONFIG_DIR=~/.claude_work $0 run', 'Use a different Claude profile')
  .epilogue(
    [
      'Config (later wins): defaults -> env vars -> JS config file.',
      'File: ./clabox.config.mjs or ~/.config/clabox/config.mjs',
      '(or --config /path, or CLABOX_CONFIG=/path).',
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
