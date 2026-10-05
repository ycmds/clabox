// I/O for the `clabox init` Ghostty-app builder (macOS-only).
//
// Clones Ghostty.app into `<appsDir>/<name>.app`, points it at the box's config
// through a private `XDG_CONFIG_HOME` in `LSEnvironment`, sets the icon,
// disables Sparkle, and re-signs. The donor's binary is kept as the bundle's
// executable — see init/ghostty.ts#ghosttyHomeDir for why swapping it for a
// launcher wrapper breaks the bundle's identity. The pure text builders live in
// init/ghostty.ts.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AppBuilderConfig, type AppConfig, expandHome } from '../utils/config.js';
import { appBundlePath, bundleId } from './ghostty.js';

/** Inputs for {@link buildApp}. */
export interface BuildAppOptions {
  /** The `-b` box name (drives the default bundle id). */
  boxName: string;
  app: AppConfig;
  builder: AppBuilderConfig;
  /**
   * Absolute path to the box's private XDG home (see
   * `init/ghostty.ts#ghosttyHomeDir`), injected as `XDG_CONFIG_HOME` so the
   * clone reads `<home>/ghostty/config` instead of the user's own.
   */
  xdgConfigHome: string;
}

/** Result of a successful {@link buildApp}. */
export interface BuildAppResult {
  appPath: string;
  signed: 'identity' | 'adhoc';
}

