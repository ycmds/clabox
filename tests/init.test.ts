// Tests for `clabox init` — the shell-alias generator.
//
//   bun test
//
// Unit tests check the generated shell text; the scaffold test writes into a
// throwaway tmp dir and re-reads it. Nothing here runs claude or sandbox-exec.

import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { aliasName, buildAliasFiles, buildIndex, buildWrapper } from '../src/init/aliases.js';
import { installIcon } from '../src/init/app.js';
import {
  appBundlePath,
  buildCommand,
  buildGhosttyConfig,
  buildLauncherSource,
  bundleId,
} from '../src/init/ghostty.js';
import { buildRaycastCommand, raycastIcon } from '../src/init/raycast.js';
import { discoverProfiles, runInit } from '../src/init/scaffold.js';
import type { AppConfig } from '../src/utils/config.js';

const PATHS = { configsDir: '/repo/__/configs', scriptsDir: '/repo/__/scripts' };

describe('alias text generation', () => {
  test('command name is clabox-<name>', () => {
    expect(aliasName('ax')).toBe('clabox-ax');
    expect(aliasName('ax-safe')).toBe('clabox-ax-safe');
  });

  test('index defines one function per box, run via -b (no yolo flag here)', () => {
    const idx = buildIndex(['ax', 'ax-safe'], PATHS);
    expect(idx).toMatch(/^#!\/usr\/bin\/env bash$/m);
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell, not a JS template
    expect(idx).toContain('CLABOX_CONFIGS_DIR="/repo/__/configs" clabox -b "$1" "${@:2}"');
    expect(idx).toContain('clabox-ax() { _clabox_run ax "$@"; }');
    expect(idx).toContain('clabox-ax-safe() { _clabox_run ax-safe "$@"; }');
    // yolo/safe is decided by the box preset, not the alias.
    expect(idx).not.toContain('--dangerously-skip-permissions');
  });

  test('index omits CLABOX_CONFIGS_DIR when the dir is the runtime default (null)', () => {
    const idx = buildIndex(['ax'], { configsDir: null, scriptsDir: '/repo/__/scripts' });
    expect(idx).not.toContain('CLABOX_CONFIGS_DIR');
    // biome-ignore lint/suspicious/noTemplateCurlyInString: literal shell, not a JS template
    expect(idx).toContain('clabox -b "$1" "${@:2}"');
  });

  test('wrapper sources index.sh and calls its function', () => {
    const w = buildWrapper('clabox-ax', '/repo/__/scripts/index.sh');
    expect(w).toContain('source "/repo/__/scripts/index.sh"');
    expect(w).toContain('clabox-ax "$@"');
  });

  test('buildAliasFiles emits index.sh + one wrapper per box', () => {
    const files = buildAliasFiles(['ax', 'ax-safe'], PATHS);
    const names = files.map((f) => path.basename(f.path)).sort();
    expect(names).toEqual(['clabox-ax-safe.sh', 'clabox-ax.sh', 'index.sh']);
    expect(files.every((f) => f.executable)).toBe(true);
  });
});

describe('scaffold (real fs in a tmp dir)', () => {
  test('discoverProfiles reads sorted box names (.mjs + .config.mjs, skips _partials)', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    const configs = path.join(base, 'configs');
    fs.mkdirSync(configs);
    fs.writeFileSync(path.join(configs, 'b.mjs'), 'export default {}');
    fs.writeFileSync(path.join(configs, 'a.config.mjs'), 'export default {}');
    fs.writeFileSync(path.join(configs, '_presets.mjs'), 'export default {}');
    fs.writeFileSync(path.join(configs, 'README.md'), 'ignore me');
    try {
      expect(discoverProfiles(configs)).toEqual(['a', 'b']);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('discoverProfiles throws on a missing or empty configs dir', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    fs.mkdirSync(path.join(base, 'configs'));
    try {
      expect(() => discoverProfiles(path.join(base, 'nope'))).toThrow(/not found/);
      expect(() => discoverProfiles(path.join(base, 'configs'))).toThrow(/no box configs/);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('runInit writes index.sh + wrappers and prunes stale ones', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    const configs = path.join(base, 'configs');
    const scripts = path.join(base, 'scripts');
    fs.mkdirSync(configs);
    fs.writeFileSync(path.join(configs, 'ax.mjs'), 'export default {}');
    fs.writeFileSync(path.join(configs, 'is.config.mjs'), 'export default {}');
    // a stale generated wrapper from a since-removed box must be pruned
    fs.mkdirSync(scripts);
    fs.writeFileSync(path.join(scripts, 'clabox-gone.sh'), '# old');
    try {
      const res = await runInit({ baseDir: base });
      expect(res.profiles).toEqual(['ax', 'is']);
      expect(fs.existsSync(path.join(scripts, 'index.sh'))).toBe(true);
      expect(fs.existsSync(path.join(scripts, 'clabox-ax.sh'))).toBe(true);
      expect(fs.existsSync(path.join(scripts, 'clabox-is.sh'))).toBe(true);
      expect(fs.existsSync(path.join(scripts, 'clabox-gone.sh'))).toBe(false);
      // generated files are executable
      expect(fs.statSync(path.join(scripts, 'index.sh')).mode & 0o111).not.toBe(0);
      // no `app` boxes → nothing built, no ghostty/raycast dirs
      expect(res.apps).toEqual([]);
      expect(res.ghosttyConfigs).toEqual([]);
      expect(res.raycastCommands).toEqual([]);
      expect(fs.existsSync(path.join(base, 'ghostty'))).toBe(false);
      expect(fs.existsSync(path.join(base, 'raycast'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('an `app` box gets a Ghostty config; build is skipped when Ghostty is absent', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    const configs = path.join(base, 'configs');
    fs.mkdirSync(configs);
    // app box: point the builder at a missing Ghostty so no real .app is built
    fs.writeFileSync(
      path.join(configs, 'mgr.mjs'),
      `export default {
        cwd: '/tmp/proj',
        app: { name: 'Test Mgr', title: 'T', ghostty: { background: '#000000' } },
        appBuilder: { ghosttyApp: '/no/such/Ghostty.app', appsDir: '/tmp/apps', claboxBin: '/usr/bin/clabox' },
      }`,
    );
    fs.writeFileSync(path.join(configs, 'plain.mjs'), 'export default {}');
    try {
      const res = await runInit({ baseDir: base });
      expect(res.profiles).toEqual(['mgr', 'plain']);
      const cfg = path.join(base, 'ghostty', 'mgr.config');
      expect(fs.existsSync(cfg)).toBe(true);
      const txt = fs.readFileSync(cfg, 'utf8');
      expect(txt).toContain('title = "T"');
      expect(txt).toContain('background = #000000');
      expect(txt).toContain('cd /tmp/proj && ');
      expect(txt).toContain(`CLABOX_CONFIGS_DIR=${configs} /usr/bin/clabox -b mgr`);
      // plain box has no app → no ghostty config
      expect(fs.existsSync(path.join(base, 'ghostty', 'plain.config'))).toBe(false);
      // a Raycast command that opens the (to-be) built app is written too
      const ray = path.join(base, 'raycast', 'mgr.sh');
      expect(fs.existsSync(ray)).toBe(true);
      expect(res.raycastCommands).toEqual([ray]);
      const rayTxt = fs.readFileSync(ray, 'utf8');
      expect(rayTxt).toContain('# @raycast.title T');
      expect(rayTxt).toContain("open '/tmp/apps/Test Mgr.app'");
      expect(fs.existsSync(path.join(base, 'raycast', 'plain.sh'))).toBe(false);
      // build skipped (Ghostty absent / not macOS) → warning, nothing built
      expect(res.apps).toEqual([]);
      expect(res.warnings.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('an app box without claboxBin bakes a bare `clabox` (PATH-resolved at launch)', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    const configs = path.join(base, 'configs');
    fs.mkdirSync(configs);
    fs.writeFileSync(
      path.join(configs, 'mgr.mjs'),
      `export default {
        cwd: '/tmp/proj',
        app: { name: 'Test Mgr' },
        appBuilder: { ghosttyApp: '/no/such/Ghostty.app', appsDir: '/tmp/apps' },
      }`,
    );
    try {
      await runInit({ baseDir: base });
      const txt = fs.readFileSync(path.join(base, 'ghostty', 'mgr.config'), 'utf8');
      // bare `clabox`, not an absolute path — survives package-manager moves.
      expect(txt).toContain(`CLABOX_CONFIGS_DIR=${configs} clabox -b mgr`);
      expect(txt).not.toContain('.bun/bin/clabox');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test('--no-apps (buildApps:false) skips all Ghostty artifacts', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-init-'));
    const configs = path.join(base, 'configs');
    fs.mkdirSync(configs);
    fs.writeFileSync(
      path.join(configs, 'mgr.mjs'),
      `export default { app: { name: 'Test Mgr' }, appBuilder: { ghosttyApp: '/no/such/Ghostty.app' } }`,
    );
    try {
      const res = await runInit({ baseDir: base, buildApps: false });
      expect(res.ghosttyConfigs).toEqual([]);
      expect(res.raycastCommands).toEqual([]);
      expect(res.apps).toEqual([]);
      expect(fs.existsSync(path.join(base, 'ghostty'))).toBe(false);
      expect(fs.existsSync(path.join(base, 'raycast'))).toBe(false);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('ghostty config + launcher generation', () => {
  const app: AppConfig = {
    name: 'AX Manager',
    title: '🐈‍⬛ AX Manager',
    macosIcon: 'retro',
    ghostty: { background: '#0d1117', 'background-opacity': '0.92' },
  };
  const opts = {
    app,
    boxName: 'ax-mg',
    projectDir: '/Users/me/projects/ax-mg',
    configsDir: '/Users/me/.config/clabox/configs',
    claboxBin: '/Users/me/.bun/bin/clabox',
  };

  test('buildCommand cds into the project and runs clabox -b <box>', () => {
    expect(buildCommand(opts)).toBe(
      "command = zsh -lic 'cd /Users/me/projects/ax-mg && " +
        "CLABOX_CONFIGS_DIR=/Users/me/.config/clabox/configs /Users/me/.bun/bin/clabox -b ax-mg; exec zsh'",
    );
  });

  test('buildCommand without a projectDir omits the cd', () => {
    const cmd = buildCommand({ ...opts, projectDir: null });
    expect(cmd).not.toContain('cd ');
    expect(cmd).toContain('-b ax-mg');
  });

  test('buildCommand omits CLABOX_CONFIGS_DIR when configsDir is null', () => {
    const cmd = buildCommand({ ...opts, configsDir: null });
    expect(cmd).not.toContain('CLABOX_CONFIGS_DIR');
    expect(cmd).toBe(
      "command = zsh -lic 'cd /Users/me/projects/ax-mg && " +
        "/Users/me/.bun/bin/clabox -b ax-mg; exec zsh'",
    );
  });

  test('buildCommand uses a bare `clabox` (PATH-resolved) when given one', () => {
    const cmd = buildCommand({ ...opts, configsDir: null, claboxBin: 'clabox' });
    expect(cmd).toBe(
      "command = zsh -lic 'cd /Users/me/projects/ax-mg && clabox -b ax-mg; exec zsh'",
    );
  });

  test('buildGhosttyConfig emits title, macos-icon, extra lines and the command', () => {
    const txt = buildGhosttyConfig(opts);
    expect(txt).toContain('title = "🐈‍⬛ AX Manager"');
    expect(txt).toContain('macos-icon = retro');
    expect(txt).toContain('background = #0d1117');
    expect(txt).toContain('background-opacity = 0.92');
    expect(txt).toContain('-b ax-mg');
    expect(txt).not.toContain('config-file =');
  });

  test('buildGhosttyConfig prepends config-file when a base config is given', () => {
    const txt = buildGhosttyConfig({ ...opts, baseGhosttyConfig: '/Users/me/bash/ghostty/config' });
    expect(txt).toContain('config-file = /Users/me/bash/ghostty/config');
  });

  test('buildLauncherSource bakes the config path and execs ghostty.real', () => {
    const src = buildLauncherSource('/Users/me/x/ax-mg.config');
    expect(src).toContain('static const char *CONFIG_PATH = "/Users/me/x/ax-mg.config";');
    expect(src).toContain('ghostty.real');
    expect(src).toContain('--config-file=%s');
    expect(src).toContain('execv(real_path, new_argv);');
  });

  test('buildLauncherSource C-escapes quotes and backslashes in the path', () => {
    const src = buildLauncherSource('/a/"weird"\\path.config');
    expect(src).toContain('"/a/\\"weird\\"\\\\path.config"');
  });

  test('appBundlePath / bundleId derive sane defaults and honor overrides', () => {
    expect(appBundlePath('/Users/me/Applications', app)).toBe(
      '/Users/me/Applications/AX Manager.app',
    );
    expect(bundleId('ax-mg', app)).toBe('com.ghostty.custom.ax.mg');
    expect(bundleId('ax-mg', { ...app, bundleId: 'com.me.ax' })).toBe('com.me.ax');
  });
});

describe('installIcon (real plutil, macOS only)', () => {
  const isMac = process.platform === 'darwin';

  // Ghostty ships both CFBundleIconName (→ Assets.car) and the loose
  // CFBundleIconFile; macOS prefers the asset-catalog name, so installing the
  // .icns is not enough — the name must be removed for our icon to win.
  test.skipIf(!isMac)('replaces the loose .icns and drops CFBundleIconName', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-icon-'));
    try {
      const appPath = path.join(base, 'Test.app');
      const resources = path.join(appPath, 'Contents', 'Resources');
      fs.mkdirSync(resources, { recursive: true });
      const plist = path.join(appPath, 'Contents', 'Info.plist');
      fs.writeFileSync(
        plist,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIconFile</key><string>Ghostty</string>
<key>CFBundleIconName</key><string>Ghostty</string>
</dict></plist>`,
      );
      // an old icns that installIcon must overwrite (named per CFBundleIconFile)
      const icns = path.join(resources, 'Ghostty.icns');
      fs.writeFileSync(icns, 'OLD');
      const src = path.join(base, 'mine.icns');
      fs.writeFileSync(src, 'NEWICON');

      installIcon({ name: 'Test', icon: src }, appPath, base);

      expect(fs.readFileSync(icns, 'utf8')).toBe('NEWICON');
      // CFBundleIconName gone → plutil -extract now fails
      expect(() =>
        execFileSync('plutil', ['-extract', 'CFBundleIconName', 'raw', plist], { stdio: 'ignore' }),
      ).toThrow();
      // the loose CFBundleIconFile is left intact
      const iconFile = execFileSync('plutil', ['-extract', 'CFBundleIconFile', 'raw', plist], {
        encoding: 'utf8',
      }).trim();
      expect(iconFile).toBe('Ghostty');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('raycast command generation', () => {
  const app: AppConfig = { name: 'AX Manager', title: '🐈‍⬛ AX Manager' };

  test('raycastIcon: explicit emoji wins, else the title emoji, else 👻', () => {
    expect(raycastIcon({ ...app, emoji: '🚀' })).toBe('🚀');
    expect(raycastIcon(app)).toBe('🐈‍⬛');
    expect(raycastIcon({ name: 'Plain', title: 'Plain App' })).toBe('👻');
    expect(raycastIcon({ name: 'NoTitle' })).toBe('👻');
  });

  test('buildRaycastCommand emits @raycast metadata and opens the app (quoted)', () => {
    const txt = buildRaycastCommand({ app, appPath: '/Users/me/apps/AX Manager.app' });
    expect(txt).toMatch(/^#!\/bin\/bash$/m);
    expect(txt).toContain('# @raycast.schemaVersion 1');
    expect(txt).toContain('# @raycast.title 🐈‍⬛ AX Manager');
    expect(txt).toContain('# @raycast.mode silent');
    expect(txt).toContain('# @raycast.icon 🐈‍⬛');
    expect(txt).toContain("open '/Users/me/apps/AX Manager.app'");
  });
});
