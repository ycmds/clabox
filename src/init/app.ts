// I/O for the `clabox init` Ghostty-app builder (macOS-only).
//
// Clones Ghostty.app into `<appsDir>/<name>.app`, swaps the binary for a tiny
// compiled launcher that bakes in `--config-file=<config>`, sets the icon,
// disables Sparkle, and re-signs. Mirrors the old ghostty-app-builder.sh. The
// pure text builders live in init/ghostty.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AppBuilderConfig, type AppConfig, expandHome } from '../utils/config.js';
import { appBundlePath, buildLauncherSource, bundleId } from './ghostty.js';

/** Inputs for {@link buildApp}. */
export interface BuildAppOptions {
  /** The `-b` box name (drives the default bundle id). */
  boxName: string;
  app: AppConfig;
  builder: AppBuilderConfig;
  /** Absolute path to the already-written Ghostty config to bake in. */
  configPath: string;
}

/** Result of a successful {@link buildApp}. */
export interface BuildAppResult {
  appPath: string;
  signed: 'identity' | 'adhoc';
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

function has(bin: string): boolean {
  try {
    execFileSync('command', ['-v', bin], { shell: '/bin/sh', stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** True when the host can build apps (macOS with the donor app + a C compiler). */
export function canBuildApps(builder: AppBuilderConfig): { ok: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not macOS' };
  if (!fs.existsSync(expandHome(builder.ghosttyApp))) {
    return { ok: false, reason: `Ghostty not found at ${builder.ghosttyApp}` };
  }
  if (!has('cc')) return { ok: false, reason: 'no C compiler (cc) — install Xcode CLT' };
  return { ok: true };
}

/** Extract the donor app's entitlements to a tmp file, or null if it has none. */
function extractEntitlements(ghosttyApp: string, tmpDir: string): string | null {
  let xml: string;
  try {
    xml = execFileSync('codesign', ['-d', '--entitlements', '-', '--xml', ghosttyApp], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
  const start = xml.indexOf('<?xml');
  if (start < 0) return null;
  const file = path.join(tmpDir, 'entitlements.xml');
  fs.writeFileSync(file, xml.slice(start));
  return file;
}

/** Name of the icon resource referenced by the bundle (default Ghostty.icns). */
function iconResourceName(plist: string): string {
  try {
    const name = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return name.endsWith('.icns') ? name : `${name}.icns`;
  } catch {
    return 'Ghostty.icns';
  }
}

/** Convert a PNG into a multi-resolution .icns at `out`. */
function pngToIcns(png: string, out: string, tmpDir: string): void {
  const iconset = path.join(tmpDir, 'icon.iconset');
  fs.mkdirSync(iconset, { recursive: true });
  for (const size of [16, 32, 128, 256, 512]) {
    run('sips', [
      '-z',
      `${size}`,
      `${size}`,
      png,
      '--out',
      path.join(iconset, `icon_${size}x${size}.png`),
    ]);
    const d = size * 2;
    run('sips', [
      '-z',
      `${d}`,
      `${d}`,
      png,
      '--out',
      path.join(iconset, `icon_${size}x${size}@2x.png`),
    ]);
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', out]);
}

/** Install the box icon into the cloned bundle, if `app.icon` is set. */
export function installIcon(app: AppConfig, appPath: string, tmpDir: string): void {
  if (!app.icon) return;
  const icon = expandHome(app.icon);
  if (!fs.existsSync(icon)) throw new Error(`icon not found: ${app.icon}`);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const dest = path.join(appPath, 'Contents', 'Resources', iconResourceName(plist));
  if (icon.endsWith('.icns')) fs.copyFileSync(icon, dest);
  else if (icon.endsWith('.png')) pngToIcns(icon, dest, tmpDir);
  else throw new Error(`unsupported icon type (need .icns/.png): ${app.icon}`);

  // Ghostty ships a compiled asset catalog (Assets.car) and a `CFBundleIconName`
  // pointing into it, which macOS prefers over the loose `CFBundleIconFile`
  // .icns we just replaced — so our icon would be ignored. Drop the asset-catalog
  // reference so macOS falls back to the .icns. (May be absent on other donors.)
  try {
    run('plutil', ['-remove', 'CFBundleIconName', plist]);
  } catch {
    // donor app may not define CFBundleIconName — ignore
  }
}

/**
 * Build the standalone Ghostty app for a box. Throws on any failure (the caller
 * decides whether to abort or carry on with the other boxes).
 */
export function buildApp(opts: BuildAppOptions): BuildAppResult {
  const { app, builder, boxName, configPath } = opts;
  const check = canBuildApps(builder);
  if (!check.ok) throw new Error(`cannot build app: ${check.reason}`);

  const ghosttyApp = expandHome(builder.ghosttyApp);
  const appsDir = expandHome(builder.appsDir);
  const appPath = appBundlePath(appsDir, app);
  const plist = path.join(appPath, 'Contents', 'Info.plist');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clabox-app-'));

  try {
    const entitlements = extractEntitlements(ghosttyApp, tmpDir);

    // Full clone (cp -R keeps bundle symlinks/frameworks intact).
    fs.mkdirSync(appsDir, { recursive: true });
    fs.rmSync(appPath, { recursive: true, force: true });
    run('cp', ['-R', ghosttyApp, appPath]);

    // Identity.
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId(boxName, app), plist]);
    run('plutil', ['-replace', 'CFBundleName', '-string', app.name, plist]);
    run('plutil', ['-replace', 'CFBundleDisplayName', '-string', app.name, plist]);
    run('plutil', ['-replace', 'CFBundleExecutable', '-string', 'ghostty', plist]);

    // Disable Sparkle auto-update (would clobber the clone).
    run('plutil', ['-replace', 'SUEnableAutomaticChecks', '-bool', 'NO', plist]);
    try {
      run('plutil', ['-replace', 'SUFeedURL', '-string', '', plist]);
    } catch {
      // donor app may not define SUFeedURL — ignore
    }

    // Swap the binary for a launcher that prepends --config-file.
    const bin = path.join(appPath, 'Contents', 'MacOS', 'ghostty');
    fs.renameSync(bin, `${bin}.real`);
    const src = path.join(tmpDir, 'launcher.c');
    fs.writeFileSync(src, buildLauncherSource(configPath));
    run('cc', ['-o', bin, src]);

    installIcon(app, appPath, tmpDir);

    // Re-sign: inner real binary first, then the whole bundle.
    const signId = builder.signId;
    const entArgs = entitlements ? ['--entitlements', entitlements] : [];
    const idArgs = signId ? ['--sign', signId] : ['--sign', '-'];
    run('codesign', ['--force', ...idArgs, ...entArgs, `${bin}.real`]);
    run('codesign', ['--force', '--deep', ...idArgs, ...entArgs, appPath]);

    return { appPath, signed: signId ? 'identity' : 'adhoc' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