function run(cmd: string, args: string[]): void {
  execFileSync(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

/** True when the host can build apps (macOS with the donor app + a C compiler). */
export function canBuildApps(builder: AppBuilderConfig): { ok: boolean; reason?: string } {
  if (process.platform !== 'darwin') return { ok: false, reason: 'not macOS' };
  if (!fs.existsSync(expandHome(builder.ghosttyApp))) {
    return { ok: false, reason: `Ghostty not found at ${builder.ghosttyApp}` };
  }
  return { ok: true };
}

/**
 * The user's own macOS Ghostty config, which competes with the one we inject.
 *
 * Ghostty looks for its config in `$XDG_CONFIG_HOME/ghostty/config` and, on
 * macOS, in `~/Library/Application Support/com.mitchellh.ghostty/config` —
 * and the Application Support path is hard-coded to the upstream bundle id, so
 * a clone can't get its own. Returns the path when it exists and is non-empty,
 * else null; the caller turns that into a warning rather than a failure.
 */
export function conflictingUserConfig(): string | null {
  const p = expandHome('~/Library/Application Support/com.mitchellh.ghostty/config');
  try {
    return fs.statSync(p).size > 0 ? p : null;
  } catch {
    return null;
  }
}

/**
 * Run the donor Ghostty's own `+validate-config` over a generated config.
 *
 * Ghostty does **not** fail loudly on a bad key — it logs and carries on, so a
 * typo in `app.ghostty` (or a key that vanished in a Ghostty upgrade) shows up
 * as an app that silently ignores half its settings. Asking the real binary at
 * `init` time turns that into a warning while the user is still looking.
 *
 * Returns null when the config is fine **or** when validation isn't possible
 * (no donor app, no such subcommand) — this is a nicety, never a build blocker.
 */
export function validateGhosttyConfig(
  builder: AppBuilderConfig,
  configPath: string,
): string | null {
  const bin = path.join(expandHome(builder.ghosttyApp), 'Contents', 'MacOS', 'ghostty');
  if (!fs.existsSync(bin)) return null;
  try {
    execFileSync(bin, ['+validate-config', `--config-file=${configPath}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    });
    return null;
  } catch (e) {
    const err = e as { status?: number; stderr?: string; stdout?: string };
    // No `+validate-config` in this Ghostty → nothing to report.
    if (err.status === undefined) return null;
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`.trim();
    return text || `ghostty +validate-config exited ${err.status}`;
  }
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
  const { app, builder, boxName, xdgConfigHome } = opts;
  const check = canBuildApps(builder);
  if (!check.ok) throw new Error(`cannot build app: ${check.reason}`);

  const ghosttyApp = path.resolve(expandHome(builder.ghosttyApp));
  const appsDir = expandHome(builder.appsDir);
  // Throws unless `<name>.app` resolves to a direct child of appsDir — the path
  // below is `rm -rf`'d and then cloned onto, so a traversing `app.name` would
  // delete an arbitrary directory (`appBundlePath` has the details).
  const appPath = appBundlePath(appsDir, app);
  // …and never let the clone land on its own donor: `name: 'Ghostty'` with the
  // default `appsDir: '/Applications'` would otherwise delete Ghostty.app in
  // step one and copy from a path that no longer exists in step two.
  if (appPath === ghosttyApp) {
    throw new Error(`clabox: app.name '${app.name}' would overwrite the donor app (${ghosttyApp})`);
  }
  // Build into a staging clone next to the final bundle (same filesystem → the
  // final rename is atomic) and only swap it in once every step has succeeded.
  // A failed build (e.g. an unreadable donor) must never destroy an existing
  // working bundle — so we touch `appPath` only at the very end.
  const stagePath = `${appPath}.new`;
  const plist = path.join(stagePath, 'Contents', 'Info.plist');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clabox-app-'));

  try {
    const entitlements = extractEntitlements(ghosttyApp, tmpDir);

    // Full clone (cp -R keeps bundle symlinks/frameworks intact).
    fs.mkdirSync(appsDir, { recursive: true });
    fs.rmSync(stagePath, { recursive: true, force: true });
    run('cp', ['-R', ghosttyApp, stagePath]);

    // Identity.
    run('plutil', ['-replace', 'CFBundleIdentifier', '-string', bundleId(boxName, app), plist]);
    run('plutil', ['-replace', 'CFBundleName', '-string', app.name, plist]);
    run('plutil', ['-replace', 'CFBundleDisplayName', '-string', app.name, plist]);
    run('plutil', ['-replace', 'CFBundleExecutable', '-string', 'ghostty', plist]);

    // Point the clone at its own config without touching its executable: macOS
    // exports LSEnvironment into every app it launches through LaunchServices
    // (Dock, Finder, `open`, Raycast), and Ghostty reads
    // `$XDG_CONFIG_HOME/ghostty/config`. The generated `command` drops the var
    // again before the box starts — see ghostty.ts#resetXdgConfigHome.
    run('plutil', [
      '-replace',
      'LSEnvironment',
      '-json',
      JSON.stringify({ XDG_CONFIG_HOME: xdgConfigHome }),
      plist,
    ]);

    // Disable Sparkle auto-update (would clobber the clone).
    run('plutil', ['-replace', 'SUEnableAutomaticChecks', '-bool', 'NO', plist]);
    try {
      run('plutil', ['-replace', 'SUFeedURL', '-string', '', plist]);
    } catch {
      // donor app may not define SUFeedURL — ignore
    }

    installIcon(app, stagePath, tmpDir);

    // Re-sign the bundle as a whole, so its executable stays the sealed main
    // binary with the Info.plist bound into its signature — that binding is
    // what gives the clone a real identity for TCC and LaunchServices. (The
    // signature seals the bundle contents, not its directory name, so the
    // rename below keeps it valid.)
    const signId = builder.signId;
    const entArgs = entitlements ? ['--entitlements', entitlements] : [];
    const idArgs = signId ? ['--sign', signId] : ['--sign', '-'];
    run('codesign', ['--force', '--deep', ...idArgs, ...entArgs, stagePath]);

    // Everything succeeded — atomically replace the previous bundle.
    fs.rmSync(appPath, { recursive: true, force: true });
    fs.renameSync(stagePath, appPath);

    return { appPath, signed: signId ? 'identity' : 'adhoc' };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // Clean a leftover stage from a failed build (no-op after a successful swap).
    fs.rmSync(stagePath, { recursive: true, force: true });
  }
}
