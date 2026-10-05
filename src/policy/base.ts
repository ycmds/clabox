// The declarative half of the sandbox policy: the built-in rules as DATA, with
// nothing computed and no I/O. `utils/config.ts` holds the logic that loads,
// merges and resolves a config; `sandbox/profile.ts` is the compiler that turns
// these tables into SBPL. This file is the one place to read, review or change
// what a box is allowed by default.
//
// Rights letters (the same ones a box config uses): `r` read, `w` write (read
// comes with it), `s` stat only, `e` exec, `m` map-executable, `i` ioctl,
// `c` unix-socket connect, `d` deny, plus the matcher modifier `l` = this path
// only, not the tree below it. A key starting with `^` is an SBPL regex.
//
// What is deliberately NOT here, because it cannot be written as a static
// value: the package managers found at runtime (`profile.ts#detectPackagePaths`),
// the Xcode toolchain behind `xcode-select` (`#resolvedDeveloperDirs`), the
// Claude config dir, the bot ssh dir, the project workspace, clabox's own home,
// and the non-path grants (mach services, `sysctl-read`, `signal`,
// `process-info*`) — those are still built in `profile.ts`.

/**
 * One group of built-in path grants: a profile section's worth of
 * `path: rights`, in the order they're emitted.
 *
 * These used to be hand-written SBPL calls inside `buildProfile`. They live here
 * as data so the base policy reads like a box config (same letters, same
 * `path: rights` shape) and so a box can **override any of them**: `paths` is
 * deep-merged, so `'/System': 'r'` in a config narrows the system runtime, and
 * `'~/Library/Keychains': 'd'` takes the keychain away from that box.
 */
export interface BasePathGroup {
  /** Section comment in the generated profile. */
  title: string;
  /** `path: rights` — see {@link PathGrant}. `~` is expanded, `^…` is a regex. */
  paths: GrantTable;
  /**
   * Emit after the soft privacy deny instead of before it. Only for grants that
   * must survive a `denyHome`/`paths.deny` entry covering the same tree (SBPL is
   * last-match-wins), e.g. the ssh bits a box needs to push.
   */
  afterSoftDeny?: boolean;
}

/** `path: rights` table — the shape `BasePathGroup.paths` and `config.paths` share. */
export type GrantTable = Record<string, string>;

/**
 * The top-level directories macOS ships as symlinks into `/private`.
 *
 * Seatbelt matches a rule against the **resolved** vnode path, so a grant has
 * to be spelled in resolved form to authorize anything: `/private/var/db/timezone`
 * is what lets a tool open `/var/db/timezone`, and a rule written `/var/db/...`
 * matches nothing at all. The reverse is also true — the *link itself* is read
 * while walking a path through it, which is why each root is granted on its own
 * (`/etc` carries `'sl'`, `/tmp` is paired with `/private/tmp`).
 *
 * The trap this constant exists for: that `literal` trick looks like it
 * generalizes to any `/var/...` path, and it does not. `/etc` works because
 * `/etc` *is* the symlink; a path below a symlinked root is a different vnode.
 * A first attempt at the `xcode-select` fix granted `/var/select` and a literal
 * `/var/db/xcode_select_link`, which authorized nothing and left every box
 * without `git` or `python3` — the symptom it was meant to fix.
 * `tests/profile.test.ts` enforces the pairing for every base-policy path.
 */
export const PRIVATE_SYMLINK_ROOTS = ['/etc', '/tmp', '/var'];

/**
 * The built-in base policy, as data. `buildProfile` walks these in order and
 * compiles each one; a path listed in `config.paths` overrides the entry here
 * while keeping this position in the profile.
 *
 * Rights: `r` read, `w` write (read comes with it), `s` stat only, `m`
 * map-executable, `e` exec, `i` ioctl, `c` unix-socket connect, `d` deny, and the
 * matcher modifier `l` = this path only (not the tree below it).
 *
 * What is NOT here, because it can't be expressed as a static path: the package
 * managers found at runtime (`detectPackagePaths`), the Xcode toolchain behind
 * `xcode-select` (`resolvedDeveloperDirs`), the Claude config dir
 * (`config.configDir`), the bot ssh dir (`config.bot.sshDir`), the project
 * workspace, clabox's own home, and the non-path grants (mach services,
 * `sysctl-read`, `signal`, `process-info*`).
 */
