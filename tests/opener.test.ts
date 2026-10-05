// Tests for the opener broker — the narrow, brokered alternative to the `open`
// escape (`config.allowOpen`).
//
// The whole security claim is: the agent supplies a *path* and nothing else.
// It cannot pick the application, cannot name an operation outside
// {reveal, edit}, cannot pass a flag, cannot leave the configured roots, and
// cannot reach a bundle. These tests are that claim, one `expect` at a time.
//
//   bun test

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ALIASES_FILENAME, buildClaudeAliases } from '../src/opener/aliases.js';
import { inObsidianVault, installedApps } from '../src/opener/apps.js';
import {
  buildOpenArgs,
  DEFAULT_EDIT_EXTENSIONS,
  MAX_REQUEST_BYTES,
  OPEN_ACTIONS,
  parseOpenRequest,
  RateLimiter,
  validateTarget,
} from '../src/opener/protocol.js';
import {
  CODE_EDITORS,
  describeApp,
  MARKDOWN_APPS,
  MARKDOWN_EXTENSIONS,
  routeTarget,
} from '../src/opener/routing.js';
import {
  handleRequest,
  openerLogPath,
  openerPid,
  resolveRequested,
  stopOpener,
} from '../src/opener/server.js';
import {
  defaultConfig,
  openerAliasesPath,
  openerDir,
  openerPidPath,
  openerSocketPath,
  resolvedOpener,
} from '../src/utils/config.js';

function tmpTree(): { root: string; dir: string; file: string; app: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-open-')));
  const dir = path.join(root, 'vault');
  const file = path.join(dir, 'note.md');
  const app = path.join(dir, 'Evil.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(file, '# note');
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'run'), '#!/bin/sh\n', { mode: 0o755 });
  return { root, dir, file, app };
}

describe('parseOpenRequest', () => {
  test('accepts exactly the two actions, with an absolute path', () => {
    expect(parseOpenRequest('reveal /tmp/x')).toEqual({ action: 'reveal', target: '/tmp/x' });
    expect(parseOpenRequest('edit /tmp/x.md')).toEqual({ action: 'edit', target: '/tmp/x.md' });
    expect(OPEN_ACTIONS).toEqual(['reveal', 'edit']);
  });

  test('refuses an unknown action — the vocabulary is closed', () => {
    for (const line of ['run /tmp/x', 'exec /tmp/x', 'open /tmp/x', 'REVEAL /tmp/x']) {
      expect(parseOpenRequest(line)).toBeNull();
    }
  });

  test('refuses anything that is not a bare absolute path', () => {
    // No flags, ever: one `-a`/`-b`/`--args` in a request and the agent is
    // choosing what runs again, which is the hole the broker exists to avoid.
    expect(parseOpenRequest('reveal -a Calculator')).toBeNull();
    expect(parseOpenRequest('reveal --args x')).toBeNull();
    expect(parseOpenRequest('reveal relative/path')).toBeNull();
    expect(parseOpenRequest('reveal')).toBeNull();
    expect(parseOpenRequest('')).toBeNull();
  });

  test('refuses control characters and oversized lines', () => {
    expect(parseOpenRequest('reveal /tmp/a\u0000b')).toBeNull();
    expect(parseOpenRequest('reveal /tmp/a\u001bb')).toBeNull();
    expect(parseOpenRequest(`reveal /tmp/${'a'.repeat(MAX_REQUEST_BYTES)}`)).toBeNull();
  });

  test('a path with spaces survives (it is the rest of the line)', () => {
    expect(parseOpenRequest('edit /Users/me/My Notes/a b.md')?.target).toBe(
      '/Users/me/My Notes/a b.md',
    );
  });
});

