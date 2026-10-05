// Tests for the de-privileged tool copies (`ps`) the box runs instead of the
// setuid originals Seatbelt refuses to exec.
//
//   bun test
//
// The functional block shells out to real `sandbox-exec` and is skipped
// automatically off macOS or when running nested inside another sandbox.

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureProcTools, needsRefresh, PROC_TOOLS } from '../src/sandbox/proctools.js';
import { buildProfile } from '../src/sandbox/profile.js';
import { claboxBinDir, defaultConfig } from '../src/utils/config.js';

const realTmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Run `fn` with CLABOX_CONFIGS_DIR pinned, so claboxHomeDir() is a tmp dir. */
function withConfigsDir<T>(dir: string, fn: () => T): T {
  const prev = process.env.CLABOX_CONFIGS_DIR;
  process.env.CLABOX_CONFIGS_DIR = dir;
  try {
    return fn();
  } finally {
    if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
    else process.env.CLABOX_CONFIGS_DIR = prev;
  }
}

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

describe('needsRefresh', () => {
  const src = { size: 100, mtimeMs: 1_000 };

  test('a missing copy is always refreshed', () => {
    expect(needsRefresh(src, null)).toBe(true);
  });

  test('a copy newer than the source is kept', () => {
    expect(needsRefresh(src, { size: 100, mtimeMs: 2_000 })).toBe(false);
  });

  test('a copy older than the source is refreshed (macOS replaced /bin/ps)', () => {
    expect(needsRefresh(src, { size: 100, mtimeMs: 500 })).toBe(true);
  });

  test('an empty copy is refreshed even when it looks newer', () => {
    expect(needsRefresh(src, { size: 0, mtimeMs: 2_000 })).toBe(true);
  });

  test('a copy of a different size than the source is still kept', () => {
    // Re-signing rewrites the signature and changes the size, so comparing it
    // against the source would reinstall `ps` on every single launch.
    expect(needsRefresh(src, { size: 12_345, mtimeMs: 2_000 })).toBe(false);
  });
});

describe('PROC_TOOLS', () => {
  test('covers ps, the tool an agent needs to find what it started', () => {
    expect(PROC_TOOLS.map((t) => t.name)).toContain('ps');
    expect(PROC_TOOLS.find((t) => t.name === 'ps')?.source).toBe('/bin/ps');
  });
});

describe('claboxBinDir', () => {
  test('sits inside the clabox home, which the profile already grants', () => {
    withConfigsDir('/tmp/cb-home/configs', () => {
      expect(claboxBinDir()).toBe('/tmp/cb-home/bin');
    });
  });
});

// ---------------------------------------------------------------------------
// Functional
// ---------------------------------------------------------------------------

const skipDarwin = process.platform !== 'darwin';

function sandboxUsable(): boolean {
  if (skipDarwin) return false;
  try {
    execFileSync('command', ['-v', 'sandbox-exec'], { shell: '/bin/sh' });
  } catch {
    return false;
  }
  const probe = path.join(os.tmpdir(), `cb-pt-probe-${process.pid}.sb`);
  fs.writeFileSync(probe, '(version 1)\n(allow default)\n');
  const r = spawnSync('sandbox-exec', ['-f', probe, '/usr/bin/true']);
  fs.rmSync(probe, { force: true });
  return r.status === 0;
}

const skipSandbox = !sandboxUsable();

describe('ensureProcTools', () => {
  test.skipIf(skipDarwin)('installs a ps copy without the setuid bit', () => {
    const home = realTmp('cb-bin-');
    const results = withConfigsDir(path.join(home, 'configs'), () => ensureProcTools());
    const ps = results.find((r) => r.name === 'ps');

    expect(ps?.status).toBe('installed');
    expect(ps?.warning).toBeUndefined();
    const mode = fs.statSync(ps?.path as string).mode;
    // The whole point: the copy carries no setuid/setgid bit, which is what
    // made the original unexecutable inside the sandbox.
    expect(mode & 0o4000).toBe(0);
    expect(mode & 0o2000).toBe(0);
    expect(mode & 0o111).not.toBe(0);
    // No staging leftovers.
    expect(fs.existsSync(`${ps?.path}.new`)).toBe(false);

    // A second call is a no-op.
    const again = withConfigsDir(path.join(home, 'configs'), () => ensureProcTools());
    expect(again.find((r) => r.name === 'ps')?.status).toBe('cached');

    fs.rmSync(home, { recursive: true, force: true });
  });

  test.skipIf(skipSandbox)('the copy actually runs under the profile, unlike /bin/ps', () => {
    const home = realTmp('cb-ps-run-');
    const configsDir = path.join(home, 'configs');
    const { psPath, profileFile } = withConfigsDir(configsDir, () => {
      const results = ensureProcTools();
      const file = path.join(home, 'profile.sb');
      // Built under the same CLABOX_CONFIGS_DIR, so the profile's clabox-home
      // carve-out (read + process-exec) covers <home>/bin.
      fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: home, detectedPaths: [] }));
      return { psPath: results.find((r) => r.name === 'ps')?.path as string, profileFile: file };
    });

    const run = (bin: string, ...args: string[]) =>
      spawnSync('sandbox-exec', ['-f', profileFile, bin, ...args], { encoding: 'utf8' });

    // The original is setuid root: Seatbelt denies the exec outright
    // (`forbidden-exec-sugid`), no matter how wide process-exec is.
    expect(run('/bin/ps', '-o', 'pid=').status).not.toBe(0);

    // The copy runs and lists processes. Report what the sandbox said on
    // failure: exit 137 would mean AMFI SIGKILLed it, i.e. the ad-hoc re-sign
    // that strips the restricted entitlement did not take.
    const r = run(psPath, '-o', 'pid=,comm=');
    expect(`status=${r.status}\nstderr=${r.stderr}`).toBe('status=0\nstderr=');
    expect(r.stdout.trim().length).toBeGreaterThan(0);

    fs.rmSync(home, { recursive: true, force: true });
  });
});