export const BASE_PATH_GROUPS: BasePathGroup[] = [
  {
    title: 'basic dir traversal',
    paths: {
      '/': 'rl', // every absolute lookup walks through the root
      '/private': 'rl', // …and through /private, where /tmp and /var really live
      '/Users': 'rl', // the home's parent: needed to resolve $HOME at all
      '~': 'rl', // the home dir itself (listing included), nothing inside it
    },
  },
  {
    title: 'system runtime + exec (read-only)',
    paths: {
      '/System': 'rme', // the OS itself: frameworks, dyld cache, /System/Volumes
      '/usr': 'rme', // /usr/bin, /usr/lib — the shell's whole toolbox
      '/bin': 'rme', // sh, cat, ls
      '/sbin': 'rme', // ifconfig & co, occasionally shelled out to
      '/Library/Frameworks': 'rm', // third-party frameworks (node, python builds)
      '/private/etc': 'rm', // /etc/passwd, resolv.conf, ssl certs, zshenv
      // …and the `/etc` symlink that points at it. Granting only the resolved form
      // is NOT enough: walking a path through `/etc/...` reads the link itself, and
      // nothing else supplies that — the stat-ancestors pass only climbs *above*
      // granted paths, and no grant lives under `/etc`. Same symlink-vs-resolved
      // pair as `/tmp` + `/private/tmp` below, which spells both out on purpose.
      // Without it the system `curl` cannot open its default CAfile
      // `/etc/ssl/cert.pem` ("error setting certificate verify locations",
      // http_code 000), which reads as "the box has no network" — it does.
      '/etc': 'sl',
      // The shared dyld cache: every exec maps it. Spelled **resolved** —
      // `/var` is a symlink to `private/var`, and Seatbelt matches the resolved
      // vnode path, so a rule written `/var/db/...` matches nothing (see
      // `PRIVATE_SYMLINK_ROOTS` and the test that enforces the pairing).
      '/private/var/db/dyld': 'rm',
      '/var/db/dyld': 'rm', // the unresolved spelling too, for a host where /var is real
      // The links `xcode-select` maintains. `/usr/bin/{git,python3,clang,swift}` are
      // shims that resolve the *selected* toolchain through one of these before they
      // exec anything, so a denied link takes out the whole toolchain even though the
      // bundle it points at is granted below: every shim dies with `xcode-select:
      // error: unable to read data link at '/var/select/developer_dir'` — no `git`
      // and no `python3` in the box at all. The location moved (`/var/db/…` through
      // macOS 15, `/var/select/…` on 26+), so both are granted; an absent one costs
      // nothing. See also `resolvedDeveloperDirs`, which reads the same links to
      // grant whatever bundle they resolve to.
      //
      // `/var/select` is granted as a tree, not just the one link: it is the
      // system's alias dir, and `/var/select/sh` (the default-shell selector) is
      // read by *every* `/bin/sh` startup — denied, each one prints `Error opening
      // /private/var/select/sh: Operation not permitted` onto the shell's stderr,
      // which lands in the middle of unrelated command output.
      //
      // **Both spellings, and the resolved one is the load-bearing half.** The
      // first version of this fix granted only `/var/select` + a `literal`
      // `/var/db/xcode_select_link`, and that authorizes nothing: the kernel
      // resolves `/var` → `/private/var` before matching, which is exactly why
      // `/private/var/db/timezone` below works when a tool asks for
      // `/var/db/timezone`. The `literal` trick that makes `/etc` work does NOT
      // generalize — it works there because `/etc` *is* the symlink, so reading
      // the link is reading that path; a path *below* a symlinked root is a
      // different vnode and needs the resolved rule.
      '/private/var/select': 'r',
      '/var/select': 'r',
      '/private/var/db/xcode_select_link': 'rl',
      '/var/db/xcode_select_link': 'rl',
      '/usr/bin/env': 'el', // shebang target; `l` because /usr is already exec'able
    },
  },
  {
    title: 'temp dirs (RW)',
    paths: {
      '/tmp': 'rw', // the symlink form, which is what most tools write
      '/private/tmp': 'rw', // …and the resolved form Seatbelt actually matches
      '^/private/var/folders/': 'rw', // the per-user $TMPDIR (mkdtemp, caches)
    },
  },
  {
    title: 'Claude runtime state & caches (RW)',
    paths: {
      // The version lock claude takes at startup; it writes a `.lock.tmp.<rand>`
      // sibling, so read-only shows up as "NON-FATAL: Lock acquisition failed".
      '~/.local/state/claude': 'rw',
      // Per-MCP-server log batches; without write they're dropped every time
      // ("Dropping log batch for …"). No credentials here — tokens are in the keychain.
      '~/Library/Caches/claude-cli-nodejs': 'rw',
      '~/.cache/claude': 'r', // auto-update cache; nothing writes to it in a box
    },
  },
  {
    title: 'package-manager caches (RW)',
    paths: {
      // npm's cache dir (`_cacache`, `_logs`). Read-only is not enough — npm mkdirs
      // `_cacache/tmp` on *every* command, `npm view` included. Denied, npm blames
      // the wrong thing: it answers any EPERM under here with "Your cache folder
      // contains root-owned files … run sudo chown", so the box looks broken and the
      // suggested `chown` changes nothing. No credentials live here — the auth tokens
      // are in `~/.npmrc`, which this does not grant.
      '~/.npm': 'rw',
    },
  },
  {
    title: 'time-zone & prefs (RO)',
    paths: {
      '/private/var/db/timezone': 'r', // localtime; without it every date is UTC
      '/Library/Preferences': 'r', // machine-wide prefs read by system libraries
    },
  },
  {
    title: '/dev access (RO) + ioctl',
    paths: {
      '/dev': 'rl', // the dir itself, so a tool can open the entries below
      // Entropy: CPython seeds hash randomization here and fatals at preinit
      // without it (`_Py_HashRandomization_Init`), Node crypto/openssl/git too.
      '/dev/random': 'rl',
      '/dev/urandom': 'rl',
      '^/dev/(tty.*|null|zero|dtracehelper)': 'rw', // the tty + the usual sinks
      '/dev/dtracehelper': 'il', // dtrace ioctl, touched by some runtimes
      '^/dev/tty.*': 'i', // termios: raw mode, window size
    },
  },
  {
    title: 'user prefs & keychain',
    paths: {
      '~/Library/Preferences': 'r', // per-user prefs (locale, NSGlobalDomain)
      // RW so claude can persist a refreshed OAuth token — read-only means the
      // login dies ~24h later with a 401.
      '~/Library/Keychains': 'rw',
    },
  },
  {
    title: 'git config (RO)',
    paths: {
      '~/.gitconfig': 'rl', // user.name/email, aliases, includeIf
      '~/.gitignore_global': 'rl', // referenced by core.excludesfile
      '~/.config/git': 'r', // the XDG location of the same (hard-denied ~/.config is re-opened here)
    },
  },
  {
    title: 'SSH: known_hosts + config (personal keys hard-denied at the very end)',
    // After the soft deny: a box that pushes needs these even when its config
    // denies a tree that contains them.
    afterSoftDeny: true,
    paths: {
      '~/.ssh': 'rl', // the dir itself, not its contents
      '~/.ssh/config': 'rl', // Host aliases, IdentityFile, ProxyCommand
      '~/.ssh/known_hosts': 'rwl', // write: accepting a new host key
      '~/.ssh/known_hosts2': 'rwl',
    },
  },
  {
    title: 'unix sockets (default allowlist)',
    paths: {
      // The system resolver. Without it name resolution fails inside the box,
      // which reads as "claude can't reach the API" rather than a sandbox denial.
      '/private/var/run/mDNSResponder': 'c',
    },
  },
];

