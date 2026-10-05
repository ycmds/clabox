// Seatbelt (SBPL) profile generator.
//
// The old bash version baked the profile into a heredoc and patched it with
// sed. Here the profile is assembled from small typed helpers, so the parts
// you actually want to tweak live in config.ts as plain data.

import fs from 'node:fs';
import path from 'node:path';
import {
  BASE_PATH_GROUPS,
  type Config,
  claboxHomeDir,
  expandHome,
  type GrantTable,
  HOME,
  openerSocketPath,
  resolvedOpener,
  resolvedPathRules,
  untouchedBaseKeys,
} from '../utils/config.js';

// ---- SBPL helpers ----------------------------------------------------------

// Quote a literal string for SBPL. Only `"` needs escaping; backslashes are
// left as-is so regex patterns survive verbatim.
const q = (s: string): string => `"${String(s).replace(/"/g, '\\"')}"`;

/**
 * Quote a **regex** for SBPL. Same as {@link q} plus the part that bit us: an
 * SBPL string processes its own escapes before the regex engine ever sees the
 * text, so a lone `\` is eaten. `\.env` therefore reached the matcher as `.env`
 * — a dot that matches *any* character — and a `denyGlobs: ['**​/.env*']` silently
 * denied `_envs.mjs`, `aenv` and every other `?env*` name, which surfaces as an
 * `EPERM` on a file nobody meant to hide.
 *
 * Apple's own profiles show both ways out: the literal-string form
 * `(regex #"^/Library/Keychains/\.fl[0-9A-F]+$")`, and doubling inside a plain
 * string (`(mount-relative-regex "^/\\.Trashes(/|$)")`). We double, because the
 * literal form has no way to escape a `"` and the patterns come from user config.
 */
const reQ = (s: string): string => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export const subpath = (p: string): string => `(subpath ${q(p)})`;
export const literal = (p: string): string => `(literal ${q(p)})`;
export const regex = (p: string): string => `(regex ${reQ(p)})`;
export const globalName = (n: string): string => `(global-name ${q(n)})`;
export const ipcName = (n: string): string => `(ipc-posix-name ${q(n)})`;
/**
 * `(target <who>)` — the filter that scopes `signal` / `process-info*` to a set
 * of processes relative to the sandboxed one. Values seen in Apple's own
 * profiles under /System/Library/Sandbox/Profiles: `self`, `children`,
 * `same-sandbox`, `pgrp`, `others`. It is a bare symbol, not a string, so it is
 * NOT quoted.
 */
export const target = (who: string): string => `(target ${who})`;

