// Tests for the sandbox wrapper itself — the generated Seatbelt profile and
// the restrictions it enforces. These do NOT run or test `claude`.
//
//   bun test
//
// The functional block shells out to real `sandbox-exec` and is skipped
// automatically off macOS or when running nested inside another sandbox.

import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildProfile,
  globToRegexBody,
  grantBlock,
  pathAncestors,
  resolvedDeveloperDirs,
} from '../src/sandbox/profile.js';
import { buildEnvArgs, resolveProjectDir } from '../src/sandbox/run.js';
import {
  BASE_PATH_GROUPS,
  basePaths,
  DEFAULT_DENY_WRITE_GLOBS,
  defaultConfig,
  findConfigFile,
  mergeConfig,
  openerSocketPath,
  PRIVATE_SYMLINK_ROOTS,
  parsePathGrant,
  resolvedPathRules,
  resolvedTwin,
  untouchedBaseKeys,
  withExtraPaths,
} from '../src/utils/config.js';

const PROJECT = '/tmp/sample-project';
const build = (over: Record<string, unknown> = {}) =>
  buildProfile(mergeConfig(defaultConfig, over), { projectDir: PROJECT });

/** A canonical (symlink-resolved) tmp dir — macOS `os.tmpdir()` is under /var. */
const realTmp = (prefix: string): string =>
  fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

/**
 * One `;; ---------- <title>` section of a profile, up to the next one. SBPL is
 * last-match-wins, so a test that asserts "this rule is absent" has to look at
 * the right section — a slice running to the end of the profile also sees the
 * hard deny below it.
 */
function sectionOf(profile: string, title: string): string {
  const start = profile.indexOf(`;; ---------- ${title}`);
  if (start < 0) throw new Error(`no such profile section: ${title}`);
  const next = profile.indexOf(';; ----------', start + 1);
  return next < 0 ? profile.slice(start) : profile.slice(start, next);
}

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

  // NB: this grant is necessary but not sufficient for `ps` — /bin/ps is setuid
  // root and Seatbelt refuses to exec it at all (`forbidden-exec-sugid`). The
  // box runs the de-privileged copy from sandbox/proctools.ts instead.
  test('process introspection (libproc) is granted', () => {
    expect(build()).toContain('(allow process-info*)');
  });

  test('signals are granted, but only towards the box own processes', () => {
    const p = build();
    expect(p).toContain(
      [
        '(allow signal',
        '  (target self)',
        '  (target children)',
        '  (target same-sandbox)',
        ')',
      ].join('\n'),
    );
    // Never the blanket form: `(target others)` — or no filter at all — would
    // let the agent signal anything this uid owns, the whole desktop included.
    expect(p).not.toContain('(target others)');
    expect(p).not.toMatch(/^\(allow signal\)$/m);
  });

  test('setpriority is granted for self, so `cmd &` can be niced by job control', () => {
    expect(build()).toContain(
      ['(allow process-info-setcontrol', '  (target self)', ')'].join('\n'),
    );
  });

  test('entropy devices (/dev/random + /dev/urandom) are granted read-only', () => {
    // Language runtimes seed from these at startup — CPython fatals in
    // _Py_HashRandomization_Init if /dev/urandom is denied. Read-only: no write
    // to the entropy pool. Must match the block() layout the profile emits.
    const p = build();
    // Grouped with the other read-only `/dev` literals — one rule, same rights.
    expect(p).toContain(
      [
        '(allow file-read*',
        '  (literal "/dev")',
        '  (literal "/dev/random")',
        '  (literal "/dev/urandom")',
        ')',
      ].join('\n'),
    );
    // Read-only: the entropy pool is never written to.
    expect(p).not.toMatch(/file-write\*\n\s+\(literal "\/dev\/u?random"\)/);
  });

  test('project dir is granted read-write + exec', () => {
    const p = build();
    expect(p).toContain(`(subpath "${PROJECT}")`);
    expect(p).toContain('(allow file-read* file-write* file-map-executable');
  });

  test('network can be toggled on and off', () => {
    const on = build({ network: true });
    expect(on).toContain('(allow network-outbound\n  (remote ip)\n)');
    expect(on).toContain('(allow network-bind\n  (local ip)\n)');
    const off = build({ network: false });
    expect(off).not.toContain('(remote ip)');
    // Never the blanket form: `network*` covers unix-socket connect too, which is
    // how a box reached 1Password's ssh-agent through every file deny.
    expect(on).not.toContain('(allow network*)');
    expect(off).not.toContain('(allow network*)');
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

  test('the canonical read/write names are honored alongside the legacy aliases', () => {
    const p = build({
      paths: { readOnly: ['/tmp/legacy-ro'], read: ['/tmp/ro'], write: ['/tmp/rw'] },
    });
    expect(p).toContain(
      `(allow file-read*\n  (subpath "/tmp/legacy-ro")\n  (subpath "/tmp/ro")\n)`,
    );
    expect(p).toContain(`(allow file-read* file-write*\n  (subpath "/tmp/rw")\n)`);
  });
});

// ---------------------------------------------------------------------------
// Unit: stat(2) is a path-scoped right, not a global one
// ---------------------------------------------------------------------------