/**
 * Files inside the project workspace the box may read but **not write**.
 *
 * The project dir is granted RW because writing code there is the job. But a
 * few paths in a checkout aren't data — they are *executed outside the sandbox*
 * the next time a human (or a tool of theirs) touches the repo, which turns a
 * box-local write into unsandboxed code execution as the user:
 *
 *   - `clabox.config.*` — clabox's own config, `import()`ed **before**
 *     `sandbox-exec` starts. An agent that plants one owns the next bare
 *     `clabox` run in that repo (and could just declare `paths: {'/': 'w'}`).
 *   - `.git/config` — `core.pager`, `core.sshCommand`, `core.fsmonitor` and
 *     `core.hooksPath` are all commands git runs. A `[core] pager = sh -c …`
 *     fires on the user's next `git log`, outside every box.
 *   - `.git/hooks` — the same thing by its canonical name: `git commit` in a
 *     normal shell runs them.
 *   - `.envrc` — direnv executes it merely for `cd`-ing into the directory.
 *
 * None of these is something an agent needs to write to do its work, so the
 * default denies them; a box that disagrees sets its own `denyWriteGlobs`.
 * Scoped to the project dir like `denyGlobs`, and emitted before the hard
 * secret deny so that still wins.
 */
export const DEFAULT_DENY_WRITE_GLOBS = [
  '**/clabox.config.*',
  '**/.git/config',
  '**/.git/hooks',
  '**/.envrc',
];

