// Public API aggregator for clabox — re-exports the config loader, the SBPL
// profile builder and the sandbox launcher so the package can be used as a
// library, not just the `clabox` CLI.

export {
  buildDaemonArgs,
  buildDaemonEnv,
  type DaemonOptions,
  type DaemonResult,
  DEFAULT_DAEMON_ARGS,
  daemonLogPath,
  runDaemon,
} from './daemon/daemon.js';
export {
  type ClaboxPackage,
  claboxVersion,
  type FormatInfoOptions,
  formatInfo,
  type GatherInfoOptions,
  gatherInfo,
  type InfoData,
  resolveClaboxPackage,
} from './info/info.js';
export {
  type AliasPaths,
  aliasName,
  buildAliasFiles,
  buildIndex,
  buildWrapper,
  type InitFile,
} from './init/aliases.js';
export {
  type BuildAppOptions,
  type BuildAppResult,
  buildApp,
  canBuildApps,
  validateGhosttyConfig,
} from './init/app.js';
export {
  appBundlePath,
  type BoxCommandOptions,
  buildCommand,
  buildGhosttyConfig,
  buildLauncherSource,
  buildShellCommand,
  bundleId,
  GHOSTTY_APP_DEFAULTS,
  GHOSTTY_SECURITY_DEFAULTS,
  type GhosttyConfigOptions,
} from './init/ghostty.js';
export {
  buildRaycastCommand,
  type RaycastCommandOptions,
  raycastIcon,
} from './init/raycast.js';
export {
  type BuiltApp,
  discoverProfiles,
  type InitOptions,
  type InitResult,
  runInit,
} from './init/scaffold.js';
export {
  type AppleScriptResult,
  asQuote,
  buildOpenScript,
  GHOSTTY_BUNDLE_ID,
  type OpenSurfaceOptions,
  runAppleScript,
  SPLIT_DIRECTIONS,
  type SplitDirection,
  type SurfaceMode,
} from './sandbox/applescript.js';
export {
  type BoxExtras,
  boxSlug,
  buildBoxExtras,
  type ExtraFile,
} from './sandbox/extras.js';
export {
  BELL,
  buildNotifyHooks,
  defaultNotifyTitle,
  mergeHooks,
  NOTIFY_TTY,
  notifySeq,
  PROGRESS_STATES,
  type ProgressState,
  progressSeq,
  sanitizeOscText,
  ttyWrite,
} from './sandbox/notify.js';
export {
  buildProfile,
  detectPackagePaths,
  globalName,
  ipcName,
  literal,
  type ProfileContext,
  reEscape,
  regex,
  subpath,
} from './sandbox/profile.js';
export {
  generateProfile,
  profilePath,
  type RunOptions,
  resolveClaudeBin,
  resolveProjectDir,
  runClaude,
  which,
} from './sandbox/run.js';
export {
  buildTabDecor,
  normalizeColor,
  shortenHome,
  type TabDecor,
  type TabDecorOptions,
  tabTitle,
} from './sandbox/tab.js';
export {
  MUTE_ARGS,
  NO_GUARD,
  type SttyIo,
  sttyIo,
  suppressEcho,
  type TtyGuard,
} from './sandbox/tty.js';
export {
  type AppBuilderConfig,
  type AppConfig,
  type BotConfig,
  type Config,
  configsDir,
  defaultConfig,
  expandHome,
  FLAG_FETCH_BLOCKERS,
  findConfigFile,
  HOME,
  type LoadedConfig,
  listBoxes,
  loadConfig,
  type McpServer,
  mergeConfig,
  type NotifyConfig,
  type PathRules,
  resolveBox,
  type TabConfig,
  withExtraEnv,
  withExtraPaths,
} from './utils/config.js';
