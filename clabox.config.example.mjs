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

  // Process-table cap inside the sandbox (fork-bomb guard); 0 to disable.
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
  paths: {
    readWrite: [], // e.g. ['~/scratch', '/Volumes/work']
    readOnly: [], // e.g. ['~/reference-data', '~/some/hooks']
    exec: [], // e.g. ['/opt/some/tool/bin', '~/some/hooks'] (so hooks can run)
    deny: [], // e.g. ['~/secret-project']
  },

  // Home subdirectories denied entirely (read + write).
  denyHome: ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'],

  // Dotfile config dirs under $HOME denied entirely (.config/git is re-allowed
  // read-only regardless, so git keeps working).
  denyDotConfigs: ['aws', 'gnupg', 'kube', 'docker', 'config'],

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
