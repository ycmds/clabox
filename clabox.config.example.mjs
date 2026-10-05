// Example clabox config. Copy to `clabox.config.mjs` (in your
// project root) or `~/.config/clabox/config.mjs`, then edit.
//
// Default-export either a plain object (merged over the built-in defaults) or
// a function `(defaults) => config` for full control. `~` is expanded to $HOME.

export default {
  // Working directory to run `claude` in (also granted RW as the project dir).
  // null → the shell's CWD. Set it on a named box that should always target one
  // project regardless of where you launch `clabox` from. `~` is expanded.
  cwd: null, // e.g. '~/projects/my-app'

  // Which Claude profile/account to use.
  configDir: '~/.claude',

  // Args always passed to `claude`, before any args from the CLI.
  claudeArgs: ['--settings', '{"includeCoAuthoredBy": false}'],

  // Identity forced onto git commits/pushes made from inside the sandbox.
  bot: {
    name: 'claudeBOT',
    email: 'bot@example.com',
    // If `${sshDir}/id_ed25519` exists, git ssh is pinned to it and your
    // personal keys (~/.ssh/id_*, *.pem, *.key) stay denied either way.
    sshDir: '~/.ssh/claudebot',
  },

  // Extra environment variables forced onto the sandboxed `claude` process.
  // Layered after the built-in vars (so a key here wins) and on top of the
  // inherited shell env. Handy for secrets like GITHUB_TOKEN. Don't hard-code
  // secrets in a config committed to the repo — read them from process.env, or
  // keep this file in ~/.config/clabox/config.mjs (outside the project).
  env: {
    // GITHUB_TOKEN: process.env.MY_GH_TOKEN ?? '',
  },

  // Outbound network (set false to cut it off entirely).
  network: true,

  // Claude's background tasks — a sandbox ESCAPE HATCH, off by default.
  // A background task isn't forked by the sandboxed claude: the request goes to
  // the singleton `claude daemon run` supervisor, which lives OUTSIDE every box
  // (PPID 1 / launchd) and re-launches the session with `--fork-session
  // --resume`. Same session id, same transcript, NO Seatbelt profile — the box
  // is simply gone, while its system prompt still claims otherwise.
  // Set true only for a box you'd be happy to run unsandboxed.
  allowBackgroundTasks: false,

  // `/usr/bin/open` + Launch Services — the OTHER sandbox ESCAPE HATCH, also
  // off by default. `open` forks nothing in-box: it asks LaunchServices (which
  // runs outside every sandbox) to start a target, and the target comes up
  // under launchd with NO profile. Since the box can write `.app` bundles into
  // /tmp, $TMPDIR and the project, granting this is arbitrary code execution as
  // you — and unlike background tasks it needs no running daemon.
  allowOpen: false,

  // The opener BROKER — the safe slice of `open`, without the escape above.
  // Run ONE broker outside the sandbox (`clabox opener --detach`) and every box
  // can ask it: `clabox reveal <dir>` shows a folder in Finder, `clabox open
  // <file>` opens a file in your editor. A box sends a PATH and nothing else —
  // no flags, no choice of application — and `reveal` is always `open -R`,
  // which never launches anything.
  //
  // You normally need NOTHING here: every box may reach the broker, the default
  // roots are `[$HOME]`, and the app is picked per file type from what you have
  // installed (code → Zed/Cursor/VS Code/…, a vault note → Obsidian, an image →
  // Preview, folders → Finder).
  // Set the policy where you start the broker (`--root`, `--editor`) or in the
  // global ~/.config/clabox/config.mjs. This block is for narrowing it:
  // opener: {
  //   enabled: false,                // this box may not talk to the broker
  //   editor: 'Obsidian',            // broker-side: app for `clabox open`
  //   roots: ['~/vault'],            // broker-side: default is [$HOME]
  //   maxPerMinute: 12,
  // },

  // Grant claude's daemon socket (`/tmp/cc-daemon-<uid>`), which Remote Control
  // (`/rc`) talks over. The `--rc` CLI flag sets this per launch, so you rarely
  // need it here. Not an escape by itself, but it is the channel to the one
  // process that can re-host this session without a profile — so a box that
  // never uses `/rc` doesn't get it.
  remoteControl: false,

  // Fork-bomb guard: how many processes the box may add ON TOP of what this
  // user already runs (macOS counts RLIMIT_NPROC per uid, machine-wide, so an
  // absolute cap below the current count would make every fork in the box fail
  // — including claude's keychain read). 0 to disable.
  ulimitProcs: 1024,

  // Per-box claude hooks (claude's settings.json `hooks` map). clabox merges
  // them into a `--settings` file. For a hook script to actually run inside the
  // sandbox its dir must also be granted read (`paths.readOnly`) + exec
  // (`paths.exec`) below — `hooks` only registers it with claude.
  // hooks: {
  //   Stop: [{ hooks: [{ type: 'command', command: '~/some/hooks/notify.sh' }] }],
  //   Notification: [{ hooks: [{ type: 'command', command: '~/some/hooks/notify.sh' }] }],
  // },

  // Extra rules layered on top of the base profile.
  //
  // One entry per PATH, its value the rights it carries:
  //   r = read   (contents + metadata)
  //   w = write  (and read with it — a writable path is readable)
  //   s = stat   ONLY: existence, size, mode, mtime. No contents, no listing.
  //              The profile grants no metadata globally, so this is how a path
  //              whose contents must stay denied still becomes stat-able. The
  //              hard secret deny still wins, so it can't uncover ~/.ssh/id_*.
  //   e = exec   (process-exec — orthogonal to the three above)
  //   c = connect to the unix socket at this path. Also orthogonal: a socket
  //              connect is networking, not file I/O, so 'r'/'w' never grant it
  //              and a file deny never takes it away. Sockets are DENIED by
  //              default — this is the opt-in (docker.sock, an ssh-agent, …).
  //   d = deny   read + write + stat + connect. Exclusive: 'rd' throws.
  // Narrowest first, each wider right implies the ones below: 'w' ≡ 'rw'.
  // Write 'rw', ['r','w'] or ['read','write'] — whichever reads better.
  paths: {
    // '~/scratch': 'w',                   // read + write
    // '~/reference-data': 'r',            // read-only
    // '~/some/hooks': 're',               // read + exec, so a hook can run
    // '~/Library/Group Containers': 's',  // it exists, nothing more
    // '/var/run/docker.sock': 'c',        // may talk to this socket
    // '~/secret-project': 'd',            // denied outright
    //
    // In a box that builds on a preset, this form removes the per-class
    // spreading:
    //   paths: { ...presets.root.paths, '~/scratch': 'w' }
    // instead of spreading readOnly / readWrite / exec one by one. The outer
    // `...preset.paths` is still required — spreading a preset inside a config
    // file is plain JS, so `paths:` replaces the preset's object; clabox only
    // deep-merges the defaults with this file.
    //
    // The original per-class spelling still works, and mixes freely with the
    // above: read / write / stat / exec / deny (+ the older aliases readOnly =
    // read, readWrite = write).
    // read: ['~/reference-data'],
    // write: ['~/scratch'],
    // stat: ['/Applications'],
    // exec: ['/opt/some/tool/bin'],
    // socket: ['/var/run/docker.sock'],
    // deny: ['~/secret-project'],

    // gitignore-style READ-deny, matched at any depth INSIDE the project dir.
    // `!` re-allows and last match wins, exactly like .gitignore, so order
    // matters. Scoped to the project on purpose (a global match could also
    // shadow system runtimes granted earlier and break them). Empty by default;
    // e.g. hide every `.env*` secret but keep the `.env.example` template.
    denyGlobs: [], // e.g. ['**/.env*', '!**/.env.example', '**/___*']

    // gitignore-style WRITE-deny, same matching rules — but this one ships a
    // non-empty default, because each path in it is executed OUTSIDE the box
    // later on, which would turn a write inside the box into code running as
    // you: `clabox.config.*` is imported by the next clabox run (before any
    // profile exists), `.git/config` carries core.pager / fsmonitor /
    // sshCommand / hooksPath (commands git runs on your next `git log`),
    // `.git/hooks` likewise, and `.envrc` is run by direnv just for `cd`-ing in.
    // The box still READS all of them. Override only if you need it — e.g.
    // `git worktree add` / `git remote add` write `.git/config` and will fail.
    // denyWriteGlobs: ['**/clabox.config.*', '**/.git/config', '**/.git/hooks', '**/.envrc'],
  },

  // Home subdirectories denied entirely (read + write).
  denyHome: ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'],

  // Dotfile config dirs under $HOME denied entirely (.config/git is re-allowed
  // read-only regardless, so git keeps working).
  denyDotConfigs: ['aws', 'gnupg', 'kube', 'docker', 'config'],

  // How the terminal tab looks while this box runs. The `rc*` fields kick in
  // for a `clabox --rc` launch, so a tab that's reachable from the Claude app
  // (feature flags on, /rc available) can't be mistaken for a private one.
  // Written only onto a real TTY; every color is reset when claude exits.
  // Background AND cursor by default: `background-opacity`/blur washes a
  // background out, a blinking cursor stays obvious. Env overrides:
  // CLABOX_TAB_TITLE, CLABOX_TAB_RC_BADGE, CLABOX_TAB_{,RC_}BACKGROUND,
  // CLABOX_TAB_{,RC_}CURSOR, CLABOX_TAB_{,RC_}FOREGROUND (empty value = off).
  tab: {
    title: null, // fixed title; null → the project dir, `~`-shortened
    rcBadge: '📡 RC', // prefixed to the title while --rc is on; null → none
    background: null, // e.g. '#0d1117'; null → keep the terminal's own
    rcBackground: '#5c1a00', // --rc background; null → fall back to `background`
    cursor: null, // e.g. '#58a6ff'; null → keep the terminal's own
    rcCursor: '#ff8c1a', // --rc cursor; null → fall back to `cursor`
    foreground: null, // text color; null → keep the terminal's own
    rcForeground: null, // --rc text color; off by default (readability)
  },

  // Desktop notifications that work INSIDE the sandbox: clabox compiles these
  // into claude hooks that write terminal escape sequences to /dev/tty (Ghostty
  // renders OSC 777 as a real banner, OSC 9;4 as tab/dock progress, BEL as the
  // bell). terminal-notifier/osascript can't work in a box — they need mach
  // services Seatbelt denies. Off by default; env: CLABOX_NOTIFY=1.
  notify: {
    enabled: false,
    title: null, // null → `Claude · <box>`
    stop: 'reply is ready', // banner when a reply lands; null → no banner
    waiting: 'waiting for you', // banner when claude blocks on you; null → off
    progress: true, // yellow tab while it waits, cleared when the reply lands
    bell: true, // BEL — ghostty's `bell-features` decides what that does
  },

  // Opt-in: turn this box into a standalone Ghostty app. With `app` present,
  // `clabox init` writes a Ghostty config (with a `command` that runs
  // `clabox -b <box>`), a Raycast command (`<dir>/raycast/<name>.sh` → opens the
  // app), and clones Ghostty.app into <appsDir>/<name>.app. Omit `app` entirely
  // on boxes that should only get a shell alias (the default).
  // app: {
  //   name: 'AX Manager',          // → ~/Applications/AX Manager.app
  //   title: '🐈‍⬛ AX Manager',      // ghostty window title (default: name)
  //   emoji: '🐈‍⬛',                 // Raycast icon (default: the title's emoji)
  //   icon: '~/icons/ax.png',      // .icns or .png (.png is converted); .app icon
  //   macosIcon: 'retro',          // ghostty built-in macos-icon
  //   ghostty: {                   // extra raw `key = value` ghostty lines
  //     background: '#0d1117',
  //     'background-opacity': '0.92',
  //   },
  //   // bundleId: 'com.me.ax',    // default: com.ghostty.custom.<box-dotted>
  // },

  // Machine-wide settings for the `clabox init` Ghostty-app builder. Shared by
  // every `app` box — handy to set once in a shared preset. Env overrides:
  // CLABOX_GHOSTTY_APP, CLABOX_APPS_DIR, CLABOX_SIGN_ID,
  // CLABOX_GHOSTTY_BASE_CONFIG, CLABOX_CLABOX_BIN.
  appBuilder: {
    ghosttyApp: '/Applications/Ghostty.app', // donor app to clone
    appsDir: '~/Applications', // where built apps land
    signId: null, // codesign identity; null → ad-hoc (`codesign -s -`)
    baseGhosttyConfig: null, // optional leading `config-file = …`
    claboxBin: null, // clabox path baked into `command`; null → autodetect
  },
};
