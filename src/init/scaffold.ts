// I/O for `clabox init`: discover the box configs in `<base>/configs/`,
// (re)write the shell aliases into `<base>/scripts/`, and — for boxes that opt
// in via `app` — generate a Ghostty config in `<base>/ghostty/` and build a
// standalone `<appsDir>/<name>.app` (see init/app.ts).

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, expandHome, listBoxes, loadConfig, resolveBox } from '../utils/config.js';
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

/** Locate the `clabox` binary to bake into the generated Ghostty `command`. */
function resolveClaboxBin(configured: string | null): string {
  if (configured) return expandHome(configured);
  try {
    const found = execFileSync('command', ['-v', 'clabox'], {
      shell: '/bin/sh',
      encoding: 'utf8',
    }).trim();
    if (found) return found;
  } catch {
    // fall through
  }
  return 'clabox';
}

/** Options for {@link runInit}. */
export interface InitOptions {
  /** Base dir holding `configs/` and `scripts/`. Default: `<cwd>/__`. */
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
  /** Non-fatal issues (e.g. app build skipped/failed). */
  warnings: string[];
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
        configsDir,
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
  const base = path.resolve(baseDir ?? path.join(process.cwd(), '__'));
  const configsDir = path.join(base, 'configs');
  const scriptsDir = path.join(base, 'scripts');
  const profiles = discoverProfiles(configsDir);

  fs.mkdirSync(scriptsDir, { recursive: true });
  pruneGenerated(scriptsDir);

  const files = buildAliasFiles(profiles, { configsDir, scriptsDir });
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
    warnings: [],
  };

  if (buildApps) {
    await buildAppArtifacts(base, configsDir, profiles, only, result);
  }
  return result;
}
