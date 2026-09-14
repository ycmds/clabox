// Tests for the launcher helpers in `src/sandbox/run.ts`.
//
// `resolveUlimit` is the pure one and carries the interesting invariant: macOS
// counts RLIMIT_NPROC per *uid*, machine-wide, so `config.ulimitProcs` is
// headroom over the processes already running — an absolute cap below the
// current count makes every fork in the box fail (no keychain read ⇒
// "Not logged in · API Usage Billing").
//
//   bun test

import { describe, expect, test } from 'bun:test';
import { buildEnvArgs, countUserProcs, maxProcPerUid, resolveUlimit } from '../src/sandbox/run.js';
import {
  type Config,
  defaultConfig,
  FLAG_FETCH_BLOCKERS,
  SANDBOX_ESCAPE_GUARDS,
  withExtraEnv,
} from '../src/utils/config.js';

function cfg(over: Partial<Config>): Config {
  return { ...defaultConfig, configDir: '/cfg', cwd: '/proj/box', ...over };
}

describe('resolveUlimit', () => {
  test('adds the headroom to the processes already running', () => {
    expect(resolveUlimit(1024, { current: 1070, hard: 5333 })).toBe(2094);
  });

  test('clamps to the hard per-uid limit', () => {
    expect(resolveUlimit(9000, { current: 1070, hard: 5333 })).toBe(5333);
  });

  test('unknown hard limit → plain current + headroom', () => {
    expect(resolveUlimit(100, { current: 200, hard: null })).toBe(300);
  });

  test('0 / negative / garbage headroom disables the guard', () => {
    for (const v of [0, -5, Number.NaN]) {
      expect(resolveUlimit(v, { current: 100, hard: 5333 })).toBeNull();
    }
  });

  test('non-integer headroom is floored, never interpolated raw', () => {
    expect(resolveUlimit(10.9, { current: 100, hard: null })).toBe(110);
    expect(
      resolveUlimit('64; rm -rf /' as unknown as number, { current: 1, hard: null }),
    ).toBeNull();
  });

  test('no cap at all when the process count is unreadable', () => {
    expect(resolveUlimit(1024, { current: null, hard: 5333 })).toBeNull();
  });
});

// `countUserProcs` shells out to `ps`, which is setgid `kmem` — Seatbelt refuses
// setgid execs, so nested inside a box the count is unreadable (null) by design.
// Same treatment as the functional profile tests: run for real on a plain macOS
// shell, skip when we're the sandboxed one.
const skipProcCount = process.platform !== 'darwin' || countUserProcs() === null;

describe('process counting (I/O)', () => {
  test.skipIf(skipProcCount)('counts this uid + reads the hard cap', () => {
    const current = countUserProcs();
    const hard = maxProcPerUid();
    expect(current).toBeGreaterThan(0);
    expect(hard).toBeGreaterThan(0);
    // The box must always get room to fork, whatever the machine is doing.
    expect(resolveUlimit(1024, { current, hard })).toBeGreaterThan(current as number);
  });
});

describe('buildEnvArgs + withExtraEnv (ad-hoc `--env`)', () => {
  test('config.env is appended as KEY=VALUE, after the built-in vars', () => {
    const args = buildEnvArgs(cfg({ env: { GH_TOKEN: 'tok' } }));
    expect(args).toContain('GH_TOKEN=tok');
    expect(args.indexOf('GH_TOKEN=tok')).toBeGreaterThan(args.indexOf('CLAUDE_CONFIG_DIR=/cfg'));
  });

  test('a null value becomes `env -u KEY`, emitted BEFORE the assignments', () => {
    // `env` only accepts -u flags ahead of the KEY=VALUE list.
    const args = buildEnvArgs(cfg({ env: { DISABLE_TELEMETRY: null, GH_TOKEN: 'tok' } }));
    expect(args.slice(0, 2)).toEqual(['-u', 'DISABLE_TELEMETRY']);
    expect(args).toContain('GH_TOKEN=tok');
    expect(args.some((a) => a.startsWith('DISABLE_TELEMETRY='))).toBe(false);
  });

  test('`KEY=VALUE` sets, a bare `KEY` unsets, and the CLI wins over the box', () => {
    const box = cfg({ env: { DISABLE_TELEMETRY: '1', GH_TOKEN: 'tok' } });
    expect(withExtraEnv(box, ['DISABLE_TELEMETRY']).env).toEqual({
      DISABLE_TELEMETRY: null,
      GH_TOKEN: 'tok',
    });
    expect(withExtraEnv(box, ['DISABLE_TELEMETRY=0']).env.DISABLE_TELEMETRY).toBe('0');
  });

  test('a value may contain `=`; the split is on the first one only', () => {
    expect(withExtraEnv(cfg({}), ['X=a=b']).env.X).toBe('a=b');
    expect(withExtraEnv(cfg({}), ['X=']).env.X).toBe('');
  });

  test('later entries win; nameless entries are ignored', () => {
    expect(withExtraEnv(cfg({}), ['X=1', 'X=2']).env.X).toBe('2');
    expect(withExtraEnv(cfg({}), ['=1', '  ']).env).toEqual({});
  });

  test('no entries → the very same config object (no needless copy)', () => {
    const c = cfg({ env: { A: '1' } });
    expect(withExtraEnv(c, [])).toBe(c);
  });
});

