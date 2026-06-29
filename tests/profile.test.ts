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
import { buildEnvArgs, resolveProjectDir } from '../src/sandbox/run.js';
import { defaultConfig, findConfigFile, mergeConfig } from '../src/utils/config.js';

const PROJECT = '/tmp/sample-project';
const build = (over: Record<string, unknown> = {}) =>
  buildProfile(mergeConfig(defaultConfig, over), { projectDir: PROJECT, detectedPaths: [] });

/** A canonical (symlink-resolved) tmp dir — macOS `os.tmpdir()` is under /var. */
const realTmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/** Run `fn` with CLABOX_CONFIGS_DIR pinned (so claboxHomeDir() is deterministic). */
function withConfigsDir(dir: string, fn: () => void): void {
  const prev = process.env.CLABOX_CONFIGS_DIR;
  process.env.CLABOX_CONFIGS_DIR = dir;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
    else process.env.CLABOX_CONFIGS_DIR = prev;
  }
}

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

  test('notification banner XPC is granted (terminal-notifier / osascript hooks)', () => {
    const p = build();
    expect(p).toContain('(global-name "com.apple.hiservices-xpcservice")');
    // afplay sound services stay granted too
    expect(p).toContain('(global-name "com.apple.audio.audiohald")');
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

  test('hard secret deny is emitted AFTER a broad readOnly so it cannot be overridden', () => {
    // A box may grant read across the whole disk; secrets must still win.
    const p = build({ paths: { readWrite: [], readOnly: ['/'], exec: [], deny: [] } });
    const roIdx = p.indexOf('extra read-only paths');
    const projIdx = p.indexOf('project workspace');
    const hardIdx = p.indexOf('hard secret DENY');
    expect(roIdx).toBeGreaterThan(-1);
    expect(hardIdx).toBeGreaterThan(roIdx);
    expect(hardIdx).toBeGreaterThan(projIdx);
    // The credential & private-key denies live in that final, binding block.
    const tail = p.slice(hardIdx);
    expect(tail).toContain('(aws|gnupg|kube|docker|config)');
    expect(tail).toContain('.ssh/id_');
    expect(tail).toContain('.pem$');
    expect(tail).toContain('.key$');
  });

  test('clabox home gets a RW grant re-issued AFTER the hard deny', () => {
    // The clabox home (box configs + compiled mcp/settings) lives under
    // ~/.config/clabox, which the hard `.config` deny blocks; the carve-out must
    // come AFTER it (last-match-wins) to be usable in-box, and is read+write so a
    // box can edit its own configs. Pin a plain (non-symlink) configs dir so the
    // grant is exactly the nominal home — the symlinked case is covered below.
    const home = `${realTmp('cb-extras-')}`;
    withConfigsDir(`${home}/configs`, () => {
      const p = build();
      const rw = ['(allow file-read* file-write*', `  (subpath "${home}")`, ')'].join('\n');
      const ex = ['(allow process-exec', `  (subpath "${home}")`, ')'].join('\n');
      expect(p).toContain(rw);
      expect(p).toContain(ex);
      expect(p.indexOf(rw)).toBeGreaterThan(p.indexOf('hard secret DENY'));
    });
  });

  test('a symlinked clabox home also grants the resolved real home', () => {
    // When ~/.config/clabox is a symlink (e.g. relocated into a project repo) the
    // configs + compiled extras physically live at the target. Seatbelt matches
    // the symlink-resolved path, so the profile must grant THAT too — else the
    // in-box read/write is denied (EPERM). Both the nominal and the resolved
    // grants must land after the hard deny (last-match-wins).
    const root = realTmp('cb-symhome-');
    const realHome = path.join(root, 'real-home');
    const linkHome = path.join(root, 'link-home');
    fs.mkdirSync(realHome);
    fs.symlinkSync(realHome, linkHome);

    withConfigsDir(path.join(linkHome, 'configs'), () => {
      const p = build();
      const hardIdx = p.indexOf('hard secret DENY');
      // nominal (symlink) grant stays…
      expect(p).toContain(`(subpath "${linkHome}")`);
      // …plus the resolved real home, re-granted after the hard deny.
      expect(p).toContain(`(subpath "${realHome}")`);
      expect(p.indexOf(`(subpath "${realHome}")`)).toBeGreaterThan(hardIdx);
    });
  });
});

// ---------------------------------------------------------------------------
// Unit: project-dir resolution (config.cwd)
// ---------------------------------------------------------------------------

describe('resolveProjectDir', () => {
  test('falls back to the shell CWD when cwd is null', () => {
    expect(resolveProjectDir(defaultConfig)).toBe(process.cwd());
  });

  test('uses config.cwd when set', () => {
    expect(resolveProjectDir(mergeConfig(defaultConfig, { cwd: '/tmp/box-project' }))).toBe(
      '/tmp/box-project',
    );
  });

  test('expands a leading ~ in config.cwd', () => {
    expect(resolveProjectDir(mergeConfig(defaultConfig, { cwd: '~/box-project' }))).toBe(
      path.join(os.homedir(), 'box-project'),
    );
  });

  test('config.cwd becomes the read-write project dir in the profile', () => {
    const cfg = mergeConfig(defaultConfig, { cwd: '/tmp/box-project' });
    const p = buildProfile(cfg, { projectDir: resolveProjectDir(cfg), detectedPaths: [] });
    expect(p).toContain('(subpath "/tmp/box-project")');
  });
});

// ---------------------------------------------------------------------------
// Unit: forced environment (buildEnvArgs)
// ---------------------------------------------------------------------------

describe('buildEnvArgs', () => {
  test('declared config.env vars are appended as KEY=VALUE', () => {
    const args = buildEnvArgs(mergeConfig(defaultConfig, { env: { GITHUB_TOKEN: 'ghp_x' } }));
    expect(args).toContain('GITHUB_TOKEN=ghp_x');
  });

  test('config.env wins over the built-in hardening vars (appended last)', () => {
    const args = buildEnvArgs(mergeConfig(defaultConfig, { env: { GIT_AUTHOR_NAME: 'me' } }));
    // both assignments are present; `env` keeps the last one, so ours wins
    expect(args.lastIndexOf('GIT_AUTHOR_NAME=me')).toBeGreaterThan(
      args.indexOf(`GIT_AUTHOR_NAME=${defaultConfig.bot.name}`),
    );
  });

  test('no config.env keeps the arg list free of stray entries', () => {
    const args = buildEnvArgs(defaultConfig);
    expect(args.some((a) => a.startsWith('GITHUB_TOKEN='))).toBe(false);
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