describe('validateTarget', () => {
  const policy = (roots: string[]) => ({ roots });

  test('a path outside the roots is refused', () => {
    const r = { action: 'reveal' as const, target: '/etc/passwd' };
    expect(validateTarget(r, '/etc/passwd', policy(['/Users/me/proj']))).toBe(
      'path escapes the allowed roots',
    );
  });

  test('no roots means nothing is allowed', () => {
    const r = { action: 'reveal' as const, target: '/Users/me/proj/x' };
    expect(validateTarget(r, '/Users/me/proj/x', policy([]))).toBe(
      'path escapes the allowed roots',
    );
  });

  test('a sibling that merely shares a prefix is not inside', () => {
    const r = { action: 'reveal' as const, target: '/Users/me/projEVIL/x' };
    expect(validateTarget(r, '/Users/me/projEVIL/x', policy(['/Users/me/proj']))).toBe(
      'path escapes the allowed roots',
    );
  });

  test('bundles are refused for both actions, even inside the roots', () => {
    const roots = ['/Users/me/proj'];
    for (const target of [
      '/Users/me/proj/Evil.app',
      '/Users/me/proj/Evil.app/Contents/MacOS/run',
      '/Users/me/proj/x.bundle/y',
      '/Users/me/proj/Some.framework/z',
    ]) {
      expect(validateTarget({ action: 'reveal', target }, target, policy(roots))).toBe(
        'inside an app bundle',
      );
      expect(validateTarget({ action: 'edit', target }, target, policy(roots))).toBe(
        'inside an app bundle',
      );
    }
  });

  test('edit is limited to the extension allowlist; reveal is not', () => {
    const roots = ['/Users/me/proj'];
    const bad = '/Users/me/proj/payload.command';
    expect(validateTarget({ action: 'edit', target: bad }, bad, policy(roots))).toBe(
      'file type not allowed',
    );
    // …but revealing it is fine: `open -R` cannot launch anything.
    expect(validateTarget({ action: 'reveal', target: bad }, bad, policy(roots))).toBeNull();

    const ok = '/Users/me/proj/note.md';
    expect(validateTarget({ action: 'edit', target: ok }, ok, policy(roots))).toBeNull();
  });

  test('every bundle type macOS can RUN is refused, not just .app', () => {
    // `reveal` of a directory is now `open -a Finder <dir>`, so the bundle deny
    // is half the guarantee: a `.workflow` runs in Automator, a `.scptd` in
    // Script Editor, `.prefPane`/`.saver`/`.plugin`/`.component` are loadable
    // code. The agent can write any of them into the project dir.
    const roots = ['/Users/me/proj'];
    for (const ext of [
      'app',
      'bundle',
      'framework',
      'xpc',
      'appex',
      'workflow',
      'scptd',
      'prefPane',
      'saver',
      'plugin',
      'component',
      'qlgenerator',
      'kext',
      'service',
      'wdgt',
      'mdimporter',
    ]) {
      const p = `/Users/me/proj/evil.${ext}`;
      expect(validateTarget({ action: 'reveal', target: p }, p, { roots })).toBe(
        'inside an app bundle',
      );
    }
    // …and a plain folder with a dot in its name is still fine.
    const ok = '/Users/me/proj/my.notes';
    expect(validateTarget({ action: 'reveal', target: ok }, ok, { roots })).toBeNull();
  });

  test('the allowlist never contains an executable type', () => {
    for (const ext of ['.app', '.command', '.scpt', '.pkg', '.dmg', '.terminal', '.workflow']) {
      expect(DEFAULT_EDIT_EXTENSIONS).not.toContain(ext);
    }
  });

  test('a dotfile name can be allowlisted as a whole', () => {
    const p = '/Users/me/proj/.env';
    expect(validateTarget({ action: 'edit', target: p }, p, policy(['/Users/me/proj']))).toBeNull();
  });
});

describe('buildOpenArgs', () => {
  test('reveal is always `open -R` — it cannot launch anything', () => {
    expect(buildOpenArgs({ action: 'reveal', target: '/x/y' }, 'Obsidian')).toEqual(['-R', '/x/y']);
  });

  test('edit uses the CONFIGURED app, never anything from the request', () => {
    expect(buildOpenArgs({ action: 'edit', target: '/x/y.md' }, 'Obsidian')).toEqual([
      '-a',
      'Obsidian',
      '/x/y.md',
    ]);
  });

  test('no editor → the system text editor, never the type handler', () => {
    // Both fallbacks were tried on a real machine. The type's registered handler
    // (plain `open <file>`) is the trap: on macOS `.md` commonly belongs to
    // **Xcode**, so "open the README" became "System-wide components must be
    // installed to use Xcode". `-t` is at least always a text editor.
    expect(buildOpenArgs({ action: 'edit', target: '/x/y.md' }, null)).toEqual(['-t', '/x/y.md']);
  });
});

