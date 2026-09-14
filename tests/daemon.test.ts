// Tests for `clabox daemon` — the pure argv/env builders behind the command
// that runs claude's Remote Control daemon OUTSIDE the sandbox.
//
//   bun test

import { describe, expect, test } from 'bun:test';
import os from 'node:os';
import {
  buildDaemonArgs,
  buildDaemonEnv,
  DEFAULT_DAEMON_ARGS,
  daemonLogPath,
} from '../src/daemon/daemon.js';
import { type Config, defaultConfig } from '../src/utils/config.js';

function cfg(over: Partial<Config>): Config {
  return { ...defaultConfig, configDir: '/cfg', cwd: '/proj/box', ...over };
}

describe('buildDaemonArgs', () => {
  test('defaults to `daemon run` when nothing is passed', () => {
    expect(buildDaemonArgs()).toEqual(['daemon', ...DEFAULT_DAEMON_ARGS]);
    expect(buildDaemonArgs([])).toEqual(['daemon', 'run']);
  });

  test('passes a subcommand and its flags straight through', () => {
    expect(buildDaemonArgs(['stop', '--any'])).toEqual(['daemon', 'stop', '--any']);
    expect(buildDaemonArgs(['status'])).toEqual(['daemon', 'status']);
  });
});

describe('buildDaemonEnv', () => {
  test('pins CLAUDE_CONFIG_DIR to the box config dir (~ expanded)', () => {
    const env = buildDaemonEnv(cfg({ configDir: '~/.claude_axiomus' }), { PATH: '/usr/bin' });
    expect(env.CLAUDE_CONFIG_DIR).toBe(`${os.homedir()}/.claude_axiomus`);
    expect(env.PATH).toBe('/usr/bin');
  });

  test('layers config.env over the inherited env', () => {
    const env = buildDaemonEnv(cfg({ env: { GH_TOKEN: 'tok', PATH: '/box/bin' } }), {
      PATH: '/usr/bin',
      HOME: '/home/x',
    });
    expect(env.GH_TOKEN).toBe('tok');
    expect(env.PATH).toBe('/box/bin');
    expect(env.HOME).toBe('/home/x');
  });

  test('config.env cannot un-pin CLAUDE_CONFIG_DIR silently — it wins on purpose', () => {
    const env = buildDaemonEnv(cfg({ env: { CLAUDE_CONFIG_DIR: '/other' } }), {});
    expect(env.CLAUDE_CONFIG_DIR).toBe('/other');
  });

  test('a null value unsets an inherited var (same contract as the launcher)', () => {
    const env = buildDaemonEnv(cfg({ env: { DISABLE_TELEMETRY: null } }), {
      DISABLE_TELEMETRY: '1',
      B: 'b',
    });
    expect('DISABLE_TELEMETRY' in env).toBe(false);
    expect(env.B).toBe('b');
  });

  test('drops undefined values from the inherited env', () => {
    const env = buildDaemonEnv(cfg({}), { A: undefined, B: 'b' });
    expect('A' in env).toBe(false);
    expect(env.B).toBe('b');
  });
});

describe('daemonLogPath', () => {
  test('is <configDir>/daemon.log (claude’s own default)', () => {
    expect(daemonLogPath(cfg({ configDir: '/cfg' }))).toBe('/cfg/daemon.log');
    expect(daemonLogPath(cfg({ configDir: '~/.claude_x' }))).toBe(
      `${os.homedir()}/.claude_x/daemon.log`,
    );
  });
});