describe('SANDBOX_ESCAPE_GUARDS (background tasks escape the box)', () => {
  test('the guard is on by default', () => {
    // Seatbelt is applied at exec and inherited, so a box can only be escaped by
    // making ANOTHER process do the work. A background task is exactly that: the
    // singleton `claude daemon run` lives outside every box (PPID 1) and answers
    // by re-hosting the session with `--fork-session --resume` — same transcript,
    // no profile. So the guard is a security default, not a preference.
    expect(defaultConfig.allowBackgroundTasks).toBe(false);
    const args = buildEnvArgs(cfg({}));
    for (const [key, value] of Object.entries(SANDBOX_ESCAPE_GUARDS)) {
      expect(args).toContain(`${key}=${value}`);
    }
  });

  test('allowBackgroundTasks: true drops the guard entirely', () => {
    const args = buildEnvArgs(cfg({ allowBackgroundTasks: true }));
    for (const key of Object.keys(SANDBOX_ESCAPE_GUARDS)) {
      expect(args.some((a) => a.startsWith(`${key}=`))).toBe(false);
    }
  });

  test('the guard sits before config.env, so a box value still wins', () => {
    // Last assignment wins in `env`, so an explicit KEY=VALUE overrides it…
    const args = buildEnvArgs(cfg({ env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' } }));
    const hits = args.filter((a) => a.startsWith('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS='));
    expect(hits.at(-1)).toBe('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0');
  });

  test('…but a `null` in env CANNOT undo it — that is what the flag is for', () => {
    // `env` only accepts -u ahead of the assignments, so `-u KEY … KEY=1` still
    // ends up set. Anyone wanting bg tasks must use `allowBackgroundTasks`.
    const args = buildEnvArgs(cfg({ env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: null } }));
    expect(args.slice(0, 2)).toEqual(['-u', 'CLAUDE_CODE_DISABLE_BACKGROUND_TASKS']);
    expect(args).toContain('CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1');
  });
});

describe('--rc (FLAG_FETCH_BLOCKERS)', () => {
  test('covers every var that turns feature-flag fetching off', () => {
    // Any ONE of these hides Remote Control, so `--rc` has to clear all four —
    // clearing a subset is the trap that makes the fix look ineffective.
    expect(FLAG_FETCH_BLOCKERS).toEqual([
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'DISABLE_TELEMETRY',
      'DO_NOT_TRACK',
      'DISABLE_GROWTHBOOK',
    ]);
  });

  test('unsets all of them, whatever the box had set', () => {
    const box = cfg({ env: { DISABLE_TELEMETRY: '1', DO_NOT_TRACK: '1', GH_TOKEN: 'tok' } });
    const rc = withExtraEnv(box, FLAG_FETCH_BLOCKERS);
    for (const key of FLAG_FETCH_BLOCKERS) expect(rc.env[key]).toBeNull();
    expect(rc.env.GH_TOKEN).toBe('tok');
    // …and the launcher turns each one into an `env -u KEY` ahead of the sets.
    const args = buildEnvArgs(rc);
    for (const key of FLAG_FETCH_BLOCKERS) {
      expect(args[args.indexOf(key) - 1]).toBe('-u');
      expect(args.some((a) => a.startsWith(`${key}=`))).toBe(false);
    }
  });

  test('an explicit `-e KEY=VALUE` after --rc still wins (flag is a default)', () => {
    const entries = [...FLAG_FETCH_BLOCKERS, 'DISABLE_TELEMETRY=1'];
    expect(withExtraEnv(cfg({}), entries).env.DISABLE_TELEMETRY).toBe('1');
  });
});
