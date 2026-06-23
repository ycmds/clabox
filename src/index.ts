// Public API aggregator for clabox — re-exports the config loader, the SBPL
// profile builder and the sandbox launcher so the package can be used as a
// library, not just the `clabox` CLI.

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
  runClaude,
} from './sandbox/run.js';
export {
  type BotConfig,
  type Config,
  defaultConfig,
  expandHome,
  findConfigFile,
  HOME,
  type LoadedConfig,
  loadConfig,
  mergeConfig,
  type PathRules,
} from './utils/config.js';