describe('stat (file-read-metadata) scoping', () => {
  // The regression this whole section exists for: a bare `(allow
  // file-read-metadata)` used to sit in the introspection block, which made
  // `stat` work on the entire disk. A box could not list
  // `~/Library/Group Containers/<team>.com.1password` but could enumerate — by
  // full path, with size and mtime — exactly what lived inside it, because
  // `file-read-metadata` and `file-read-data` are different operations and only
  // the latter was being denied.
  test('metadata is never granted globally (unfiltered)', () => {
    const p = build();
    expect(p).not.toContain('(allow file-read-metadata)');
    // Every metadata rule carries a path filter…
    for (const m of p.matchAll(/\(allow file-read-metadata\n((?:.*\n)*?)\)/g)) {
      expect(m[1]).toMatch(/\((?:literal|subpath) "/);
    }
  });

  test('the ancestors of granted paths stay stat-able, their children do not', () => {
    const p = build();
    const idx = p.indexOf('stat(2) on granted paths ancestors');
    expect(idx).toBeGreaterThan(-1);
    const tail = p.slice(idx, p.indexOf(';; ----------', idx + 1));
    // Home-relative grants (~/Library/Caches/claude-cli-nodejs, ~/Library/Keychains…)
    // pull their own chain in.
    expect(tail).toContain(`(literal "${path.join(os.homedir(), 'Library')}")`);
    // A project dir deeper than /tmp contributes its parents too. (/tmp itself
    // never shows up here: it carries a full read grant already, and paths that
    // do are skipped — `file-read*` includes `file-read-metadata`.)
    const deep = buildProfile(defaultConfig, {
      projectDir: path.join(os.homedir(), 'work/repos/app'),
    });
    const deepStart = deep.indexOf('stat(2) on granted paths ancestors');
    const deepTail = deep.slice(deepStart, deep.indexOf(';; ----------', deepStart + 1));
    expect(deepTail).toContain(`(literal "${path.join(os.homedir(), 'work')}")`);
    expect(deepTail).toContain(`(literal "${path.join(os.homedir(), 'work/repos')}")`);
    // …but never the project dir itself as a stat-only entry, and never its kids.
    expect(deepTail).not.toContain(`(literal "${path.join(os.homedir(), 'work/repos/app')}")`);
    // `literal`, never `subpath`: a stat-able ancestor must not drag in its
    // children — that's the 1Password leak all over again.
    expect(tail).not.toContain('(subpath "');
  });

  test('the ancestors rule is the LAST file rule, so it outlives the hard deny', () => {
    // It has to be: the hard deny covers ~/.config while the carve-out right
    // before it grants ~/.config/clabox, so metadata on the intervening
    // ~/.config can only come from a rule emitted after the deny.
    const p = build();
    const hardIdx = p.indexOf('hard secret DENY');
    const claboxIdx = p.indexOf('clabox home (box configs');
    const statIdx = p.indexOf('stat(2) on granted paths ancestors');
    expect(statIdx).toBeGreaterThan(claboxIdx);
    expect(claboxIdx).toBeGreaterThan(hardIdx);
    expect(p.slice(statIdx, p.indexOf(';; ----------', statIdx + 1))).toContain(
      `(literal "${path.join(os.homedir(), '.config')}")`,
    );
  });

  test('$TMPDIR container dir is stat-able even though its rule is a regex', () => {
    // `/private/var/folders/<x>/<y>/T` is granted by regex, which carries no
    // plain path for the ancestors pass — the root is registered by hand.
    const p = build();
    const from = p.indexOf('stat(2) on granted');
    expect(p.slice(from, p.indexOf(';; ----------', from + 1))).toContain(
      '(literal "/private/var/folders")',
    );
  });

  test('paths.stat grants metadata only — no contents, no listing', () => {
    const p = build({ paths: { stat: ['/tmp/peek'] } });
    expect(p).toContain('box grants (config.paths)');
    expect(p).toContain(`(allow file-read-metadata\n  (subpath "/tmp/peek")\n)`);
    // …and nothing wider for that path.
    expect(p).not.toContain(`(allow file-read*\n  (subpath "/tmp/peek")`);
  });

  test('paths.stat is emitted before the hard deny, so it cannot uncover secrets', () => {
    const p = build({ paths: { stat: [os.homedir()] } });
    const statIdx = p.indexOf('box grants (config.paths)');
    const hardIdx = p.indexOf('hard secret DENY');
    expect(statIdx).toBeGreaterThan(-1);
    expect(hardIdx).toBeGreaterThan(statIdx);
  });

  test('a path in two classes gets both, i.e. the wider one', () => {
    // The classes are folded into one `path: rights` table, so a path named in
    // both `stat` and `write` comes out as a single writable rule rather than two
    // rules whose order would decide the outcome.
    const p = build({ paths: { stat: ['/tmp/both'], write: ['/tmp/both'] } });
    expect(p).toContain(
      '(allow file-read* file-write* file-read-metadata\n  (subpath "/tmp/both")\n)',
    );
    expect(p.match(/\(subpath "\/tmp\/both"\)/g)).toHaveLength(1);
  });

  test('pathAncestors walks up to / and never includes the path itself', () => {
    expect(pathAncestors('/a/b/c')).toEqual(['/a/b', '/a', '/']);
    expect(pathAncestors('/a')).toEqual(['/']);
    expect(pathAncestors('/')).toEqual([]);
  });

  test('resolvedPathRules folds the aliases into read/write', () => {
    const r = resolvedPathRules({
      readOnly: ['/ro'],
      readWrite: ['/rw'],
      read: ['/r'],
      write: ['/w'],
      stat: ['/s'],
      exec: [],
      deny: [],
      denyGlobs: [],
    });
    expect(r.read).toEqual(['/ro', '/r']);
    expect(r.write).toEqual(['/rw', '/w']);
    expect(r.stat).toEqual(['/s']);
  });

  test('stat defaults to empty — the three-class split is opt-in per path', () => {
    expect(defaultConfig.paths.stat).toEqual([]);
    expect(build()).not.toContain('extra stat-only paths');
  });
});

// ---------------------------------------------------------------------------
// Unit: the base policy is data (BASE_PATH_GROUPS), overridable per box
// ---------------------------------------------------------------------------

describe('base path policy', () => {
  test('every built-in grant is seeded into defaultConfig.paths', () => {
    for (const [p, rights] of Object.entries(basePaths())) {
      expect((defaultConfig.paths as Record<string, unknown>)[p]).toBe(rights);
    }
  });

  test('each group compiles into its own section, in table order', () => {
    const p = build();
    let at = -1;
    for (const group of BASE_PATH_GROUPS) {
      const idx = p.indexOf(group.title);
      expect(idx).toBeGreaterThan(at); // sections keep the table's order
      at = idx;
    }
  });

  test('rights letters map onto the SBPL operations they claim', () => {
    expect(grantBlock({ '/x': 'r' })).toBe('(allow file-read*\n  (subpath "/x")\n)');
    expect(grantBlock({ '/x': 'rl' })).toBe('(allow file-read*\n  (literal "/x")\n)');
    // `w` implies `r` — a write-only path would be a trap
    expect(grantBlock({ '/x': 'w' })).toBe('(allow file-read* file-write*\n  (subpath "/x")\n)');
    expect(grantBlock({ '/x': 'rme' })).toBe(
      '(allow file-read* file-map-executable process-exec\n  (subpath "/x")\n)',
    );
    expect(grantBlock({ '^/dev/tty.*': 'i' })).toBe(
      '(allow file-ioctl\n  (regex "^/dev/tty.*")\n)',
    );
    // a deny covers the file classes AND the socket class
    expect(grantBlock({ '/x': 'd' })).toBe(
      '(deny file-read* file-write*\n  (subpath "/x")\n)\n(deny network-outbound\n  (subpath "/x")\n)',
    );
  });

  test('paths with the same rights are grouped into one rule', () => {
    expect(grantBlock({ '/a': 'r', '/b': 'r', '/c': 'w' })).toBe(
      [
        '(allow file-read*',
        '  (subpath "/a")',
        '  (subpath "/b")',
        ')',
        '(allow file-read* file-write*',
        '  (subpath "/c")',
        ')',
      ].join('\n'),
    );
  });

  // The point of moving the policy into config: a box can change it. An override
  // is emitted with the box's own grants (after the soft deny) so it can widen a
  // default; `'d'` there takes a default away.
  test('a box can widen a base path, and the override lands after the soft deny', () => {
    const p = build({ paths: { '/': 'w' } });
    const softIdx = p.indexOf('soft privacy DENY');
    const boxIdx = p.indexOf('box grants (config.paths)');
    expect(boxIdx).toBeGreaterThan(softIdx);
    expect(p.slice(boxIdx)).toContain('(allow file-read* file-write*\n  (subpath "/")\n)');
    // …while the default entry for `/` is still in its own section above
    expect(p.slice(0, softIdx)).toContain('(literal "/")');
  });

  test("a box can take a base grant away with 'd'", () => {
    const keychain = path.join(os.homedir(), 'Library/Keychains');
    const p = build({ paths: { '~/Library/Keychains': 'd' } });
    const softIdx = p.indexOf('soft privacy DENY');
    // The base grant is above; the `d` joins the soft deny tier below it, and
    // last-match-wins makes the deny the effective rule.
    expect(p.indexOf(`(subpath "${keychain}")`)).toBeLessThan(softIdx);
    const soft = p.slice(softIdx, p.indexOf(';; ----------', softIdx + 1));
    expect(soft).toContain(`(subpath "${keychain}")`);
    // …and the socket class is denied with it.
    expect(soft).toContain('(deny network-outbound');
  });

  test('untouchedBaseKeys separates defaults from overrides', () => {
    const plain = untouchedBaseKeys(defaultConfig.paths);
    expect(plain.has('/')).toBe(true);
    const overridden = untouchedBaseKeys(mergeConfig(defaultConfig, { paths: { '/': 'w' } }).paths);
    expect(overridden.has('/')).toBe(false);
    expect(overridden.has('/usr')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Unit: unix sockets are networking, and denied unless named
// ---------------------------------------------------------------------------

describe('unix-socket grants', () => {
  // The hole this closes: a socket connect(2) is authorized as `network-outbound`
  // with a path filter, NOT as a file operation, so the blanket `(allow network*)`
  // the profile used to emit handed the box every unix socket on the machine. A
  // box denied read, write and stat on ~/Library/Group Containers/<team>.com.1password
  // could still run `ssh-add -l` against the agent socket inside it and have the
  // agent sign — i.e. authenticate as the user.
  test('IP is granted by family; the blanket network* form is never emitted', () => {
    const p = build();
    expect(p).toContain('(allow network-outbound\n  (remote ip)\n)');
    expect(p).not.toContain('(allow network*)');
    expect(p).not.toMatch(/\(allow network-outbound\)/);
  });

  /** Every path named in an `(allow network-outbound …)` block, de-duplicated. */
  function socketsOf(p: string): string[] {
    const sockets = [...p.matchAll(/\(allow network-outbound\n((?:\s+\([^\n]*\)\n)*)\)/g)].flatMap(
      (m) => [...m[1].matchAll(/\((?:literal|subpath) "([^"]+)"\)/g)].map((x) => x[1]),
    );
    return [...new Set(sockets)].sort();
  }

  test('only the resolver and the opener broker are granted by default', () => {
    // The resolver socket is base policy (DNS breaks without it). The opener
    // broker's socket is granted to every box because the broker is a user-run
    // convenience that works from any box — and the socket only exists while
    // the user is running one, so the grant alone opens nothing. claude's daemon
    // dir is NOT here — see the next test.
    expect(socketsOf(build())).toEqual(
      [openerSocketPath(), '/private/var/run/mDNSResponder'].sort(),
    );
  });

  test('a box can opt out of the opener, and then it gets no socket', () => {
    expect(socketsOf(build({ opener: { enabled: false } }))).toEqual([
      '/private/var/run/mDNSResponder',
    ]);
  });

  test('the daemon socket follows the feature that needs it (remoteControl)', () => {
    // `/tmp/cc-daemon-<uid>` is the channel to the singleton `claude daemon`,
    // which runs OUTSIDE every box and can re-host this session with no profile.
    // The env guard that closes that escape is cooperative (a var inside a
    // process the agent controls), so a box that never uses `/rc` shouldn't get
    // the channel either. `--rc` / `remoteControl` opens it; a box that opted
    // into background tasks needs it too.
    const daemonDir = `/private/tmp/cc-daemon-${process.getuid?.() ?? ''}`;
    expect(socketsOf(build())).not.toContain(daemonDir);
    expect(socketsOf(build({ remoteControl: true }))).toContain(daemonDir);
    expect(socketsOf(build({ allowBackgroundTasks: true }))).toContain(daemonDir);
  });

  test('paths.socket / `c` opens exactly one socket, as both literal and subpath', () => {
    const viaClass = build({ paths: { socket: ['/var/run/docker.sock'] } });
    const viaRight = build({ paths: { '/var/run/docker.sock': 'c' } });
    for (const p of [viaClass, viaRight]) {
      expect(p).toContain('(literal "/var/run/docker.sock")');
      expect(p).toContain('(subpath "/var/run/docker.sock")');
      // …and nothing file-ish comes with it: `c` is orthogonal to r/w/s.
      expect(p).not.toContain('(allow file-read*\n  (subpath "/var/run/docker.sock")');
    }
  });

  test('sockets are granted even with network: false (local IPC is not internet)', () => {
    const p = build({ network: false, paths: { '/var/run/docker.sock': 'c' } });
    expect(p).toContain('(literal "/var/run/docker.sock")');
    expect(p).not.toContain('(remote ip)');
  });

  test('a denied path also loses socket connect', () => {
    const p = build({ paths: { '~/Library/Group Containers': 'd' } });
    const home = os.homedir();
    expect(p).toContain(`(deny network-outbound\n  (subpath "${path.join(home, 'Documents')}")`);
    expect(p).toContain(`(subpath "${path.join(home, 'Library/Group Containers')}")`);
  });

  test("'c' parses from the letter and from the words", () => {
    expect([...parsePathGrant('c')]).toEqual(['c']);
    expect([...parsePathGrant(['socket'])]).toEqual(['c']);
    expect([...parsePathGrant(['connect'])]).toEqual(['c']);
    expect([...parsePathGrant('rc')]).toEqual(['r', 'c']);
  });

  test('socket defaults to empty in the config', () => {
    expect(defaultConfig.paths.socket).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Unit: every grant is spelled in RESOLVED form
//
// Seatbelt matches rules against the resolved vnode path, so a grant under a
// symlinked root (`/etc`, `/tmp`, `/var` → `/private/*`) authorizes nothing
// unless the `/private/...` spelling is there too. This is a whole class of
// silent failure — the rule is in the profile, the profile compiles, and the
// access is still denied — and it has bitten this project twice: `/etc/ssl`
// (the system `curl` then rejects all HTTPS, which reads as "no network") and
// `/var/select/developer_dir` (no `git`, no `python3`, because every toolchain
// shim reads that link first).
// ---------------------------------------------------------------------------

describe('base-policy paths are resolved-form (the /private pairing)', () => {
  test('every path under a symlinked root has its /private twin granted', () => {
    const table = basePaths();
    const missing = Object.keys(table)
      .map((key) => ({ key, twin: resolvedTwin(key) }))
      .filter(({ twin }) => twin !== null)
      .filter(({ twin }) => !((twin as string) in table))
      .map(({ key, twin }) => `${key} (needs ${twin})`);
    expect(missing).toEqual([]);
  });

  test('the roots themselves are granted as themselves, not paired', () => {
    // A root IS the symlink, so reading it is reading that path — `/etc` carries
    // `'sl'` (metadata on the link only) and `/tmp` is spelled both ways because
    // it's a tree. `resolvedTwin` must not ask for a twin of a root itself.
    for (const root of PRIVATE_SYMLINK_ROOTS) expect(resolvedTwin(root)).toBeNull();
  });

  test('resolvedTwin only speaks about paths that need a twin', () => {
    expect(resolvedTwin('/var/select')).toBe('/private/var/select');
    expect(resolvedTwin('/etc/ssl')).toBe('/private/etc/ssl');
    // Already resolved, a regex, a `~` path, or an unrelated root: no twin.
    expect(resolvedTwin('/private/var/select')).toBeNull();
    expect(resolvedTwin('^/private/var/folders/')).toBeNull();
    expect(resolvedTwin('~/.npm')).toBeNull();
    expect(resolvedTwin('/usr/bin/env')).toBeNull();
  });

  test('the toolchain links a shim reads are granted in resolved form', () => {
    // The regression this pins: `xcode-select: unable to read data link at
    // '/var/select/developer_dir'` — the shims read the link before exec'ing
    // anything, so an unresolved grant leaves the box with no git and no python3.
    const p = build();
    expect(p).toContain('(subpath "/private/var/select")');
    expect(p).toContain('(literal "/private/var/db/xcode_select_link")');
  });
});

// ---------------------------------------------------------------------------
// Unit: `~/.local` is granted per toolchain, never as one tree
//
// The regression: `detectPackagePaths()` probed the filesystem and, finding
// `~/.local` (every machine has one — claude installs itself there), emitted
// `(allow file-read* file-map-executable process-exec (subpath "~/.local"))`.
// XDG keeps *application data* under `~/.local/share`, so that single rule gave
// every box read access to things no config ever mentioned — app databases,
// notes, chat history — and it did so invisibly: the box config said nothing and
// the profile named only `~/.local`.
// ---------------------------------------------------------------------------

describe('~/.local is granted per toolchain, not as a tree', () => {
  const local = path.join(os.homedir(), '.local');

  test('the whole-tree grant is gone', () => {
    const p = build();
    expect(p).not.toContain(`(subpath "${local}")`);
    expect(p).not.toContain(`(subpath "${path.join(local, 'share')}")`);
  });

  test('the named toolchain roots are granted', () => {
    const p = build();
    // `~/.local/bin` holds only symlinks into `~/.local/share/<tool>/…` and
    // Seatbelt matches the resolved path, so each target root needs its own
    // entry. `share/claude` is the load-bearing one: that is where the native
    // installer puts the binary clabox execs.
    for (const dir of ['bin', 'lib', 'share/claude', 'share/mise', 'share/uv']) {
      expect(p).toContain(`(subpath "${path.join(local, dir)}")`);
    }
  });

  test('a box can grant one more app dir without reopening the tree', () => {
    const extra = path.join(local, 'share/some-app');
    const p = build({ paths: { [extra]: 'r' } });
    expect(p).toContain(`(subpath "${extra}")`);
    expect(p).not.toContain(`(subpath "${local}")`);
  });
});

// ---------------------------------------------------------------------------
// Unit: Launch Services / `open` — the always-available escape
// ---------------------------------------------------------------------------

describe('Launch Services (`open`) is off by default', () => {
  // Why this matters more than it looks: `open` doesn't fork anything inside the
  // box. It asks LaunchServices — which lives outside every sandbox — to start a
  // target, and the target comes up under launchd with NO profile. Since the box
  // can write `.app` bundles into /tmp, $TMPDIR and the project dir, a granted
  // `lsopen` is arbitrary code execution as the user, with no daemon needed.
  test('no lsopen and no Launch Services mach services in the default profile', () => {
    const p = build();
    expect(p).not.toContain('(allow lsopen)');
    expect(p).not.toContain('launchservicesd');
    expect(p).not.toContain('coreservicesd');
    expect(p).not.toContain('lsd.modifydb');
    expect(p).not.toContain('com\\.apple\\.lsd');
  });

  test('the read-only type database stays granted (it cannot start anything)', () => {
    expect(build()).toContain('com.apple.lsd.mapdb');
  });

  test('allowOpen: true emits them together, in one labelled section', () => {
    const p = build({ allowOpen: true });
    expect(p).toContain('(allow lsopen)');
    expect(p).toContain('com.apple.coreservices.launchservicesd');
    expect(p).toContain('com.apple.lsd.modifydb');
    expect(p).toMatch(/ESCAPE HATCH/);
  });

  test('defaultConfig keeps both escape hatches shut', () => {
    expect(defaultConfig.allowOpen).toBe(false);
    expect(defaultConfig.allowBackgroundTasks).toBe(false);
    expect(defaultConfig.remoteControl).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unit: glob write-deny — files the box writes but something else executes
// ---------------------------------------------------------------------------

describe('glob write-deny in the project', () => {
  test('the default list denies writes to the launch-time config and git hooks', () => {
    const p = build();
    const section = sectionOf(p, 'glob write-deny');
    // read stays untouched — these are only write denies…
    expect(section).toContain('(deny file-write*');
    expect(section).not.toContain('(deny file-read*');
    // …and each pattern is anchored under the project dir, at any depth. The
    // backslashes are doubled because an SBPL string eats its own escapes
    // before the regex engine sees them (see `reQ` in profile.ts).
    for (const body of [
      'clabox\\\\.config\\\\.',
      '\\\\.git/config',
      '\\\\.git/hooks',
      '\\\\.envrc',
    ]) {
      expect(section).toContain(`^${PROJECT}/(.*/)?${body}`);
    }
  });

  test('DEFAULT_DENY_WRITE_GLOBS is what the config ships', () => {
    expect(defaultConfig.paths.denyWriteGlobs).toEqual(DEFAULT_DENY_WRITE_GLOBS);
  });

  test('a box can replace the list, and `!` re-allows (last match wins)', () => {
    const p = build({ paths: { denyWriteGlobs: ['**/dist', '!**/dist/keep.js'] } });
    const section = sectionOf(p, 'glob write-deny');
    expect(section).toContain(`(deny file-write*\n  (regex "^${PROJECT}/(.*/)?dist(/|$)")`);
    // The re-allow is emitted after the deny, so SBPL's last-match-wins picks it.
    expect(section.indexOf('(allow file-write*')).toBeGreaterThan(
      section.indexOf('(deny file-write*'),
    );
    expect(p).not.toContain('clabox\\.config\\.');
  });

  test('an empty list emits no section at all', () => {
    expect(build({ paths: { denyWriteGlobs: [] } })).not.toContain('glob write-deny');
  });

  test('the hard secret deny still comes last', () => {
    const p = build();
    expect(p.indexOf('hard secret DENY')).toBeGreaterThan(p.indexOf('glob write-deny'));
  });
});

// ---------------------------------------------------------------------------
// Unit: the per-path grant syntax — `'<path>': '<rights>'`
// ---------------------------------------------------------------------------

describe('per-path grants (paths: { "<path>": "rwes" })', () => {
  test('one path, its rights: r / w / s / e land in the matching class', () => {
    const p = build({
      paths: {
        '/tmp/ro': 'r',
        '/tmp/rw': 'w',
        '/tmp/peek': 's',
        '/tmp/bin': ['r', 'e'],
      },
    });
    expect(p).toContain(`(allow file-read-metadata\n  (subpath "/tmp/peek")\n)`);
    expect(p).toContain(`(allow file-read*\n  (subpath "/tmp/ro")\n)`);
    expect(p).toContain(`(allow file-read* file-write*\n  (subpath "/tmp/rw")\n)`);
    // `['r','e']` is one path with two rights → one rule carrying both ops.
    expect(p).toContain(`(allow file-read* process-exec\n  (subpath "/tmp/bin")\n)`);
  });

  test("'d' denies, landing in the soft (overridable) deny tier", () => {
    const p = build({ paths: { '/tmp/nope': 'd' } });
    const softIdx = p.indexOf('soft privacy DENY');
    const hardIdx = p.indexOf('hard secret DENY');
    const at = p.indexOf('(subpath "/tmp/nope")');
    expect(at).toBeGreaterThan(softIdx);
    expect(at).toBeLessThan(hardIdx);
  });

  test('both spellings coexist in one object, per-class first', () => {
    const p = build({ paths: { readOnly: ['/tmp/legacy'], '/tmp/modern': 'r' } });
    expect(p).toContain(
      `(allow file-read*\n  (subpath "/tmp/legacy")\n  (subpath "/tmp/modern")\n)`,
    );
  });

  // How the two spellings behave under `mergeConfig`: `deepMerge` recurses into
  // `paths`, so two layers' path KEYS both survive, while a per-class array is
  // replaced by the later layer. NB this is about clabox's own merge (defaults ⊕
  // config file). A preset spread *inside* a config file is plain JS, so
  // `paths: {…}` there replaces the preset's object either way and still needs
  // `...preset.paths` — what the per-path form saves is the per-class spreading.
  test('per-path keys merge across layers; per-class arrays replace', () => {
    const preset = mergeConfig(defaultConfig, { paths: { '~/preset-dir': 'r' } });
    // (both keys are the box's own — base-policy keys are emitted separately)
    const box = mergeConfig(preset, { paths: { '~/box-dir': 'w' } });
    // `untouchedBaseKeys` is what the profile passes: the base-policy entries
    // seeded into defaultConfig are emitted by their own sections, so they're not
    // part of the box's grant list.
    const rules = resolvedPathRules(box.paths, untouchedBaseKeys(box.paths));
    expect(rules.read).toEqual(['~/preset-dir']); // `w` implies read later, in grantBlock
    expect(rules.write).toEqual(['~/box-dir']);
    // …whereas the list form replaces, which is the trap it has always been.
    const listBox = mergeConfig(mergeConfig(defaultConfig, { paths: { read: ['~/a'] } }), {
      paths: { read: ['~/b'] },
    });
    expect(resolvedPathRules(listBox.paths, untouchedBaseKeys(listBox.paths)).read).toEqual([
      '~/b',
    ]);
  });

  // A path named twice (preset + box, or two classes) collapses to one entry:
  // object keys are unique, which the per-class lists never were.
  test('a path declared twice collapses instead of being emitted twice', () => {
    const p = build({ paths: { readWrite: ['/tmp/dup'], '/tmp/dup': 'w' } });
    expect(p.match(/\(subpath "\/tmp\/dup"\)/g)).toHaveLength(1);
  });

  test('rights accept letters, letter runs and whole words', () => {
    expect([...parsePathGrant('rw')]).toEqual(['r', 'w']);
    expect([...parsePathGrant(['r', 'w'])]).toEqual(['r', 'w']);
    expect([...parsePathGrant(['read', 'exec'])]).toEqual(['r', 'e']);
    expect([...parsePathGrant('ro')]).toEqual(['r']);
    expect([...parsePathGrant(['rw', 'e'])]).toEqual(['r', 'w', 'e']);
  });

  // A typo must never widen the sandbox silently — every rejection below would
  // otherwise read as "no rights parsed, carry on".
  test('a bad grant throws instead of being ignored', () => {
    expect(() => parsePathGrant('x', '/tmp/x')).toThrow(/unknown right 'x'/);
    expect(() => parsePathGrant('', '/tmp/x')).toThrow(/empty rights/);
    expect(() => parsePathGrant('rd', '/tmp/x')).toThrow(/contradictory/);
  });

  test('a key that is neither a field nor a path throws (catches `readWritte`)', () => {
    expect(() => resolvedPathRules({ readWritte: ['/tmp/x'] } as never)).toThrow(
      /unknown paths key 'readWritte'/,
    );
    // …while a relative path is accepted, since `.`-prefixed keys are paths.
    expect(resolvedPathRules({ './local': 'r' }).read).toEqual(['./local']);
  });

  test('hard secret deny is emitted AFTER a broad readOnly so it cannot be overridden', () => {
    // A box may grant read across the whole disk; secrets must still win.
    const p = build({ paths: { readWrite: [], readOnly: ['/'], exec: [], deny: [] } });
    const roIdx = p.indexOf('box grants (config.paths)');
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
    // Every `\` is DOUBLED in the emitted SBPL string — an SBPL string eats its
    // own escapes before the regex engine sees them, so a single `\.` would reach
    // the matcher as a bare `.` (any character). See the reQ() note in profile.ts.
    const projRe = PROJECT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\/g, '\\\\');
    // `**/.env*` → deny read, anchored under the project at any depth
    expect(p).toContain(`(deny file-read*\n  (regex "^${projRe}/(.*/)?\\\\.env[^/]*(/|$)")`);
    // `!**/.env.example` → allow (the `!` re-grants, emitted after the deny)
    expect(p).toContain(
      `(allow file-read*\n  (regex "^${projRe}/(.*/)?\\\\.env\\\\.example(/|$)")`,
    );
    // `**/___*` → deny read of triple-underscore entries + their contents
    expect(p).toContain(`(deny file-read*\n  (regex "^${projRe}/(.*/)?___[^/]*(/|$)")`);
  });

  // Regression, found the hard way: a box with `denyGlobs: ['**/.env*']` denied
  // `_envs.mjs` (and `aenv`, and any `?env*`), because the profile emitted a
  // single-backslash `\.env` that the SBPL string parser reduced to `.env`. The
  // symptom is an EPERM on a file nobody listed, e.g. a config `import`ing
  // `./_envs.mjs` from inside the project.
  test('a regex dot is emitted escaped, so `.env*` cannot match `_envs.mjs`', () => {
    const p = build({ paths: { denyGlobs: ['**/.env*'] } });
    expect(p).toContain('\\\\.env');
    expect(p).not.toMatch(/\(regex "[^"]*[^\\]\\\.env/);
    // Same for the hard secret deny, which is regex-based too.
    expect(p).toContain('\\\\.ssh/id_');
    expect(p).toContain('\\\\.(aws|gnupg|kube|docker|config)');
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

  describe('Xcode / Command Line Tools', () => {
    test('grants the static toolchain pair', () => {
      const p = build();
      expect(p).toContain('(subpath "/Library/Developer/CommandLineTools")');
      expect(p).toContain('(subpath "/Applications/Xcode.app")');
    });

    // `/usr/bin/python3` & co exec the *selected* toolchain, and Seatbelt matches
    // the symlink-resolved path — so a CI runner's versioned bundle
    // (`Xcode_16.4.app` behind an `Xcode.app` link) has to be granted explicitly
    // or CPython dies at preinit. Machine-dependent by nature: assert the
    // profile carries whatever the resolver found, which holds on every host.
    test('grants the resolved developer dir too, for read and exec', () => {
      const p = build();
      const execSection = p.slice(p.indexOf('Xcode / Command Line Tools'));
      for (const dir of resolvedDeveloperDirs()) {
        expect(p).toContain(`(subpath "${dir}")`);
        expect(execSection).toContain(`(subpath "${dir}")`);
      }
    });

    test('never repeats a dir that is already granted statically', () => {
      expect(resolvedDeveloperDirs()).not.toContain('/Applications/Xcode.app');
      expect(resolvedDeveloperDirs()).not.toContain('/Library/Developer/CommandLineTools');
    });

    // Granting the bundle is useless if the shim can't read the link that selects
    // it: `/usr/bin/{git,python3,clang}` resolve the active toolchain through
    // `xcode-select`'s link first and die on `unable to read data link at
    // '/var/select/developer_dir'`. Apple moved the link (`/var/db/…` ≤ macOS 15,
    // `/var/select/…` on 26+), so both locations must be in the profile.
    test("both of xcode-select's link locations are readable", () => {
      const p = build();
      expect(p).toContain('(subpath "/var/select")');
      expect(p).toContain('(literal "/var/db/xcode_select_link")');
    });
  });

  // Seatbelt matches the resolved path, so a *resolved* grant is what authorizes
  // the open — but walking a path through a symlinked ancestor also reads that
  // link, and the stat-ancestors pass only climbs above granted paths. A path
  // whose children are granted only under the resolved name therefore needs its
  // symlink form spelled out by hand.
  describe('symlinked system dirs are granted in both forms', () => {
    test('/etc gets metadata so a lookup can pass through it to /private/etc', () => {
      const p = build();
      expect(p).toContain('(subpath "/private/etc")');
      // literal, not subpath: the link itself, never a tree below it.
      expect(p).toContain('(literal "/etc")');
    });

    test('the /etc grant is metadata-only — contents come from /private/etc', () => {
      const etcRule = build()
        .split('\n\n')
        .find((s) => s.includes('(literal "/etc")')) as string;
      expect(etcRule).toContain('(allow file-read-metadata');
      expect(etcRule).not.toContain('file-write*');
    });

    test('/tmp keeps the same symlink + resolved pair', () => {
      const p = build();
      expect(p).toContain('(subpath "/tmp")');
      expect(p).toContain('(subpath "/private/tmp")');
    });
  });

  describe('package-manager caches', () => {
    // npm mkdirs `_cacache/tmp` on every command and reports any EPERM here as
    // "your cache folder contains root-owned files, run sudo chown" — a cause that
    // is never the real one in a box.
    test('the npm cache is read-write', () => {
      const npmDir = path.join(os.homedir(), '.npm');
      const section = build().slice(build().indexOf(';; ---------- package-manager caches'));
      expect(section).toContain(`(allow file-read* file-write*\n  (subpath "${npmDir}")\n)`);
    });

    test("it is base-policy data, so a box can drop it with 'd'", () => {
      expect(basePaths()['~/.npm']).toBe('rw');
      const npmDir = path.join(os.homedir(), '.npm');
      const p = build({ paths: { '~/.npm': 'd' } });
      const softIdx = p.indexOf('soft privacy DENY');
      // Same shape as every other base override: the grant stays in its own
      // section above, the `d` joins the soft deny below, and last-match-wins
      // makes the deny the effective rule.
      expect(p.indexOf(`(subpath "${npmDir}")`)).toBeLessThan(softIdx);
      expect(p.slice(softIdx, p.indexOf(';; ----------', softIdx + 1))).toContain(
        `(subpath "${npmDir}")`,
      );
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
    const p = buildProfile(cfg, { projectDir: PROJECT });
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
    const p = buildProfile(cfg, { projectDir: resolveProjectDir(cfg) });
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
    fs.writeFileSync(profileFile, buildProfile(cfg, { projectDir }));

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
      // `_envs.mjs` and `aenv` must stay readable: `.env*` means a literal dot.
      // They did not, until the regex dot was emitted escaped (see reQ()).
      fs.writeFileSync(path.join(projectDir, '_envs.mjs'), 'export default {}');
      fs.writeFileSync(path.join(projectDir, 'aenv'), 'x');

      const profileFile = path.join(root, 'profile.sb');
      const cfg = mergeConfig(defaultConfig, {
        network: false,
        paths: { denyGlobs: ['**/.env*', '!**/.env.example', '**/___*'] },
      });
      fs.writeFileSync(profileFile, buildProfile(cfg, { projectDir }));
      const cat = (p: string) =>
        spawnSync('sandbox-exec', ['-f', profileFile, '/bin/cat', p], { encoding: 'utf8' }).status;

      // ordinary files stay readable
      expect(cat(path.join(projectDir, 'ok.txt'))).toBe(0);
      // …including the near-misses an unescaped dot used to swallow
      expect(cat(path.join(projectDir, '_envs.mjs'))).toBe(0);
      expect(cat(path.join(projectDir, 'aenv'))).toBe(0);
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

  // The three access classes, against a real kernel. `stat` is the one that used
  // to be unconditional: a bare `(allow file-read-metadata)` meant a box could
  // probe any path on the disk for existence, size and mtime while its `ls` and
  // `cat` were denied — which is how `~/Library/Group Containers/<team>.com.1password`
  // stayed enumerable in a box that could not open a single file in it.
  test.skipIf(skipSandbox)('stat is denied outside the granted paths', () => {
    const root = realTmp('cb-stat-');
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'ok.txt'), 'hello');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(
      file,
      buildProfile(mergeConfig(defaultConfig, { network: false }), {
        projectDir,
      }),
    );
    const stat = (p: string) =>
      spawnSync('sandbox-exec', ['-f', file, '/usr/bin/stat', '-f', '%z', p], {
        encoding: 'utf8',
      });

    // Inside the project: granted for read, so metadata comes along.
    expect(stat(path.join(projectDir, 'ok.txt')).status).toBe(0);
    // An ancestor of a granted path: stat-able by the final metadata rule, which
    // is what keeps `cd`/`realpath`/module resolution from hitting EPERM midway.
    expect(stat(os.homedir()).status).toBe(0);
    // Neither granted nor explicitly denied — `(deny default)` now covers it.
    // (`/Library/Application Support` exists on every macOS and is not granted;
    // its parent `/Library` is, which is exactly the boundary being asserted.)
    expect(stat('/Library/Application Support').status).not.toBe(0);
    expect(stat('/Library').status).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });

  test.skipIf(skipSandbox)('paths.stat re-opens stat and strictly nothing else', () => {
    const root = realTmp('cb-statonly-');
    const projectDir = path.join(root, 'project');
    const peek = path.join(root, 'peek');
    fs.mkdirSync(projectDir);
    fs.mkdirSync(peek);
    fs.writeFileSync(path.join(peek, 'file.txt'), 'contents');

    // Denied for read AND listed in `stat`: the stat grant is emitted after the
    // soft deny, so metadata wins while contents stay denied.
    const cfg = mergeConfig(defaultConfig, {
      network: false,
      paths: { deny: [peek], stat: [peek] },
    });
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(cfg, { projectDir }));
    const run = (bin: string, ...a: string[]) =>
      spawnSync('sandbox-exec', ['-f', file, bin, ...a], { encoding: 'utf8' });

    const sized = run('/usr/bin/stat', '-f', '%z', path.join(peek, 'file.txt'));
    expect(`status=${sized.status}\nstderr=${sized.stderr}`).toBe('status=0\nstderr=');
    expect(sized.stdout.trim()).toBe('8');
    // …but the contents are still out of reach, and so is the listing.
    expect(run('/bin/cat', path.join(peek, 'file.txt')).status).not.toBe(0);
    expect(run('/bin/ls', peek).status).not.toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });

  // Regression for the ancestors pass: $TMPDIR sits under a `regex` rule, which
  // carries no plain path to walk up from, so its container dir is registered by
  // hand. Without that, `mkdtemp` fails on the way down to the granted leaf.
  test.skipIf(skipSandbox)('mkdtemp inside $TMPDIR still works without global stat', () => {
    const root = realTmp('cb-tmpdir-');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));
    const r = spawnSync(
      'sandbox-exec',
      [
        '-f',
        file,
        '/usr/bin/python3',
        '-c',
        'import tempfile,os;print(os.path.isdir(tempfile.mkdtemp()))',
      ],
      { encoding: 'utf8' },
    );
    fs.rmSync(root, { recursive: true, force: true });
    expect(`status=${r.status}\nstderr=${r.stderr}`).toBe('status=0\nstderr=');
    expect(r.stdout.trim()).toBe('True');
  });

  // The socket boundary, against a real kernel: a unix socket is reachable only
  // when the box names it. Both halves matter — the deny is the point, and the
  // opt-in has to actually work or a box that needs docker.sock is stuck.
  test.skipIf(skipSandbox)('a unix socket is denied unless the box names it', () => {
    const root = realTmp('cb-sock-');
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    const sockPath = path.join(root, 'agent.sock');

    // A server OUTSIDE any sandbox, exactly like 1Password's agent.
    const server = spawnSync('/usr/bin/python3', [
      '-c',
      `import socket,os,sys,time
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
s.bind(${JSON.stringify(sockPath)})
s.listen(8)
print("up", flush=True)
os.fork() and sys.exit(0)
t=time.time()
while time.time()-t < 30:
    try:
        c,_=s.accept(); c.close()
    except OSError: break`,
    ]);
    expect(server.status).toBe(0);

    const connect = (profileFile: string) =>
      spawnSync(
        'sandbox-exec',
        [
          '-f',
          profileFile,
          '/usr/bin/python3',
          '-c',
          `import socket,sys
s=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
try:
    s.connect(${JSON.stringify(sockPath)}); print("CONNECTED")
except Exception as e:
    print("DENIED", e)`,
        ],
        { encoding: 'utf8' },
      ).stdout.trim();

    // /tmp is granted read-write, so the socket FILE is fully accessible — the
    // only thing standing between the box and the agent is the network rule.
    const closed = path.join(root, 'closed.sb');
    fs.writeFileSync(closed, buildProfile(defaultConfig, { projectDir }));
    expect(connect(closed)).toContain('DENIED');

    const opened = path.join(root, 'opened.sb');
    fs.writeFileSync(
      opened,
      buildProfile(mergeConfig(defaultConfig, { paths: { [sockPath]: 'c' } }), {
        projectDir,
      }),
    );
    expect(connect(opened)).toContain('CONNECTED');

    fs.rmSync(root, { recursive: true, force: true });
  });

  // IP networking must survive the split — the box still has to reach the API.
  test.skipIf(skipSandbox)('TCP to a local listener still works', () => {
    const root = realTmp('cb-tcp-');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));

    const srv = spawn('/usr/bin/python3', [
      '-c',
      `import socket,sys
s=socket.socket(); s.bind(("127.0.0.1",0)); s.listen(4)
print(s.getsockname()[1], flush=True)
s.settimeout(30)
try:
    c,_=s.accept(); c.close()
except Exception: pass`,
    ]);
    let port = '';
    const started = Date.now();
    const chunks: Buffer[] = [];
    srv.stdout.on('data', (d) => chunks.push(d));
    while (!port && Date.now() - started < 10_000) {
      spawnSync('/bin/sleep', ['0.1']);
      const seen = Buffer.concat(chunks).toString().trim();
      if (seen) port = seen.split('\n')[0];
    }
    expect(port).not.toBe('');

    const r = spawnSync(
      'sandbox-exec',
      [
        '-f',
        file,
        '/usr/bin/python3',
        '-c',
        `import socket
s=socket.socket(); s.settimeout(5)
try:
    s.connect(("127.0.0.1", ${port})); print("CONNECTED")
except Exception as e:
    print("DENIED", e)`,
      ],
      { encoding: 'utf8' },
    );
    srv.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
    expect(r.stdout.trim()).toContain('CONNECTED');
  });

  test.skipIf(skipSandbox)('python3 boots under the profile (entropy device is reachable)', () => {
    // Regression: without the /dev/random+urandom grant, CPython dies at preinit
    // with "_Py_HashRandomization_Init: failed to get random numbers". A bare
    // `print` proves the entropy read at startup succeeds inside the sandbox.
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-py-')));
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));
    const r = spawnSync('sandbox-exec', ['-f', file, '/usr/bin/python3', '-c', 'print("ok")'], {
      encoding: 'utf8',
    });
    fs.rmSync(root, { recursive: true, force: true });
    expect(r.stderr).not.toContain('HashRandomization');
    // Report what the sandbox actually said: a bare `status !== 0` tells you
    // nothing about *which* path was denied, and this test only ever fails on a
    // machine you don't have in front of you (a CI runner selecting a versioned
    // Xcode bundle was the first such case).
    expect(`status=${r.status}\nstderr=${r.stderr}`).toBe('status=0\nstderr=');
    expect(r.stdout.trim()).toBe('ok');
  });

  // Regression: `/private/etc` was granted but the `/etc` symlink was not, so a
  // lookup through `/etc/...` failed on the link. The visible symptom was the
  // system curl refusing every HTTPS request ("error setting certificate verify
  // locations: CAfile: /etc/ssl/cert.pem", http_code 000), which reads as a box
  // with no network at all. Asserted with `cat` rather than `curl` so the test
  // needs no connectivity.
  test.skipIf(skipSandbox)('the CA bundle is readable through the /etc symlink', () => {
    const root = realTmp('cb-etc-');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));
    const read = (p: string) =>
      spawnSync('sandbox-exec', ['-f', file, '/bin/cat', p], { encoding: 'utf8' });

    const viaLink = read('/etc/ssl/cert.pem');
    const viaReal = read('/private/etc/ssl/cert.pem');
    fs.rmSync(root, { recursive: true, force: true });

    expect(`status=${viaReal.status}\nstderr=${viaReal.stderr}`).toBe('status=0\nstderr=');
    // The link form is the one that regressed, and it must say the same thing.
    expect(`status=${viaLink.status}\nstderr=${viaLink.stderr}`).toBe('status=0\nstderr=');
    expect(viaLink.stdout).toBe(viaReal.stdout);
  });

  // Regression: `resolvedDeveloperDirs` read only the pre-macOS-26 link location,
  // and neither link was granted — so every Apple toolchain shim (git, python3,
  // clang) died before doing any work. `git --version` touches nothing else, and
  // the assertion is on the xcode-select message rather than on the exit status,
  // so a host with no developer tools installed fails for its own reason instead
  // of blaming the profile.
  test.skipIf(skipSandbox)('a toolchain shim can read the xcode-select link', () => {
    const root = realTmp('cb-git-');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));
    const r = spawnSync('sandbox-exec', ['-f', file, '/usr/bin/git', '--version'], {
      encoding: 'utf8',
    });
    fs.rmSync(root, { recursive: true, force: true });
    expect(r.stderr).not.toContain('unable to read data link');
    expect(r.stderr).not.toContain('Operation not permitted');
    expect(r.stdout).toContain('git version');
  });

  // The whole point of the `target` filter: a box may signal its own tree and
  // nothing else. Both halves are asserted against real processes, because the
  // filter is undocumented by Apple — `same-sandbox` is only known from
  // reverse-engineered notes and Apple's own shipped profiles, so "it means the
  // same sandbox instance" is a claim this test has to keep honest.
  test.skipIf(skipSandbox)('a box can signal its own process tree', () => {
    const root = realTmp('cb-sig-');
    const file = path.join(root, 'profile.sb');
    const pidFile = path.join(root, 'pid');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));

    // The sleep is started by an inner shell that then exits, so by the time it
    // is signalled it is NOT a child of the signalling process any more (it is
    // reparented to launchd). That makes this a test of `same-sandbox` rather
    // than of `children`: the target is only reachable because it inherited the
    // box's profile.
    const script = `/bin/sh -c 'sleep 30 & echo $! > ${pidFile}'; sleep 1; kill -TERM "$(cat ${pidFile})"`;
    const r = spawnSync('sandbox-exec', ['-f', file, '/bin/sh', '-c', script], {
      encoding: 'utf8',
    });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());

    expect(`status=${r.status}\nstderr=${r.stderr}`).toBe('status=0\nstderr=');
    // The kill really took effect, rather than just being permitted.
    let alive = true;
    for (let i = 0; i < 20 && alive; i += 1) {
      try {
        process.kill(pid, 0);
        spawnSync('/bin/sleep', ['0.1']);
      } catch {
        alive = false;
      }
    }
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone — the expected case */
    }
    fs.rmSync(root, { recursive: true, force: true });
    expect(alive).toBe(false);
  });

  test.skipIf(skipSandbox)('a box can NOT signal a process outside the sandbox', () => {
    const root = realTmp('cb-sig-out-');
    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir: root }));

    // Same uid, same user, started outside any sandbox: nothing but the profile
    // stands between the box and this process.
    const outside = spawn('/bin/sleep', ['30'], { detached: true, stdio: 'ignore' });
    outside.unref();
    const pid = outside.pid as number;
    try {
      const r = spawnSync('sandbox-exec', ['-f', file, '/bin/kill', '-TERM', String(pid)], {
        encoding: 'utf8',
      });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Operation not permitted');
      // Still running: the denial was real, not just a noisy success.
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* nothing to clean up */
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The P0 invariant for the write-deny tier: the box reads these files (it has
  // to — they're part of the checkout) but cannot change them, because somebody
  // outside the sandbox executes them later. `.git/config` is the sharpest of
  // them: `[core] pager = sh -c …` fires on the user's next `git log`, in their
  // own shell, with no profile.
  test.skipIf(skipSandbox)('a box cannot write the files that run outside it', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-wd-')));
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(path.join(projectDir, '.git', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, '.git', 'config'), '[core]\n');
    fs.writeFileSync(path.join(projectDir, 'clabox.config.mjs'), 'export default {}');
    fs.writeFileSync(path.join(projectDir, 'src.ts'), 'ok');

    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(
      file,
      buildProfile(mergeConfig(defaultConfig, { network: false }), {
        projectDir,
      }),
    );
    const sh = (script: string) =>
      spawnSync('sandbox-exec', ['-f', file, '/bin/sh', '-c', script], { encoding: 'utf8' });

    // Ordinary project files stay writable — this is the agent's workspace.
    expect(sh(`echo x > ${projectDir}/src.ts`).status).toBe(0);
    expect(sh(`echo x > ${projectDir}/new.ts`).status).toBe(0);

    // …and the four that are executed elsewhere are not.
    for (const p of [
      `${projectDir}/clabox.config.mjs`,
      `${projectDir}/.git/config`,
      `${projectDir}/.git/hooks/pre-commit`,
      `${projectDir}/.envrc`,
    ]) {
      expect(sh(`echo pwned >> ${p}`).status).not.toBe(0);
    }
    // Reading them is untouched: this tier is write-only.
    expect(sh(`cat ${projectDir}/.git/config`).status).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });

  // SEC-1: the always-available escape. `open` hands a path to LaunchServices,
  // which runs outside every box and starts the target under launchd with no
  // profile — and the box can write the bundle it opens. With `lsopen` denied
  // the request dies in the sandbox instead.
  test.skipIf(skipSandbox)('a box cannot start a process via LaunchServices', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-open-')));
    const projectDir = path.join(root, 'project');
    fs.mkdirSync(projectDir);
    // A minimal .app whose executable would leave a marker OUTSIDE the box.
    const appDir = path.join(root, 'Esc.app', 'Contents', 'MacOS');
    const marker = path.join(root, 'escaped');
    fs.mkdirSync(appDir, { recursive: true });
    fs.writeFileSync(
      path.join(root, 'Esc.app', 'Contents', 'Info.plist'),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>run</string>
<key>CFBundleIdentifier</key><string>com.clabox.test.esc</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>`,
    );
    fs.writeFileSync(path.join(appDir, 'run'), `#!/bin/sh\necho escaped > ${marker}\n`, {
      mode: 0o755,
    });

    const file = path.join(root, 'profile.sb');
    fs.writeFileSync(file, buildProfile(defaultConfig, { projectDir }));
    const r = spawnSync(
      'sandbox-exec',
      ['-f', file, '/usr/bin/open', '-W', path.join(root, 'Esc.app')],
      { encoding: 'utf8', timeout: 30_000 },
    );

    expect(r.status).not.toBe(0);
    expect(fs.existsSync(marker)).toBe(false);

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
