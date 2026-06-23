// Example clabox config. Copy to `clabox.config.mjs` (in your
// project root) or `~/.config/clabox/config.mjs`, then edit.
//
// Default-export either a plain object (merged over the built-in defaults) or
// a function `(defaults) => config` for full control. `~` is expanded to $HOME.

export default {
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

  // Outbound network (set false to cut it off entirely).
  network: true,

  // Process-table cap inside the sandbox (fork-bomb guard); 0 to disable.
  ulimitProcs: 1024,

  // Extra directory granted read + execute (e.g. shared Claude hooks).
  hooksDir: null, // '~/some/hooks'

  // Extra rules layered on top of the base profile.
  paths: {
    readWrite: [], // e.g. ['~/scratch', '/Volumes/work']
    readOnly: [], // e.g. ['~/reference-data']
    exec: [], // e.g. ['/opt/some/tool/bin']
    deny: [], // e.g. ['~/secret-project']
  },

  // Home subdirectories denied entirely (read + write).
  denyHome: ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'],

  // Dotfile config dirs under $HOME denied entirely (.config/git is re-allowed
  // read-only regardless, so git keeps working).
  denyDotConfigs: ['aws', 'gnupg', 'kube', 'docker', 'config'],
};