/**
 * Env vars the launcher forces into every box that hasn't set
 * {@link Config.allowBackgroundTasks} — the vars that close claude's
 * **background-task escape hatch**.
 *
 * Why it's an escape and not just a feature: a background task is not forked by
 * the sandboxed claude (a macOS sandbox is inherited and can't be dropped, so a
 * real fork would stay confined). The in-box process asks the singleton
 * `claude daemon run` supervisor over its control socket, and that daemon runs
 * **outside every box** — PPID 1, started by launchd, no `sandbox-exec` anywhere
 * in its ancestry. It answers by launching `claude --fork-session --resume
 * <same-session-id>`, so the work continues with the identical transcript and an
 * empty Seatbelt policy. Observed ancestry of such a session:
 *
 *     zsh ← claude --fork-session --resume ← ClaudeCode.app --bg-pty-host
 *         ← claude daemon run   (PPID 1, launchd)
 *
 * It reads `~/Library/Logs/DiagnosticReports`, writes `~/Desktop`, and still
 * carries the box's "you're in a sandbox" system prompt. Only the keychain-level
 * hard denies survive, because they're macOS ACLs rather than profile rules.
 *
 * Emitted **before** `config.env` so a box (or `-e KEY=VALUE`) can still
 * override them — the guard is a default, not a lock.
 */
export const SANDBOX_ESCAPE_GUARDS: Record<string, string> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

/**
 * The env vars that turn claude's **feature-flag fetching** off. Any one of them,
 * from any source (the box `env`, the login shell, a `settings.json` `env`
 * block), is enough — and with fetching off the flag-gated features fall back to
 * their code defaults, which hides Remote Control (`/rc`), auto mode by default,
 * cross-machine session messaging, `/import`, `/skill-doctor` and more:
 * https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching
 *
 * The first two count **any non-empty value** (`0` and `false` included), so
 * they can only be neutralized by *unsetting* them — which is what the `--rc`
 * CLI flag does (it maps to `withExtraEnv(config, FLAG_FETCH_BLOCKERS)`).
 */
export const FLAG_FETCH_BLOCKERS = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_GROWTHBOOK',
];

/**
 * The base-policy keys that make the temp dirs writable — the three spellings
 * of one grant (`/tmp`, its resolved form, and the `$TMPDIR` container regex).
 * {@link boxWritableRoots} checks them together: `os.tmpdir()` is only writable
 * while none of them has been denied.
 */
export const TMP_BASE_KEYS = ['/tmp', '/private/tmp', '^/private/var/folders/'];