/** Escape a path for safe embedding inside an SBPL regex. */
export const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Every directory *above* `p`, from its parent up to `/` — the chain a path
 * lookup walks through.
 *
 * Needed because the profile no longer grants `file-read-metadata` globally:
 * resolving `/a/b/c` touches `/a` and `/a/b` on the way, and a tool that
 * `realpath`s or `stat`s its way down (git, node's module resolution, `cd`) gets
 * an `EPERM` instead of a plain answer when an intermediate directory is denied.
 * Granting metadata on the *ancestors alone* costs nothing: each one is a
 * directory already named in the profile, and `literal` (not `subpath`) keeps the
 * grant to the directory itself — its children stay as denied as before.
 *
 * Pure. `/` yields `[]`.
 */
export function pathAncestors(p: string): string[] {
  const out: string[] = [];
  let cur = path.resolve(p);
  while (cur !== '/') {
    cur = path.dirname(cur);
    out.push(cur);
  }
  return out;
}

/**
 * Compile one gitignore-style glob into an SBPL regex *body* — the part that
 * matches a single path component (and, via the caller's trailing slash-or-end
 * group, whatever lives under it). Depth is the caller's job: a leading
 * double-star-slash or a leading slash is stripped here since every sandboxed
 * path is absolute (a basename always follows a slash), so the caller anchors
 * it under a root at any depth.
 *
 * `*` → a run of non-slash chars, `**` → any run (slashes included), `?` → one
 * non-slash char; every other regex metachar is backslash-escaped. Pure, so it
 * unit-tests without a profile. The `!`-negation (allow-vs-deny) is decided by
 * the caller, not here.
 */
export function globToRegexBody(glob: string): string {
  const g = glob.replace(/^\*\*\//, '').replace(/^\//, '');
  let body = '';
  for (let i = 0; i < g.length; ) {
    if (g[i] === '*' && g[i + 1] === '*') {
      body += '.*';
      i += 2;
      if (g[i] === '/') i += 1; // '**/' — the slash is folded into '.*'
    } else {
      const c = g[i++];
      if (c === '*') body += '[^/]*';
      else if (c === '?') body += '[^/]';
      else body += /[A-Za-z0-9_/]/.test(c) ? c : `\\${c}`;
    }
  }
  return body;
}

function block(op: string, rules: string[]): string {
  return [`(${op}`, ...rules.map((r) => `  ${r}`), ')'].join('\n');
}
const allow = (op: string, ...rules: string[]): string => block(`allow ${op}`, rules);
const deny = (op: string, ...rules: string[]): string => block(`deny ${op}`, rules);

// ---- the grant table: `path: rights` → SBPL ---------------------------------

/**
 * One right letter → the SBPL operation it stands for. The same letters a box
 * writes in its config (`PathGrant` in config.ts), plus the ones only the
 * built-in rules need:
 *
 *   r  file-read*            read contents, metadata, xattrs
 *   w  file-write*           (emitted with `r`: a writable path is readable)
 *   s  file-read-metadata    stat(2) only
 *   e  process-exec          exec a binary from here
 *   m  file-map-executable   mmap it executable — dyld needs this for libraries
 *   i  file-ioctl            ioctl(2) (ttys)
 *   c  network-outbound      connect(2) to a unix socket at this path
 *
 * Order here is the order they're printed in, so the generated profile reads the
 * same way every time.
 */
const RIGHT_OPS: Array<[string, string]> = [
  ['r', 'file-read*'],
  ['w', 'file-write*'],
  ['s', 'file-read-metadata'],
  ['m', 'file-map-executable'],
  ['e', 'process-exec'],
  ['i', 'file-ioctl'],
  ['c', 'network-outbound'],
];

/**
 * Compile a {@link GrantTable} into SBPL rules.
 *
 * Paths that carry the same set of rights are grouped into one rule, in first-
 * appearance order, so a table of a dozen entries still prints as two or three
 * blocks. Every `allow`ed path is handed to `onGrant` (the stat-ancestors pass
 * needs to know which paths exist in the profile); denied and regex entries are
 * not, since a denied path's ancestors are nobody's business and a regex has no
 * path to walk up from.
 */
export function grantBlock(table: GrantTable, onGrant?: (p: string) => void): string {
  // ops-signature → matchers, insertion-ordered by Map semantics
  const groups = new Map<string, string[]>();
  const push = (key: string, matcher: string) => {
    const list = groups.get(key);
    if (list) list.push(matcher);
    else groups.set(key, [matcher]);
  };

  for (const [rawPath, rights] of Object.entries(table)) {
    const isRegex = rawPath.startsWith('^');
    const letters = new Set(rights);
    // `w` implies `r`: every write grant in this profile has always been emitted
    // as `file-read* file-write*`, and a write-only path would be a trap (you can
    // create a file you then can't open).
    if (letters.has('w')) letters.add('r');
    const matcher = isRegex
      ? regex(rawPath)
      : letters.has('l')
        ? literal(rawPath)
        : subpath(rawPath);

    if (letters.has('d')) {
      // A deny has to cover every class, not just the file ones — a socket
      // connect is `network-outbound`, so a file-only deny leaves the socket
      // inside a denied directory reachable.
      push('deny:file-read* file-write*', matcher);
      push('deny:network-outbound', matcher);
      continue;
    }
    if (!isRegex) onGrant?.(rawPath);

    // A socket grant is emitted as BOTH matchers, because the path is sometimes a
    // single socket file (`.../mDNSResponder`, `docker.sock`) and sometimes the dir
    // holding them (claude's daemon dir, whose socket names carry a hash). Apple's
    // profiles use `literal` for the former and `subpath` for the latter; emitting
    // both means a config needn't know which kind it named. `l` pins it to literal.
    if (letters.has('c')) {
      push('allow:network-outbound', isRegex || letters.has('l') ? matcher : literal(rawPath));
      if (!isRegex && !letters.has('l')) push('allow:network-outbound', subpath(rawPath));
    }
    const ops = RIGHT_OPS.filter(([letter]) => letter !== 'c' && letters.has(letter)).map(
      ([, op]) => op,
    );
    if (!ops.length) continue;
    push(`allow:${ops.join(' ')}`, matcher);
  }

  return [...groups]
    .map(([key, matchers]) => {
      const [kind, ops] = [key.slice(0, key.indexOf(':')), key.slice(key.indexOf(':') + 1)];
      return kind === 'deny' ? deny(ops, ...matchers) : allow(ops, ...matchers);
    })
    .join('\n');
}

/** `{ '<path>': rights }` for every path in `list` — a table from a plain array. */
export function sameRights(list: string[], rights: string): GrantTable {
  return Object.fromEntries(list.map((p) => [p, rights]));
}

// ---- package-manager autodetection ----------------------------------------

/** Detect installed package managers whose paths must be readable/executable. */
export function detectPackagePaths(): string[] {
  const paths: string[] = [];
  if (fs.existsSync('/opt/homebrew')) paths.push('/opt/homebrew');
  else if (fs.existsSync('/usr/local/Homebrew')) paths.push('/usr/local/Homebrew');
  const local = path.join(HOME, '.local');
  if (fs.existsSync(local)) paths.push(local);
  if (fs.existsSync('/nix/store')) paths.push('/nix/store');
  return paths;
}

/**
 * The clabox home as it physically resolves on disk, but ONLY when
 * {@link claboxHomeDir} is a symlink (so the real path differs from the nominal
 * `~/.config/clabox` one). Used to grant the resolved location in the profile —
 * the macOS sandbox matches the symlink-resolved path, so a relocated clabox
 * home (e.g. symlinked into a project repo) would otherwise have its box configs
 * + compiled `--mcp-config` / `--settings` denied. Best-effort: returns `[]`
 * when the home is absent or already canonical.
 */
export function resolvedClaboxHome(): string[] {
  const home = claboxHomeDir();
  let realHome: string;
  try {
    realHome = fs.realpathSync(home);
  } catch {
    return [];
  }
  return realHome === home ? [] : [realHome];
}

/** The toolchain roots granted statically, before any symlink resolution. */
const STATIC_DEVELOPER_DIRS = ['/Library/Developer/CommandLineTools', '/Applications/Xcode.app'];

/**
 * The links `xcode-select` maintains to record the active developer dir, newest
 * location first. Apple moved it: `/var/db/xcode_select_link` through macOS 15,
 * `/var/select/developer_dir` on 26+ (the path named in the shims' own error,
 * `unable to read data link at '/var/select/developer_dir'`). Reading only the old
 * one silently finds nothing on a current mac, so both are tried — and both are
 * granted in `BASE_PATH_GROUPS`, since a shim has to read the link itself.
 */
const XCODE_SELECT_LINKS = ['/var/select/developer_dir', '/var/db/xcode_select_link'];

/**
 * The **resolved** developer directories to grant on top of
 * {@link STATIC_DEVELOPER_DIRS} — Seatbelt matches the symlink-resolved path, so
 * a nominal grant misses a toolchain that lives behind a link.
 *
 * `/usr/bin/python3` (like `clang`, `git`, `swift`…) is a shim that execs the
 * *selected* toolchain, i.e. whatever `xcode-select -p` points at. On a dev mac
 * that's the real `/Applications/Xcode.app`, which the static grant covers. On a
 * CI runner the bundle is versioned (`/Applications/Xcode_16.4.app`) with
 * `Xcode.app` a symlink onto it, so the static grant resolves to nothing and
 * CPython dies before it starts — the symptom that shows up as the entropy
 * regression test failing only in CI.
 *
 * Read through {@link XCODE_SELECT_LINKS} rather than by running `xcode-select`,
 * keeping this to `fs` autodetection. Best-effort: an unreadable or absent link
 * contributes nothing.
 */
export function resolvedDeveloperDirs(): string[] {
  const out = new Set<string>();
  for (const p of [...XCODE_SELECT_LINKS, ...STATIC_DEVELOPER_DIRS]) {
    let real: string;
    try {
      if (!fs.existsSync(p)) continue;
      real = fs.realpathSync(p);
    } catch {
      continue;
    }
    // Either link points at `<bundle>/Contents/Developer`; grant the whole
    // bundle, since the shims reach outside Contents/Developer too.
    const root = real.replace(/\/Contents\/Developer$/, '');
    if (!STATIC_DEVELOPER_DIRS.includes(root)) out.add(root);
  }
  return [...out];
}

/** Context needed to assemble a profile for a specific project. */
export interface ProfileContext {
  projectDir: string;
  detectedPaths?: string[];
}

/**
 * Build the full SBPL profile text.
 * @param config  effective config (see config.ts)
 * @param ctx     { projectDir, detectedPaths }
 */
export function buildProfile(
  config: Config,
  { projectDir, detectedPaths = detectPackagePaths() }: ProfileContext,
): string {
  const configDir = expandHome(config.configDir);
  const sshDir = expandHome(config.bot.sshDir);
  const homeRe = reEscape(HOME);
  // The box's OWN grants: everything in `config.paths` that isn't a base-policy
  // key (those are emitted by `baseGroup` above, in their own sections).
  const paths = resolvedPathRules(config.paths, untouchedBaseKeys(config.paths));

  const sections: string[] = [];
  const add = (comment: string, body: string) => sections.push(`;; ---------- ${comment}\n${body}`);

  // Path-matchers for the ALLOW rules go through these two wrappers instead of
  // the bare `subpath`/`literal`, so every granted path is also recorded for the
  // stat-ancestors section at the bottom (see pathAncestors). Deny rules keep
  // using the bare helpers — a denied path's ancestors are nobody's business.
  const granted = new Set<string>();
  // Extra dirs that need a bare metadata grant of their own: roots of `regex`
  // rules, which carry no plain path for the ancestors pass to walk up from.
  const statRoots: string[] = [];
  const sp = (p: string): string => {
    granted.add(p);
    return subpath(p);
  };
  const lit = (p: string): string => {
    granted.add(p);
    return literal(p);
  };

  sections.push(
    [
      ';; ------------------------------------------------------------------',
      ';;  Claude Code macOS sandbox profile (autogenerated)',
      ';; ------------------------------------------------------------------',
      '(version 1)',
      '(deny default)',
    ].join('\n'),
  );

  // `process-info*` lets tools like `ps`/`top`/`pgrep`/`lsof` enumerate other
  // processes (libproc: proc_listallpids/proc_pidinfo) — without it `(deny
  // default)` trims `ps` down to the sandboxed process itself. This leaks no
  // more than the already-unconditional `sysctl-read`, which hands out every
  // process's argv via KERN_PROCARGS2, so it lives here in introspection too.
  //
  // Note what is NOT here any more: a bare `(allow file-read-metadata)`. It used
  // to sit in this section (introspection needs to stat things), but with no
  // filter it granted `stat(2)` on the WHOLE disk — including every path the
  // deny tiers below work hard to hide, since a `stat` is not a `file-read-data`
  // and the two are separate operations in SBPL. The result was a box that could
  // not list `~/Library/Group Containers/…` yet could confirm, byte-size and
  // mtime included, exactly which files lived there. `stat` is now a path-scoped
  // right like read and write: implied by every read/write grant (`file-read*`
  // covers `file-read-metadata`), re-openable per path via `paths.stat`, and
  // granted on granted paths' ancestors at the very bottom of this profile.
  add('introspection & sysctl', '(allow sysctl-read)\n(allow process-info*)');

  // A box that can start `npm run dev` has to be able to stop it again —
  // without a `signal` rule `(deny default)` covers kill(2) too, so every
  // process the agent spawns is immortal until the box exits. The `target`
  // filter is what keeps this from being a global grant:
  //   * `children`     — what this process spawned directly;
  //   * `same-sandbox` — the whole inherited tree. The profile is inherited
  //     across fork/exec and cannot be dropped, so a grandchild (npm → node →
  //     frpc) is still in *this* box, while anything outside it is not.
  // Nothing outside the box becomes signalable; tests/profile.test.ts asserts
  // that against a real process rather than trusting the (undocumented) filter.
  //
  // `process-info-setcontrol (target self)` is setpriority(2) — zsh job control
  // nices its background jobs, and without it every `cmd &` fails the spawn
  // with `nice(5) failed: operation not permitted`. Chromium's renderer profile
  // carries the same rule.
  add(
    'process control (signals stay inside the box)',
    [
      allow('signal', target('self'), target('children'), target('same-sandbox')),
      allow('process-info-setcontrol', target('self')),
    ].join('\n'),
  );

  // The built-in base policy is DATA, not code: `BASE_PATH_GROUPS` in config.ts
  // lists every path with its rights (`r` read, `w` write, `s` stat, `m`
  // map-executable, `e` exec, `i` ioctl, `c` socket, `d` deny, `l` = this path
  // only) and a one-line note on why it's there. Those entries are also seeded
  // into `defaultConfig.paths`, so a box can narrow one (`'/System': 'r'`), take
  // it away (`'~/Library/Keychains': 'd'`) or widen it — the override wins here
  // while keeping this section's position, which is what makes it safe: SBPL is
  // last-match-wins, so *where* a rule lands decides whether a later deny buries
  // it.
  /** `~`-expand every key, so a table can be written portably. */
  const expandTable = (table: GrantTable): GrantTable =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [expandHome(k), v]));
  const grants = (table: GrantTable) => grantBlock(expandTable(table), (p) => granted.add(p));
  const baseGroup = (title: string) => {
    const group = BASE_PATH_GROUPS.find((g) => g.title === title);
    if (group) add(group.title, grants(group.paths));
  };

  baseGroup('basic dir traversal');
  baseGroup('system runtime + exec (read-only)');

  // Not expressible as static data — these are resolved at run time:
  //   detectPackagePaths() finds Homebrew / ~/.local / nix,
  //   resolvedDeveloperDirs() follows `xcode-select` through its symlink.
  const developerDirs = [...STATIC_DEVELOPER_DIRS, ...resolvedDeveloperDirs()];
  add(
    'package managers + Xcode / Command Line Tools (autodetected)',
    grants({ ...sameRights(detectedPaths, 'rme'), ...sameRights(developerDirs, 'rme') }),
  );

  baseGroup('temp dirs (RW)');
  // The $TMPDIR rule is a regex, which carries no plain path for the stat-ancestors
  // pass; without metadata on the container dir, `mkdtemp`/`realpath` inside TMPDIR
  // trip over it on the way down.
  const tmpRoot = '/private/var/folders';
  statRoots.push(tmpRoot, ...pathAncestors(tmpRoot));

  // Claude's own profile dir — a path, but one that comes from `config.configDir`.
  add('Claude config & token files', grants({ [configDir]: 'rw' }));

  // These five sections are base-policy data too (BASE_PATH_GROUPS) — the notes
  // on *why* each path is granted live next to the paths there.
  baseGroup('Claude runtime state & caches (RW)');
  baseGroup('package-manager caches (RW)');
  baseGroup('time-zone & prefs (RO)');
  baseGroup('/dev access (RO) + ioctl');

  add(
    'mach-lookup services',
    allow(
      'mach-lookup',
      globalName('com.apple.system.opendirectoryd.libinfo'),
      globalName('com.apple.SystemConfiguration.DNSConfiguration'),
      globalName('com.apple.system.notification_center'),
      globalName('com.apple.logd'),
      globalName('com.apple.diagnosticd'),
      // The read-only type/UTI database. Plenty of frameworks consult it; it
      // cannot start a process (that's `modifydb` + launchservicesd below).
      globalName('com.apple.lsd.mapdb'),
      globalName('com.apple.coreservices.quarantine-resolver'),
      globalName('com.apple.pasteboard.pboard'),
      globalName('com.apple.pasteboard.1'),
    ),
  );

  // Launch Services — `/usr/bin/open` and the services behind it. OFF by
  // default, because this is an escape, not a convenience: `open` doesn't fork
  // anything in-box, it asks LaunchServices (outside every sandbox) to start a
  // target, which comes up under launchd with NO profile. The box can write
  // `.app` bundles into /tmp, $TMPDIR and the project, so a granted `lsopen` is
  // arbitrary code execution as the user — the same reason `appleevent-send` is
  // withheld above. `(allow lsopen)` and the mach services are emitted together:
  // the gate is checked by the receiving service, so leaving the ports reachable
  // while denying the operation would be a half-measure.
  if (config.allowOpen) {
    add(
      'Launch Services / `open` (config.allowOpen — ESCAPE HATCH: starts processes outside the box)',
      [
        allow(
          'mach-lookup',
          globalName('com.apple.coreservices.launchservicesd'),
          globalName('com.apple.CoreServices.coreservicesd'),
          globalName('com.apple.lsd.modifydb'),
          regex('^com\\.apple\\.lsd(\\..*)?$'),
        ),
        '(allow lsopen)',
      ].join('\n'),
    );
  }

  add(
    'Developer Tools (xcrun / libxcrun)',
    allow('mach-lookup', globalName('com.apple.dt.xcsecurity'), regex('^com\\.apple\\.dt\\..*$')),
  );

  add(
    'Audio (afplay)',
    allow(
      'mach-lookup',
      globalName('com.apple.audio.audiohald'),
      globalName('com.apple.audio.AudioComponentRegistrar'),
    ),
  );

  // terminal-notifier / osascript banners post via the high-level-services XPC
  // (NSUserNotification). Without it they die with:
  //   "Connection Invalid error for service com.apple.hiservices-xpcservice".
  // afplay sound is already granted above, so this is what enables sound+banner
  // for Stop/Notification hooks inside the sandbox. Banner-click→focus is NOT
  // enabled: that needs appleevent-send to the terminal, which would let a
  // sandboxed claude script your terminal (a real escape hatch).
  add(
    'Notifications (terminal-notifier / osascript banners)',
    allow('mach-lookup', globalName('com.apple.hiservices-xpcservice')),
  );

  add(
    'Notification Center shared-memory (RO)',
    allow('ipc-posix-shm-read-data', ipcName('apple.shm.notification_center')),
  );

  baseGroup('user prefs & keychain');
  add(
    'Keychain mach services (for OAuth)',
    allow(
      'mach-lookup',
      globalName('com.apple.SecurityServer'),
      globalName('com.apple.security.agent'),
      globalName('com.apple.securityd'),
      globalName('com.apple.secd'),
      globalName('com.apple.trustd'),
      globalName('com.apple.trustd.agent'),
      globalName('com.apple.CoreAuthentication.daemon'),
    ),
  );
  baseGroup('git config (RO)');

  // Soft privacy DENY list — placed BEFORE the extra readOnly/readWrite and the
  // project dir, so an explicit grant may override it (e.g. running on a project
  // that lives under ~/Documents). The hard secret deny below is what's binding.
  const softDeny = [
    ...config.denyHome.map((d) => subpath(path.join(HOME, d))),
    ...paths.deny.map((p) => subpath(expandHome(p))),
  ];
  // `file-read*` covers metadata, so this takes stat away too. The second rule
  // extends a deny to unix sockets *under* those paths: that's a different
  // operation class, and without it `paths.deny` on a dir would still leave a
  // socket inside it connectable (how the 1Password agent stayed reachable). Both
  // stay overridable by a later explicit grant, soft-tier as before.
  add(
    'soft privacy DENY list (overridable by explicit grants)',
    [deny('file-read* file-write*', ...softDeny), deny('network-outbound', ...softDeny)].join('\n'),
  );

  baseGroup('SSH: known_hosts + config (personal keys hard-denied at the very end)');
  // The bot key dir is config-driven (`config.bot.sshDir`), so it can't live in
  // the static table.
  add('SSH: bot key dir', grants({ [sshDir]: 'r' }));

  // The box's own grants — one table, compiled by the same `grantBlock` as the
  // base policy (see ResolvedPathRules.table). Emitted AFTER the soft privacy
  // deny, so an explicit grant can override it (a project under ~/Documents, a
  // whole-disk `'/': 'w'` box), and BEFORE the hard secret deny, so nothing here
  // can uncover credentials. `paths.deny` went into the soft tier above.
  //
  // Hook scripts that claude must run inside the sandbox need `'re'`: compiled
  // hooks (config.hooks) only register the script with claude, the sandbox still
  // has to allow exec'ing its path.
  if (Object.keys(paths.table).length) add('box grants (config.paths)', grants(paths.table));

  add(
    'project workspace (RW)',
    [
      allow('file-read* file-write* file-map-executable', sp(projectDir)),
      allow('process-exec', sp(projectDir)),
    ].join('\n'),
  );

  // Glob read-DENY (gitignore-flavored): deny READ of files/dirs whose path —
  // at any depth *inside the project* — matches a pattern (`.env`, dunder cruft,
  // …). Emitted AFTER the project grant so it actually bites inside the project,
  // but BEFORE the hard secret deny so that stays supreme. Deliberately scoped
  // to the project: a global match would also shadow system runtimes granted
  // earlier (e.g. `**/__*` vs CPython's `.../__init__.py`) and break them.
  // `!`-prefixed patterns re-allow — last-match-wins mirrors `.gitignore`, so
  // the order in `denyGlobs` is load-bearing. Patterns are data (config); this
  // is just the compiler.
  const projRe = reEscape(projectDir);
  /** `<project>/**​/<glob>` as an SBPL regex — the shared shape of both glob tiers. */
  const projectGlob = (g: string): string => regex(`^${projRe}/(.*/)?${globToRegexBody(g)}(/|$)`);
  if (paths.denyGlobs.length) {
    const rules = paths.denyGlobs.map((g) => {
      const neg = g.startsWith('!');
      const re = projectGlob(neg ? g.slice(1) : g);
      return neg ? allow('file-read*', re) : deny('file-read*', re);
    });
    add('glob read-deny in project (gitignore-style — `.env`, dunder, …)', rules.join('\n'));
  }

  // Glob write-DENY, same compiler and placement, but it takes `file-write*`
  // only — the box keeps reading these files, it just can't change them.
  //
  // This closes the class of escape where the box writes a file that something
  // *outside* the sandbox executes later: clabox's own `clabox.config.*` (read
  // by the next launch, before any profile exists), `.git/config` (`core.pager`
  // / `fsmonitor` / `hooksPath` run on the user's next git command, in their own
  // shell), `.git/hooks`, and `.envrc` (direnv runs it on `cd`). The default
  // list is DEFAULT_DENY_WRITE_GLOBS in config.ts; a box can replace it.
  if (paths.denyWriteGlobs.length) {
    const rules = paths.denyWriteGlobs.map((g) => {
      const neg = g.startsWith('!');
      const re = projectGlob(neg ? g.slice(1) : g);
      return neg ? allow('file-write*', re) : deny('file-write*', re);
    });
    add(
      'glob write-deny in project (files executed OUTSIDE the box: clabox.config.*, .git/config, hooks, .envrc)',
      rules.join('\n'),
    );
  }

  // Hard secret DENY — emitted LAST of all file rules so it wins even over a
  // broad readOnly/readWrite or the project dir (SBPL = last matching rule
  // wins). This is the binding invariant: personal credentials and private keys
  // are never readable, however wide the grants above. Only the bot key subdir
  // (allowed earlier, and not matched by these patterns) stays readable.
  const hardDeny: string[] = [];
  if (config.denyDotConfigs.length) {
    hardDeny.push(regex(`^${homeRe}/\\.(${config.denyDotConfigs.join('|')})($|/)`));
  }
  hardDeny.push(
    regex(`^${homeRe}/\\.ssh/id_`),
    regex(`^${homeRe}/\\.ssh/.*\\.pem$`),
    regex(`^${homeRe}/\\.ssh/.*\\.key$`),
  );
  add(
    'hard secret DENY (always wins — credentials & private keys)',
    deny('file-read* file-write*', ...hardDeny),
  );

  // clabox's own home (~/.config/clabox) holds the box configs AND clabox's
  // compiled extras (mcp/settings json). The hard `.config` deny above blocks
  // the whole tree, and a user `paths.readWrite` CANNOT help: the hard deny is
  // emitted LAST and, SBPL being last-match-wins, always beats an earlier grant.
  // Re-grant READ-ONLY to the clabox home AFTER the hard deny so a box can read
  // its own `--mcp-config` / `--settings`. This is scoped to the `clabox` subdir
  // only — the rest of ~/.config (aws, gnupg, docker, …) stays denied — and
  // nothing credential-shaped lives here (secrets come from env, not files), so
  // the hard-deny invariant still holds.
  //
  // Deliberately NOT writable: the box configs ARE the sandbox policy, so a
  // write grant would let the sandboxed agent widen its own `paths`/`denyGlobs`
  // for the next run. clabox itself writes the compiled mcp/settings json from
  // OUTSIDE the sandbox (run.ts#writeExtraFiles, before claude starts), so
  // in-box write is never needed to run a box — only to self-edit, which is
  // exactly what we're taking away. Edit box configs from an unsandboxed shell.
  //
  // Seatbelt matches rules against the *real* (symlink-resolved) path of a vnode
  // — that's why this profile grants both `/tmp` and `/private/tmp`. When
  // ~/.config/clabox is itself a symlink (e.g. relocated INTO a project so the
  // box configs + compiled extras live in the repo), the files physically sit at
  // the symlink target, so the nominal grant never matches and the in-box access
  // fails with EPERM. Grant the resolved target too.
  const claboxDirs = [claboxHomeDir(), ...resolvedClaboxHome()];
  add(
    'clabox home (box configs + compiled mcp/settings) READ-ONLY — re-granted after the hard deny',
    [
      allow('file-read*', ...claboxDirs.map(sp)),
      // …plus exec, so a box's hook scripts can live in ~/.config/clabox (e.g.
      // a notify.sh) and actually run in-box without a separate `paths.exec`.
      allow('process-exec', ...claboxDirs.map(sp)),
    ].join('\n'),
  );

  // stat(2) on the ANCESTORS of everything granted above — the last file rule in
  // the profile, so it survives the hard deny (and must, because the hard deny
  // covers `~/.config` while the carve-out right above it grants
  // `~/.config/clabox`: without metadata on the intervening `~/.config`, a lookup
  // of the box's own `--mcp-config` can fail on the way down).
  //
  // This is the one place `stat` is granted implicitly rather than as part of a
  // read/write grant, and it is deliberately narrow: `literal` per directory, so
  // only the directories the profile already names become stat-able — never their
  // children. `~/.ssh` is stat-able, `~/.ssh/id_ed25519` is not; `~/Library` is,
  // `~/Library/Group Containers/<team>.<app>` is not. Paths that already carry a
  // read grant are skipped — `file-read*` includes `file-read-metadata`.
  const statDirs = [...new Set([...statRoots, ...[...granted].flatMap(pathAncestors)])]
    .filter((p) => !granted.has(p))
    .sort();
  if (statDirs.length)
    add(
      'stat(2) on granted paths ancestors (metadata only — the last file rule)',
      allow('file-read-metadata', ...statDirs.map(literal)),
    );

  // Networking, split by ADDRESS FAMILY — the profile used to emit a bare
  // `(allow network*)`, and that single line was wider than "the box may use the
  // internet". In Seatbelt a unix-socket `connect(2)` is authorized as
  // `network-outbound` with a *path* filter, so an unfiltered grant handed the box
  // every unix socket on the machine: 1Password's `t/agent.sock` (ask the agent to
  // sign → authenticate as the user), `/var/run/docker.sock` (root on the host,
  // outside every box), gpg-agent, `op`. None of it is reachable through a file
  // rule, so every deny tier in this profile missed it — a box could be denied
  // read, write AND stat on the 1Password container and still run `ssh-add -l`
  // against the agent inside it.
  //
  // IP keeps the old behaviour. Unix sockets are now opt-in per path
  // (`paths.socket`, or the `'c'` right), with one default below.
  if (config.network) {
    add(
      'networking — IP only (unix sockets are opt-in: paths.socket / `c`)',
      [
        allow('network-outbound', '(remote ip)'),
        allow('network-inbound', '(local ip)'),
        allow('network-bind', '(local ip)'),
      ].join('\n'),
    );
  }

  // The unix sockets a box may connect to. Emitted regardless of
  // `config.network`: a socket is local IPC, not internet access, so an offline
  // box can still be given `docker.sock`.
  // The resolver socket is base-policy data, emitted from the table like the rest.
  baseGroup('unix sockets (default allowlist)');

  // claude's daemon dir (`/tmp/cc-daemon-<uid>/<hash>/control.sock` plus the
  // `--bg-pty-host` sockets beside it) is the channel to the singleton
  // `claude daemon` — which runs OUTSIDE every box and can re-host this session
  // with `--fork-session --resume` and no profile. The env guard
  // (SANDBOX_ESCAPE_GUARDS) is what actually closes that escape, but it is
  // *cooperative*: a var inside a process the agent controls. So the socket now
  // follows the feature that needs it — `--rc` / `config.remoteControl`, or a
  // box that opted into background tasks — instead of being granted to every
  // box including the ones that never speak to a daemon.
  const wantsDaemon = config.remoteControl || config.allowBackgroundTasks;
  // The opener broker's socket (`clabox opener`, which runs outside the box).
  // Granted to every box unless it opts out with `opener: { enabled: false }`.
  // This is the brokered alternative to `allowOpen` and grants far less: the box
  // can ask for a Finder reveal or an editor open, and cannot choose what gets
  // executed (see src/opener/protocol.ts). The socket also only exists while a
  // broker is running, so the grant on its own opens nothing.
  const opener = resolvedOpener(config);
  const socketPaths = [
    ...(wantsDaemon ? [`/private/tmp/cc-daemon-${process.getuid?.() ?? ''}`] : []),
    ...(opener ? [openerSocketPath()] : []),
    ...paths.socket.map(expandHome),
  ];
  // Each path is emitted as BOTH matchers, because a socket grant is sometimes a
  // single socket file (`.../mDNSResponder`, `docker.sock`) and sometimes the dir
  // holding them (claude's daemon dir, whose socket names carry a hash). Apple's
  // profiles use `literal` for the former and `subpath` for the latter; emitting
  // both means a box config doesn't have to know which kind it named.
  if (socketPaths.length) {
    add(
      'unix-socket connect (opt-in per path)',
      allow('network-outbound', ...socketPaths.flatMap((p) => [lit(p), sp(p)])),
    );
  }

  // `process-fork` and nothing else: `lsopen` used to live here, and it is now
  // emitted only for `config.allowOpen` (see the Launch Services section).
  sections.push('(allow process-fork)');

  const text = `${sections.join('\n\n')}\n`;

  // Sanity-check before anyone feeds it to sandbox-exec.
  if (!/^\(version 1\)/m.test(text)) {
    throw new Error('generated sandbox profile is missing "(version 1)"');
  }
  return text;
}
