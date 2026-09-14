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
import { buildProfile, globToRegexBody } from '../src/sandbox/profile.js';
import { buildEnvArgs, resolveProjectDir } from '../src/sandbox/run.js';
import { defaultConfig, findConfigFile, mergeConfig, withExtraPaths } from '../src/utils/config.js';

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

  test('process introspection is granted so ps/top/pgrep see all processes', () => {
    expect(build()).toContain('(allow process-info*)');
  });

  test('entropy devices (/dev/random + /dev/urandom) are granted read-only', () => {
    // Language runtimes seed from these at startup — CPython fatals in
    // _Py_HashRandomization_Init if /dev/urandom is denied. Read-only: no write
    // to the entropy pool. Must match the block() layout the profile emits.
    const grant = [
      '(allow file-read*',
      '  (literal "/dev/random")',
      '  (literal "/dev/urandom")',
      ')',
    ].join('\n');
    expect(build()).toContain(grant);
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

  test('claude runtime state + MCP log caches are read-write', () => {
    // claude takes a version lock in ~/.local/state/claude/locks and writes MCP
    // log batches into ~/Library/Caches/claude-cli-nodejs. A read-only grant
    // surfaces in-box as EPERM ("Lock acquisition failed" / "Dropping log batch").
    const grant = [
      '(allow file-read* file-write*',
      `  (subpath "${path.join(os.homedir(), '.local/state/claude')}")`,
      `  (subpath "${path.join(os.homedir(), 'Library/Caches/claude-cli-nodejs')}")`,
      ')',
    ].join('\n');
    expect(build()).toContain(grant);
  });

  test('the claude auto-update cache stays read-only', () => {
    const grant = [
      '(allow file-read*',
      `  (subpath "${path.join(os.homedir(), '.cache/claude')}")`,
      ')',
    ].join('\n');
    expect(build()).toContain(grant);
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

  test('glob read-deny is compiled from config.paths.denyGlobs (gitignore-style)', () => {
    // Deny every `.env*` + triple-underscore `___*`, but re-allow `.env.example`.
    const p = build({ paths: { denyGlobs: ['**/.env*', '!**/.env.example', '**/___*'] } });
    expect(p).toContain('glob read-deny in project');
    const projRe = PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // `**/.env*` → deny read, anchored under the project at any depth
    expect(p).toContain(`(deny file-read*\n  (regex "^${projRe}/(.*/)?\\.env[^/]*(/|$)")`);
    // `!**/.env.example` → allow (the `!` re-grants, emitted after the deny)
    expect(p).toContain(`(allow file-read*\n  (regex "^${projRe}/(.*/)?\\.env\\.example(/|$)")`);
    // `**/___*` → deny read of triple-underscore entries + their contents
    expect(p).toContain(`(deny file-read*\n  (regex "^${projRe}/(.*/)?___[^/]*(/|$)")`);
  });

  test('glob read-deny lands after the project grant but before the hard deny', () => {
    // After the project RW grant so it bites inside the project; before the hard
    // secret deny so credentials stay supreme (last-match-wins).
    const p = build({ paths: { denyGlobs: ['**/.env*'] } });
    const projIdx = p.indexOf('project workspace');
    const globIdx = p.indexOf('glob read-deny in project');
    const hardIdx = p.indexOf('hard secret DENY');
    expect(globIdx).toBeGreaterThan(projIdx);
    expect(hardIdx).toBeGreaterThan(globIdx);
  });

  test('denyGlobs is empty by default, so the section is omitted', () => {
    // Opt-in feature: no patterns shipped in defaultConfig.
    expect(defaultConfig.paths.denyGlobs).toEqual([]);
    expect(build()).not.toContain('glob read-deny in project');
  });

  test('globToRegexBody translates the gitignore subset', () => {
    expect(globToRegexBody('**/.env')).toBe('\\.env');
    expect(globToRegexBody('**/.env*')).toBe('\\.env[^/]*');
    expect(globToRegexBody('**/.env.example')).toBe('\\.env\\.example');
    expect(globToRegexBody('**/___*')).toBe('___[^/]*');
    expect(globToRegexBody('.env')).toBe('\\.env'); // bare basename, no `**/`
    expect(globToRegexBody('secret?.txt')).toBe('secret[^/]\\.txt');
    expect(globToRegexBody('build/**')).toBe('build/.*');
  });

  test('clabox home gets a READ-ONLY grant re-issued AFTER the hard deny', () => {
    // The clabox home (box configs + compiled mcp/settings) lives under
    // ~/.config/clabox, which the hard `.config` deny blocks; the carve-out must
    // come AFTER it (last-match-wins) to be usable in-box. Pin a plain
    // (non-symlink) configs dir so the grant is exactly the nominal home — the
    // symlinked case is covered below.
    const home = `${realTmp('cb-extras-')}`;
    withConfigsDir(`${home}/configs`, () => {
      const p = build();
      const ro = ['(allow file-read*', `  (subpath "${home}")`, ')'].join('\n');
      const ex = ['(allow process-exec', `  (subpath "${home}")`, ')'].join('\n');
      expect(p).toContain(ro);
      expect(p).toContain(ex);
      expect(p.indexOf(ro)).toBeGreaterThan(p.indexOf('hard secret DENY'));
    });
  });

  test('clabox home is NOT writable — a box cannot rewrite its own policy', () => {
    // The box configs ARE the sandbox policy: an in-box write grant would let the
    // sandboxed agent widen its own paths/denyGlobs for the next run. No rule
    // after the hard deny may grant file-write* to the clabox home — not even via
    // a user-supplied paths.readWrite of that same dir (which is emitted BEFORE
    // the hard deny and so cannot punch through).
    const home = `${realTmp('cb-ro-home-')}`;
    withConfigsDir(`${home}/configs`, () => {
      const p = build({ paths: { readWrite: [home] } });
      const after = p.slice(p.indexOf('hard secret DENY'));
      expect(after).toContain(`(subpath "${home}")`); // the read carve-out is there…
      expect(after).not.toMatch(/\(allow[^\n]*file-write\*/); // …but no allow re-grants write
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
// Unit: ad-hoc CLI path grants (`--ro`/`--rw` → withExtraPaths)
// ---------------------------------------------------------------------------

describe('withExtraPaths (CLI --ro/--rw)', () => {
  test('nothing supplied returns the same config untouched', () => {
    expect(withExtraPaths(defaultConfig)).toBe(defaultConfig);
    expect(withExtraPaths(defaultConfig, { readOnly: [], readWrite: [] })).toBe(defaultConfig);
  });

  test('extra paths concatenate onto the box paths (additive, not replace)', () => {
    const box = mergeConfig(defaultConfig, {
      paths: { readWrite: ['/box/rw'], readOnly: ['/box/ro'], exec: ['/box/x'], deny: ['/box/no'] },
    });
    const merged = withExtraPaths(box, { readOnly: ['/cli/ro'], readWrite: ['/cli/rw'] });
    // box grants survive…
    expect(merged.paths.readOnly).toEqual(['/box/ro', '/cli/ro']);
    expect(merged.paths.readWrite).toEqual(['/box/rw', '/cli/rw']);
    // …and exec/deny are carried through unchanged
    expect(merged.paths.exec).toEqual(['/box/x']);
    expect(merged.paths.deny).toEqual(['/box/no']);
  });

  test('the extra paths land in the generated profile', () => {
    const cfg = withExtraPaths(defaultConfig, {
      readOnly: ['/tmp/cli-ro'],
      readWrite: ['/tmp/cli-rw'],
    });
    const p = buildProfile(cfg, { projectDir: PROJECT, detectedPaths: [] });
    expect(p).toContain('(subpath "/tmp/cli-ro")');
    expect(p).toContain('(subpath "/tmp/cli-rw")');
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

  test.skipIf(skipSandbox)(
    'denyGlobs blocks .env* / ___* but keeps .env.example and dunders',
    () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-glob-')));
      const projectDir = path.join(root, 'project');
      const sub = path.join(projectDir, 'sub');
      fs.mkdirSync(sub, { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'ok.txt'), 'ok');
      fs.writeFileSync(path.join(projectDir, '.env'), 'SECRET=1');
      fs.writeFileSync(path.join(projectDir, '.env.local'), 'SECRET=2');
      fs.writeFileSync(path.join(projectDir, '.env.example'), 'SECRET=');
      fs.writeFileSync(path.join(projectDir, '___private.txt'), 'hidden');
      fs.writeFileSync(path.join(projectDir, '__init__.py'), 'x = 1'); // double `_`: readable
      fs.writeFileSync(path.join(sub, '.env'), 'NESTED=1'); // depth: still denied

      const profileFile = path.join(root, 'profile.sb');
      const cfg = mergeConfig(defaultConfig, {
        network: false,
        paths: { denyGlobs: ['**/.env*', '!**/.env.example', '**/___*'] },
      });
      fs.writeFileSync(profileFile, buildProfile(cfg, { projectDir, detectedPaths: [] }));
      const cat = (p: string) =>
        spawnSync('sandbox-exec', ['-f', profileFile, '/bin/cat', p], { encoding: 'utf8' }).status;

      // ordinary files stay readable
      expect(cat(path.join(projectDir, 'ok.txt'))).toBe(0);
      // the `!` exception keeps .env.example readable…
      expect(cat(path.join(projectDir, '.env.example'))).toBe(0);
      // …and a double-underscore dunder is NOT matched by `___*` (triple), so it stays readable
      expect(cat(path.join(projectDir, '__init__.py'))).toBe(0);
      // …while every .env* (any depth) and ___* file is denied
      expect(cat(path.join(projectDir, '.env'))).not.toBe(0);
      expect(cat(path.join(projectDir, '.env.local'))).not.toBe(0);
      expect(cat(path.join(sub, '.env'))).not.toBe(0);
      expect(cat(path.join(projectDir, '___private.txt'))).not.toBe(0);

      fs.rmSync(root, { recursive: true, force: true });
    },
  );

  test.skipIf(skipSandbox)('python3 boots under the profile (entropy device is reachable)', () => {
    // Regression: without the /dev/random+urandom grant, CPython dies at preinit
    // with "_Py_HashRandomization_Init: failed to get random numbers". A bare
    // `print` proves the entropy read at startup succeeds inside the sandbox.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-py-')));
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root, detectedPaths: [] }));
    const r = spawnSync('sandbox-exec', ['-f', file, '/usr/bin/python3', '-c', 'print("ok")'], {
      encoding: 'utf8',
    });
    fs.rmSync(root, { recursive: true, force: true });
    expect(r.stderr).not.toContain('HashRandomization');
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('ok');
  });

  test.skipIf(skipSandbox)('the generated default profile is accepted by sandbox-exec', () => {
    const file = path.join(fs.realpathSync(os.tmpdir()), `cb-accept-${process.pid}.sb`);
    fs.writeFileSync(file, build());
    const r = spawnSync('sandbox-exec', ['-f', file, '/usr/bin/true']);
    fs.rmSync(file, { force: true });
    expect(r.status).toBe(0);
  });
});
