// I/O for `clabox init`: discover the box configs in `<base>/configs/`,
// (re)write the shell aliases into `<base>/scripts/`, and — for boxes that opt
// in via `app` — generate a Ghostty config in `<base>/ghostty/` and build a
// standalone `<appsDir>/<name>.app` (see init/app.ts).

import fs from 'node:fs';
import path from 'node:path';
import { buildBoxExtras } from '../sandbox/extras.js';
import {
  type Config,
  expandHome,
  configsDir as globalConfigsDir,
  listBoxes,
  loadConfig,
  resolveBox,
} from '../utils/config.js';
import { buildAliasFiles } from './aliases.js';
import { buildApp, canBuildApps } from './app.js';
import { appBundlePath, buildGhosttyConfig } from './ghostty.js';
import { buildRaycastCommand } from './raycast.js';

/**
 * Box names (sorted, de-duplicated) discovered in `<configsDir>` via the same
 * rules as `-b`: both `<name>.mjs` and `<name>.config.mjs`, `_`-prefixed
 * shared partials (e.g. `_presets.mjs`) skipped.
 */
export function discoverProfiles(configsDir: string): string[] {
  if (!fs.existsSync(configsDir)) {
    throw new Error(`clabox init: configs dir not found: ${configsDir}`);
  }
  const names = listBoxes(configsDir);
  if (names.length === 0) {
    throw new Error(`clabox init: no box configs (*.mjs) in ${configsDir}`);
  }
  return names;
}

/** Remove previously generated artifacts (`index.sh`, `clabox-*.sh`). */
function pruneGenerated(scriptsDir: string): void {
  if (!fs.existsSync(scriptsDir)) return;
  for (const f of fs.readdirSync(scriptsDir)) {
    if (f === 'index.sh' || (f.startsWith('clabox-') && f.endsWith('.sh'))) {
      fs.rmSync(path.join(scriptsDir, f), { force: true });
    }
  }
}

/** Remove files in `dir` whose name ends with `ext` (a no-op if dir is absent). */
function pruneByExt(dir: string, ext: string): void {
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (f.endsWith(ext)) fs.rmSync(path.join(dir, f), { force: true });
  }
}

/**
 * The `clabox` command baked into the generated Ghostty `command`. Default is a
 * bare `clabox` resolved from PATH at launch time by the `zsh -lic` login shell
 * — this survives package-manager moves (e.g. bun → npm/homebrew) that change
 * the binary's absolute path. Only an explicit `appBuilder.claboxBin` pins an
 * absolute path.
 */
function resolveClaboxBin(configured: string | null): string {
  return configured ? expandHome(configured) : 'clabox';
}

/**
 * The `CLABOX_CONFIGS_DIR` value to bake into generated commands, or null to
 * omit it. Omit when `<dir>` resolves (realpath, symlinks included) to the
 * runtime default `~/.config/clabox/configs` — then `-b` finds the box via that
 * default at launch time, so no path needs baking (and it stays correct if the
 * dir later moves behind the same symlink). Otherwise bake the absolute path so
 * `-b` resolves the box regardless of the launcher's cwd.
 */
function bakeConfigsDir(dir: string): string | null {
  try {
    // The launched process has no CLABOX_CONFIGS_DIR set (we omit it), so its
    // runtime default is always ~/.config/clabox/configs — compare against that.
    if (fs.realpathSync(dir) === fs.realpathSync(expandHome('~/.config/clabox/configs'))) {
      return null;
    }
  } catch {
    // default dir missing/unresolvable → bake the explicit path.
  }
  return dir;
}

/**
 * Default base dir for `init`: the parent of the global configs dir — i.e.
 * `~/.config/clabox` (or the parent of `CLABOX_CONFIGS_DIR`). This keeps `init`
 * in sync with the dir `-b` resolves boxes from, so `clabox init` works from any
 * cwd. Override with `--dir` for a project-local `<dir>/configs` layout.
 */
export function defaultBaseDir(): string {
  return path.dirname(globalConfigsDir());
}

/** Options for {@link runInit}. */
export interface InitOptions {
  /** Base dir holding `configs/` and `scripts/`. Default: {@link defaultBaseDir}. */
  baseDir?: string;
  /** Build the Ghostty apps for `app` boxes. Default: true. */
  buildApps?: boolean;
  /** Limit app building to a single box (by box name or app display name). */
  only?: string | null;
}

/** A standalone Ghostty app built by `clabox init`. */
export interface BuiltApp {
  box: string;
  appPath: string;
  signed: 'identity' | 'adhoc';
}

/** Result of {@link runInit}. */
export interface InitResult {
  profiles: string[];
  scriptsDir: string;
  indexFile: string;
  written: string[];
  /** Apps successfully built. */
  apps: BuiltApp[];
  /** Generated Ghostty config files. */
  ghosttyConfigs: string[];
  /** Generated Raycast command scripts. */
  raycastCommands: string[];
  /** Compiled per-box MCP json files (from `config.mcp`). */
  extraFiles: string[];
  /** Non-fatal issues (e.g. app build skipped/failed). */
  warnings: string[];
}

