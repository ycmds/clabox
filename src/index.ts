// Public API aggregator for clabox — re-exports the config loader, the SBPL
// profile builder and the sandbox launcher so the package can be used as a
// library, not just the `clabox` CLI.

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
} from './init/app.js';
export {
  appBundlePath,
  buildCommand,
  buildGhosttyConfig,
  buildLauncherSource,
  bundleId,
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
  type BoxExtras,
  boxSlug,
  buildBoxExtras,
  type ExtraFile,
} from './sandbox/extras.js';
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
  resolveProjectDir,
  runClaude,
  which,
} from './sandbox/run.js';
export {
  type AppBuilderConfig,
  type AppConfig,
  type BotConfig,
  type Config,
  configsDir,
  defaultConfig,
  expandHome,
  findConfigFile,
  HOME,
  type LoadedConfig,
  listBoxes,
  loadConfig,
  type McpServer,
  mergeConfig,
  type PathRules,
  resolveBox,
} from './utils/config.js';