describe('RateLimiter', () => {
  test('allows up to max per window, then refuses', () => {
    const l = new RateLimiter(3, 1000);
    expect([l.allow(0), l.allow(1), l.allow(2), l.allow(3)]).toEqual([true, true, true, false]);
  });

  test('the window slides', () => {
    const l = new RateLimiter(2, 1000);
    expect([l.allow(0), l.allow(10), l.allow(20)]).toEqual([true, true, false]);
    expect(l.allow(1500)).toBe(true); // first two aged out
  });
});

describe('handleRequest (the broker end to end, `open` stubbed)', () => {
  function harness(roots: string[], editor: string | null = 'TestEditor') {
    const calls: string[][] = [];
    return {
      calls,
      opts: {
        roots,
        editor,
        limiter: new RateLimiter(100, 1000),
        run: (args: string[]) => calls.push(args),
        now: () => 0,
      },
    };
  }

  test('reveals a directory as its OWN Finder window, not selected in the parent', () => {
    // `open -R <dir>` selects the folder in its parent, which reads as "it
    // opened the wrong directory". `-a Finder` gives the folder its own window
    // and still cannot launch anything: the application is pinned, exactly like
    // `-a <editor>` for `edit`.
    const t = tmpTree();
    try {
      const h = harness([t.root]);
      expect(handleRequest(`reveal ${t.dir}`, h.opts)).toMatchObject({ ok: true });
      expect(h.calls).toEqual([['-a', 'Finder', t.dir]]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('revealing a FILE still selects it in its folder (-R)', () => {
    const t = tmpTree();
    try {
      const h = harness([t.root]);
      expect(handleRequest(`reveal ${t.file}`, h.opts)).toMatchObject({ ok: true });
      expect(h.calls).toEqual([['-R', t.file]]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('opens an allowed file with the configured editor', () => {
    const t = tmpTree();
    try {
      const h = harness([t.root], 'Obsidian');
      expect(handleRequest(`edit ${t.file}`, h.opts)).toMatchObject({ ok: true });
      expect(h.calls).toEqual([['-a', 'Obsidian', t.file]]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('refuses the agent-planted .app — the SEC-1 payload', () => {
    const t = tmpTree();
    try {
      const h = harness([t.root]);
      const res = handleRequest(`reveal ${t.app}`, h.opts);
      expect(res).toMatchObject({ ok: false, reason: 'inside an app bundle' });
      expect(h.calls).toEqual([]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('a symlink out of the roots is resolved and refused', () => {
    // The reason the broker realpaths before judging: a link inside the root is
    // how an in-root path points at /Applications.
    const t = tmpTree();
    try {
      const link = path.join(t.dir, 'escape');
      fs.symlinkSync('/Applications', link);
      const h = harness([t.root]);
      expect(handleRequest(`reveal ${link}`, h.opts)).toMatchObject({
        ok: false,
        reason: 'path escapes the allowed roots',
      });
      expect(h.calls).toEqual([]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('`..` cannot climb out of the roots', () => {
    const t = tmpTree();
    try {
      const h = harness([t.dir]);
      expect(handleRequest(`reveal ${t.dir}/../`, h.opts)).toMatchObject({ ok: false });
      expect(h.calls).toEqual([]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('a missing path is refused like an out-of-root one (no existence oracle)', () => {
    const t = tmpTree();
    try {
      const h = harness([t.root]);
      const missing = handleRequest(`reveal ${t.dir}/nope`, h.opts);
      const outside = handleRequest('reveal /etc/master.passwd', h.opts);
      expect(missing.reason).toBe('path escapes the allowed roots');
      expect(outside.reason).toBe(missing.reason);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('edit with no configured editor uses the system text editor', () => {
    const t = tmpTree();
    try {
      const h = harness([t.root], null);
      expect(handleRequest(`edit ${t.file}`, h.opts)).toMatchObject({ ok: true });
      expect(h.calls).toEqual([['-t', t.file]]);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('the outcome says which app handled it', () => {
    // "it opened in some random editor" has to be answerable without guessing.
    const t = tmpTree();
    try {
      expect(handleRequest(`edit ${t.file}`, harness([t.root], 'Zed').opts).with).toBe('Zed');
      expect(handleRequest(`reveal ${t.dir}`, harness([t.root]).opts).with).toBe('Finder');
      expect(handleRequest(`edit ${t.file}`, harness([t.root], null).opts).with).toBe(
        'the system text editor (no editor app found)',
      );
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });

  test('the rate limiter stops a window flood', () => {
    const t = tmpTree();
    try {
      const calls: string[][] = [];
      const opts = {
        roots: [t.root],
        editor: null,
        limiter: new RateLimiter(2, 60_000),
        run: (a: string[]) => calls.push(a),
        now: () => 0,
      };
      handleRequest(`reveal ${t.dir}`, opts);
      handleRequest(`reveal ${t.dir}`, opts);
      expect(handleRequest(`reveal ${t.dir}`, opts)).toMatchObject({ reason: 'rate limited' });
      expect(calls.length).toBe(2);
    } finally {
      fs.rmSync(t.root, { recursive: true, force: true });
    }
  });
});

describe('config wiring', () => {
  test('every box gets the opener by default — $HOME as the root, no editor', () => {
    // The point of the broker is that it works from any box without per-box
    // setup; the socket only exists while the user runs a broker anyway.
    expect(resolvedOpener(defaultConfig)).toEqual({
      roots: [os.homedir()],
      editor: null,
      extensions: undefined,
      maxPerMinute: undefined,
    });
  });

  test('a box can opt out, and then the profile grants it no socket', () => {
    expect(resolvedOpener({ ...defaultConfig, opener: { enabled: false } })).toBeNull();
  });

  test('roots from the config are expanded and absolutised', () => {
    const cfg = { ...defaultConfig, opener: { enabled: true, roots: ['~/vault'] } };
    expect(resolvedOpener(cfg)?.roots).toEqual([path.join(os.homedir(), 'vault')]);
  });

  test('socket, pid and log all live in <claboxHome>/opener', () => {
    // $TMPDIR is read-write for *every* box, so a socket there could be driven
    // by any box; the clabox home is read-only in-box and needs a grant. All
    // three of the broker's files share one dir, so `ls` answers "what does the
    // broker have on disk" — and the log is derived from that dir rather than
    // walked up from the socket path, which used to be two `dirname`s.
    const s = openerSocketPath();
    expect(s.startsWith(os.tmpdir())).toBe(false);
    expect(path.dirname(s)).toBe(openerDir());
    expect(path.dirname(openerPidPath())).toBe(openerDir());
    expect(openerLogPath()).toBe(path.join(openerDir(), 'opener.log'));
    expect(path.basename(openerDir())).toBe('opener');
  });

  test('the generated shell helpers live in that dir too', () => {
    expect(openerAliasesPath()).toBe(path.join(openerDir(), 'claude-aliases.sh'));
    expect(ALIASES_FILENAME).toBe('claude-aliases.sh');
  });

  test('resolveRequested returns null for a missing path', () => {
    expect(resolveRequested('/definitely/not/here')).toBeNull();
  });
});

describe('the broker is a singleton', () => {
  // Why this exists: the first version unlinked the socket and bound its own, so
  // three `clabox opener --detach` in a row left two brokers alive with nothing
  // to serve — unreachable, and killable only by hand.
  function withHome(fn: (home: string) => void): void {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pid-')));
    const prev = process.env.CLABOX_CONFIGS_DIR;
    process.env.CLABOX_CONFIGS_DIR = path.join(home, 'configs');
    fs.mkdirSync(path.join(home, 'opener'), { recursive: true });
    try {
      fn(home);
    } finally {
      if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
      else process.env.CLABOX_CONFIGS_DIR = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  test('the pid file sits next to the socket', () => {
    withHome(() => {
      expect(openerPidPath()).toBe(openerSocketPath().replace(/\.sock$/, '.pid'));
    });
  });

  test('no pid file → no broker', () => {
    withHome(() => {
      expect(openerPid()).toBeNull();
    });
  });

  test('a pid file naming a dead process reads as "not running"', () => {
    withHome(() => {
      // A stale pid must not block the next start, which is what a plain
      // "the file exists" check would do.
      fs.writeFileSync(openerPidPath(), '2147483646\n');
      expect(openerPid()).toBeNull();
    });
  });

  test('a live pid is reported', () => {
    withHome(() => {
      // This very process stands in for a running broker.
      fs.writeFileSync(openerPidPath(), `${process.pid}\n`);
      expect(openerPid()).toBe(process.pid);
    });
  });

  test('garbage in the pid file is ignored, not thrown on', () => {
    withHome(() => {
      fs.writeFileSync(openerPidPath(), 'not-a-pid\n');
      expect(openerPid()).toBeNull();
    });
  });

  test('stopOpener cleans up the socket and pid file even with nothing running', () => {
    withHome(() => {
      fs.writeFileSync(openerPidPath(), '2147483646\n');
      fs.writeFileSync(openerSocketPath(), ''); // stand-in for a stale socket
      expect(stopOpener()).toBeNull(); // the pid was dead → nothing signalled
      expect(fs.existsSync(openerPidPath())).toBe(false);
      expect(fs.existsSync(openerSocketPath())).toBe(false);
    });
  });
});

describe('app routing (what opens what)', () => {
  // The agent sends a path; which app runs is decided here, from the file type
  // and what's installed. Two earlier fallbacks had to be thrown out after
  // meeting a real machine: the type's registered handler opened a README in
  // **Xcode** (which demanded to install components), and `-t` landed in
  // **TextEdit**. Neither is where anyone reads code.
  const installed = ['Zed', 'Obsidian', 'Preview', 'Numbers'];

  test('code goes to the best installed editor, in list order', () => {
    expect(routeTarget('/p/src/index.ts', { installed })).toBe('Zed');
    expect(routeTarget('/p/README.md', { installed })).toBe('Zed');
    expect(routeTarget('/p/x.json', { installed: ['Cursor', 'Zed'] })).toBe('Zed');
    expect(routeTarget('/p/x.json', { installed: ['Cursor'] })).toBe('Cursor');
  });

  test('a markdown note inside an Obsidian vault goes to Obsidian', () => {
    expect(routeTarget('/vault/note.md', { installed, inVault: true })).toBe('Obsidian');
    // …but code in that same vault is still code.
    expect(routeTarget('/vault/script.ts', { installed, inVault: true })).toBe('Zed');
  });

  test('markdown outside a vault goes to the markdown reader, not the editor', () => {
    // `open`ing a doc is a request to read it — the agent edits markdown with
    // the file tools, so a rendered reader beats a code editor here.
    const withReader = [...installed, 'Typora'];
    expect(routeTarget('/p/note.md', { installed: withReader, inVault: false })).toBe('Typora');
    expect(routeTarget('/p/README.markdown', { installed: withReader })).toBe('Typora');
    // A vault note still belongs to Obsidian, reader installed or not.
    expect(routeTarget('/vault/note.md', { installed: withReader, inVault: true })).toBe(
      'Obsidian',
    );
    // No reader on the machine → unchanged, the code editor takes it.
    expect(routeTarget('/p/note.md', { installed, inVault: false })).toBe('Zed');
    // …and so does non-markdown, reader or no reader.
    expect(routeTarget('/p/x.ts', { installed: withReader })).toBe('Zed');
  });

  test('the markdown reader list holds no code editor and vice versa', () => {
    expect(MARKDOWN_APPS[0]).toBe('Typora');
    for (const app of MARKDOWN_APPS) expect(CODE_EDITORS).not.toContain(app);
    expect(MARKDOWN_EXTENSIONS).toContain('.md');
  });

  test('images and PDFs go to Preview', () => {
    expect(routeTarget('/p/shot.png', { installed })).toBe('Preview');
    expect(routeTarget('/p/doc.pdf', { installed })).toBe('Preview');
  });

  test('nothing installed → null, i.e. the system text editor', () => {
    expect(routeTarget('/p/x.ts', { installed: [] })).toBeNull();
    expect(describeApp(null)).toContain('system text editor');
  });

  test('an explicit editor always wins — that is what --editor is for', () => {
    expect(routeTarget('/p/shot.png', { installed, editor: 'Acorn' })).toBe('Acorn');
    expect(routeTarget('/vault/n.md', { installed, inVault: true, editor: 'Zed' })).toBe('Zed');
  });

  test('the editor list is ordered best-first and holds no non-editor', () => {
    expect(CODE_EDITORS[0]).toBe('Zed');
    expect(CODE_EDITORS).not.toContain('Xcode'); // the trap that started this
    expect(CODE_EDITORS).not.toContain('TextEdit');
  });
});

describe('the generated shell helpers (claude-aliases.sh)', () => {
  // Why clabox generates this instead of documenting it: the correct helper is
  // not one line. `clabox open` refuses a directory (no extension in the
  // allowlist), the native `open` is denied in-box and is still the right answer
  // outside one — so everyone who writes it by hand hits
  // `denied: file type not allowed` on `o .` first.
  const SOCK = '/Users/me/.config/clabox/opener/opener-501.sock';
  const text = buildClaudeAliases(SOCK);
  // Comments mention both `clabox opener` and `realpath` while explaining why
  // neither is invoked, so the "never calls X" assertions must look at code.
  const code = text
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');

  test('it routes a directory to reveal and a file to edit', () => {
    expect(text).toMatch(/if \[ -d "\$t" \]; then _cb_ask reveal/);
    expect(text).toContain('_cb_ask edit "$t"');
  });

  test("it talks to the socket directly — never exec's clabox", () => {
    // Exec'ing clabox in a box needs a grant on wherever its binary physically
    // resolves (a dev install lands in clabox's own repo, which no other box
    // grants) — so a helper built on `clabox reveal` dies with
    // `operation not permitted: clabox` before the socket is ever touched.
    // `nc` lives in /usr/bin, which every box can already read and exec.
    // `clabox` still occurs in code twice — in the socket path and in the "no
    // broker" message naming the command to run OUTSIDE the box. What must not
    // exist is a call to it.
    expect(code).not.toMatch(/clabox (reveal|open|info)\b/);
    expect(text).toContain(`_cb_s='${SOCK}'`);
    expect(text).toContain('| nc -U "$_cb_s"');
    expect(text).toContain('printf "%s %s\\n" "$1" "$(_cb_abs "$2")"');
  });

  test('the path is made absolute in shell — the protocol takes nothing else', () => {
    expect(text).toContain('_cb_abs() {');
    expect(text).toContain('(cd "$1" && pwd)');
    expect(code).not.toContain('realpath'); // not on every system, and the broker realpaths anyway
  });

  test('no broker → a message naming the fix, not a hang', () => {
    expect(text).toContain('if [ ! -S "$_cb_s" ]; then');
    expect(text).toContain('clabox opener --detach');
  });

  test('outside a box it falls back to the native open, unchanged', () => {
    expect(text).toContain('_cb_inbox() { [ ! -r /Applications ]; }');
    expect(text).toMatch(/if ! _cb_inbox; then\n\s+open "\$t"/);
  });

  test('a URL never goes to the broker — it only accepts absolute paths', () => {
    expect(text).toContain('*://*) open "$t" ;;');
  });

  test('functions, not aliases — a non-interactive shell expands no alias', () => {
    const fns = ['o', 'щ', 'o.', 'щ.', 'щю', 'c', 'с', 'c.', 'сю', 'ob', 'щи', 'ob.', 'щию'];
    for (const fn of fns) expect(text).toContain(`${fn}(`);
    expect(text).not.toMatch(/^alias /m);
  });

  test('it holds only opener business, and says it is generated', () => {
    // Rewritten on every broker start, so anything personal here would be lost;
    // a user's own rc sources it instead.
    expect(text).toContain('GENERATED by `clabox opener`');
    expect(text).toContain('do not edit, source it instead');
    expect(text).not.toContain('proxy-curl');
    expect(text).not.toContain('PROXY_URI');
  });

  test('POSIX only, so it sources in bash and zsh alike', () => {
    expect(text).not.toContain('[[');
    expect(text).not.toContain('function ');
  });
});

describe('app discovery (I/O)', () => {
  test('installedApps lists .app names from the dirs it is given', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-apps-')));
    try {
      fs.mkdirSync(path.join(root, 'Zed.app'));
      fs.mkdirSync(path.join(root, 'Not An App'));
      expect(installedApps([root, '/no/such/dir'])).toEqual(['Zed']);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('inObsidianVault finds a .obsidian dir above the file, and stops at the root', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cb-vault-')));
    try {
      const deep = path.join(root, 'vault', 'daily');
      fs.mkdirSync(deep, { recursive: true });
      fs.mkdirSync(path.join(root, 'vault', '.obsidian'));
      fs.writeFileSync(path.join(deep, 'today.md'), '#');
      expect(inObsidianVault(path.join(deep, 'today.md'), root)).toBe(true);

      const plain = path.join(root, 'plain');
      fs.mkdirSync(plain);
      fs.writeFileSync(path.join(plain, 'x.md'), '#');
      expect(inObsidianVault(path.join(plain, 'x.md'), root)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