/**
 * Compile each box's declarative `mcp` (→ `<configDir>/mcp/<box>.json`) so the
 * files exist ahead of the first run (the same files `run` writes; slug = box
 * name). Best-effort per box: a config that fails to load becomes a warning.
 */
async function materializeExtras(
  configsDir: string,
  profiles: string[],
  result: InitResult,
): Promise<void> {
  for (const name of profiles) {
    try {
      const { config } = await loadConfig(resolveBox(name, configsDir));
      for (const f of buildBoxExtras(config, name).files) {
        fs.mkdirSync(path.dirname(f.path), { recursive: true });
        // 0600 — the MCP json can carry an auth token (see run.ts#writeExtraFiles).
        fs.writeFileSync(f.path, f.content, { mode: 0o600 });
        fs.chmodSync(f.path, 0o600);
        result.extraFiles.push(f.path);
      }
    } catch (e) {
      result.warnings.push(`${name}: extras not materialized — ${(e as Error).message}`);
    }
  }
}

/** Generate the Ghostty configs and build the apps for every `app` box. */
async function buildAppArtifacts(
  base: string,
  configsDir: string,
  profiles: string[],
  only: string | null,
  result: InitResult,
): Promise<void> {
  // Load each box config; keep the ones that opt into an app (and match `only`).
  const appBoxes: { name: string; config: Config }[] = [];
  for (const name of profiles) {
    const { config } = await loadConfig(resolveBox(name, configsDir));
    if (!config.app) continue;
    if (only && name !== only && config.app.name !== only) continue;
    appBoxes.push({ name, config });
  }
  if (appBoxes.length === 0) return;

  const ghosttyDir = path.join(base, 'ghostty');
  const raycastDir = path.join(base, 'raycast');
  fs.mkdirSync(ghosttyDir, { recursive: true });
  fs.mkdirSync(raycastDir, { recursive: true });
  // Only prune on a full run — with `only` we'd orphan other apps' artifacts.
  if (!only) {
    pruneByExt(ghosttyDir, '.config');
    pruneByExt(raycastDir, '.sh');
  }

  for (const { name, config } of appBoxes) {
    const app = config.app;
    if (!app) continue; // narrowed above; keeps the type checker happy
    const configPath = path.join(ghosttyDir, `${name}.config`);
    const projectDir = config.cwd ? path.resolve(expandHome(config.cwd)) : null;
    const baseGhostty = config.appBuilder.baseGhosttyConfig
      ? expandHome(config.appBuilder.baseGhosttyConfig)
      : null;
    fs.writeFileSync(
      configPath,
      buildGhosttyConfig({
        app,
        boxName: name,
        projectDir,
        configsDir: bakeConfigsDir(configsDir),
        claboxBin: resolveClaboxBin(config.appBuilder.claboxBin),
        baseGhosttyConfig: baseGhostty,
      }),
    );
    result.ghosttyConfigs.push(configPath);

    // Raycast command that opens the (to be) built bundle.
    const appPath = appBundlePath(expandHome(config.appBuilder.appsDir), app);
    const raycastPath = path.join(raycastDir, `${name}.sh`);
    fs.writeFileSync(raycastPath, buildRaycastCommand({ app, appPath }));
    fs.chmodSync(raycastPath, 0o755);
    result.raycastCommands.push(raycastPath);

    const check = canBuildApps(config.appBuilder);
    if (!check.ok) {
      result.warnings.push(`${name}: app not built (${check.reason})`);
      continue;
    }
    try {
      const built = buildApp({ boxName: name, app, builder: config.appBuilder, configPath });
      result.apps.push({ box: name, appPath: built.appPath, signed: built.signed });
    } catch (e) {
      result.warnings.push(`${name}: app build failed — ${(e as Error).message}`);
    }
  }
}

/** Scan the configs dir, (re)write the alias scripts, and build `app` apps. */
export async function runInit({
  baseDir,
  buildApps = true,
  only = null,
}: InitOptions = {}): Promise<InitResult> {
  const base = path.resolve(baseDir ?? defaultBaseDir());
  const configsDir = path.join(base, 'configs');
  const scriptsDir = path.join(base, 'scripts');
  const profiles = discoverProfiles(configsDir);

  fs.mkdirSync(scriptsDir, { recursive: true });
  pruneGenerated(scriptsDir);

  const files = buildAliasFiles(profiles, { configsDir: bakeConfigsDir(configsDir), scriptsDir });
  for (const f of files) {
    fs.writeFileSync(f.path, f.content);
    if (f.executable) fs.chmodSync(f.path, 0o755);
  }

  const result: InitResult = {
    profiles,
    scriptsDir,
    indexFile: path.join(scriptsDir, 'index.sh'),
    written: files.map((f) => f.path),
    apps: [],
    ghosttyConfigs: [],
    raycastCommands: [],
    extraFiles: [],
    warnings: [],
  };

  await materializeExtras(configsDir, profiles, result);

  if (buildApps) {
    await buildAppArtifacts(base, configsDir, profiles, only, result);
  }
  return result;
}
