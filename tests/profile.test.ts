// Tests for the sandbox wrapper itself — the generated Seatbelt profile and
// the restrictions it enforces. These do NOT run or test `claude`.
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
import { buildProfile } from '../src/sandbox/profile.js';
import { defaultConfig, findConfigFile, mergeConfig } from '../src/utils/config.js';

const PROJECT = '/tmp/sample-project';
const build = (over: Record<string, unknown> = {}) =>
  buildProfile(mergeConfig(defaultConfig, over), { projectDir: PROJECT, detectedPaths: [] });

// ---------------------------------------------------------------------------
// Unit: profile text generation
// ---------------------------------------------------------------------------

describe('profile text generation', () => {
  test('profile carries the SBPL preamble', () => {
    const p = build();
    expect(p).toMatch(/^\(version 1\)$/m);
    expect(p).toMatch(/^\(deny default\)$/m);
  });

  test('project dir is granted read-write + exec', () => {
    const p = build();
    expect(p).toContain(`(subpath "${PROJECT}")`);
    expect(p).toContain('(allow file-read* file-write* file-map-executable');
  });

  test('network can be toggled on and off', () => {
    expect(build({ network: true })).toContain('(allow network*)');
    expect(build({ network: false })).not.toContain('(allow network*)');
  });

  test('Claude config dir is mounted read-write', () => {
    expect(build({ configDir: '/tmp/cfgdir' })).toContain('(subpath "/tmp/cfgdir")');
  });

  test('personal ssh keys are denied while the bot key dir is allowed', () => {
    const p = build({ bot: { sshDir: '/tmp/botkeys' } });
    expect(p).toContain('.ssh/id_');
    expect(p).toContain('.pem$');
    expect(p).toContain('.key$');
    expect(p).toContain('(subpath "/tmp/botkeys")');
  });

  test('default deny list covers private dirs and secret dotfiles', () => {
    const p = build();
    expect(p).toContain(`(subpath "${path.join(os.homedir(), 'Documents')}")`);
    expect(p).toContain('(aws|gnupg|kube|docker|config)');
  });

  test('extra config paths are layered into the profile', () => {
    const p = build({
      paths: { readWrite: ['/tmp/rw'], readOnly: ['/tmp/ro'], exec: ['/tmp/x'], deny: ['/tmp/no'] },
    });
    for (const s of ['/tmp/rw', '/tmp/ro', '/tmp/x', '/tmp/no']) {
      expect(p).toContain(`(subpath "${s}")`);
    }
  });

  test('hooks dir is off by default and granted when it exists', () => {
    expect(build()).toContain('no hooks dir');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-'));
    try {
      expect(build({ hooksDir: dir })).toContain(`(subpath "${dir}")`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Unit: config-file resolution
// ---------------------------------------------------------------------------

describe('findConfigFile', () => {
  test('an explicit path (e.g. from --config) wins and is returned as-is', () => {
    expect(findConfigFile('/tmp/custom.clabox.mjs')).toBe('/tmp/custom.clabox.mjs');
  });

  test('an explicit path expands a leading ~', () => {
    expect(findConfigFile('~/custom.clabox.mjs')).toBe(
      path.join(os.homedir(), 'custom.clabox.mjs'),
    );
  });

  test('no explicit path falls back to the lookup chain', () => {
    // With no arg and (presumably) no CLABOX_CONFIG / local config file in the
    // test env, resolution yields either a discovered file or null — never throws.
    expect(() => findConfigFile()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Functional: restrictions are actually enforced by sandbox-exec
// ---------------------------------------------------------------------------

function sandboxUsable(): boolean {
  if (process.platform !== 'darwin') return false;
  try {
    execFileSync('command', ['-v', 'sandbox-exec'], { shell: '/bin/sh' });
  } catch {
    return false;
  }
  // sandbox-exec cannot run inside another sandbox; probe before relying on it.
  const probe = path.join(os.tmpdir(), `cb-probe-${process.pid}.sb`);
  fs.writeFileSync(probe, '(version 1)\n(allow default)\n');
  const r = spawnSync('sandbox-exec', ['-f', probe, '/usr/bin/true']);
  fs.rmSync(probe, { force: true });
  return r.status === 0;
}

const skipSandbox = !sandboxUsable();

describe('sandbox enforcement (real sandbox-exec)', () => {
  test.skipIf(skipSandbox)('sandbox allows the project dir but blocks denied paths', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-')));
    const projectDir = path.join(root, 'project');
    const secretDir = path.join(root, 'secret');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(projectDir, 'ok.txt'), 'hello');
    fs.writeFileSync(path.join(secretDir, 'secret.txt'), 'nope');

    const cfg = mergeConfig(defaultConfig, {
      network: false,
      paths: { readWrite: [], readOnly: [], exec: [], deny: [secretDir] },
    });
    const profileFile = path.join(root, 'profile.sb');
    fs.writeFileSync(profileFile, buildProfile(cfg, { projectDir, detectedPaths: [] }));

    const run = (bin: string, ...a: string[]) =>
      spawnSync('sandbox-exec', ['-f', profileFile, bin, ...a], { encoding: 'utf8' });

    // reads
    const okRead = run('/bin/cat', path.join(projectDir, 'ok.txt'));
    expect(okRead.status).toBe(0);
    expect(okRead.stdout).toBe('hello');
    expect(run('/bin/cat', path.join(secretDir, 'secret.txt')).status).not.toBe(0);

    // writes
    expect(run('/usr/bin/touch', path.join(projectDir, 'new.txt')).status).toBe(0);
    expect(run('/usr/bin/touch', path.join(secretDir, 'new.txt')).status).not.toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });

  test.skipIf(skipSandbox)('the generated default profile is accepted by sandbox-exec', () => {
    const file = path.join(fs.realpathSync(os.tmpdir()), `cb-accept-${process.pid}.sb`);
    fs.writeFileSync(file, build());
    const r = spawnSync('sandbox-exec', ['-f', file, '/usr/bin/true']);
    fs.rmSync(file, { force: true });
    expect(r.status).toBe(0);
  });
});
