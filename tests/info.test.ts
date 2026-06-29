// Tests for `clabox info` — the introspection report. `formatInfo` is pure
// (string in / string out); `gatherInfo` does light I/O (binary resolution +
// profile path) and is exercised against a fixed config.
//
//   bun test

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  claboxVersion,
  formatInfo,
  gatherInfo,
  type InfoData,
  resolveClaboxPackage,
} from '../src/info/info.js';
import { type Config, claboxMcpDir, defaultConfig } from '../src/utils/config.js';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '../..');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).version;

/** A config with a fixed configDir + cwd so info is deterministic in tests. */
function cfg(over: Partial<Config>): Config {
  return { ...defaultConfig, configDir: '/cfg', cwd: '/proj/box', ...over };
}

describe('resolveClaboxPackage', () => {
  test('walks up to clabox’s own package.json (root + version)', () => {
    const pkg = resolveClaboxPackage();
    expect(pkg.version).toBe(pkgVersion);
    expect(pkg.root).toBe(repoRoot);
  });

  test('claboxVersion is the same version', () => {
    expect(claboxVersion()).toBe(pkgVersion);
  });
});

describe('gatherInfo', () => {
  test('snapshots the static identity + resolved project/profile/slug', () => {
    const d = gatherInfo(cfg({}), { configFile: '/x/configs/ax-root.config.mjs', box: 'ax-root' });
    expect(d.name).toBe('clabox');
    expect(d.version).toBe(pkgVersion);
    expect(d.box).toBe('ax-root');
    expect(d.slug).toBe('ax-root'); // from the config-file basename
    expect(d.projectDir).toBe('/proj/box');
    expect(d.profileFile).toContain('clabox-box-'); // basename of projectDir + hash
    expect(d.configDir).toBe('/cfg');
    expect(d.configFile).toBe('/x/configs/ax-root.config.mjs');
    // self-location: resolved package root + running entry/runtime.
    expect(d.claboxRoot).toBe(repoRoot);
    expect(d.nodeBin).toBe(process.execPath);
    expect(d.claboxBin).toBe(process.argv[1] ?? null);
  });

  test('reflects per-box mcp / systemPrompt / hooks / env / paths', () => {
    const d = gatherInfo(
      cfg({
        network: false,
        mcp: { ctx7: { url: 'u' }, gh: { command: 'gh-mcp' } },
        systemPrompt: ['a', 'b'],
        hooks: { Stop: [{ hooks: [{ type: 'command', command: '/h.sh' }] }] },
        env: { GITHUB_TOKEN: 'xxx' },
        paths: { readWrite: ['~/w'], readOnly: [], exec: [], deny: ['~/s'] },
      }),
    );
    expect(d.network).toBe(false);
    expect(d.mcpServers).toEqual(['ctx7', 'gh']);
    expect(d.hasSystemPrompt).toBe(true);
    expect(d.hookEvents).toEqual(['Stop']);
    expect(d.env).toEqual(['GITHUB_TOKEN=xxx']);
    expect(d.paths.readWrite).toEqual(['~/w']);
    // extras: mcp adds the strict flags + file under ~/.config/clabox/mcp/<slug>.json
    expect(d.extraArgs).toContain('--strict-mcp-config');
    expect(d.extraFiles).toContain(path.join(claboxMcpDir(), 'box.json'));
  });

  test('hasSystemPrompt is false for a blank prompt', () => {
    expect(gatherInfo(cfg({ systemPrompt: '   ' })).hasSystemPrompt).toBe(false);
    expect(gatherInfo(cfg({})).hasSystemPrompt).toBe(false);
  });
});

/** Minimal InfoData with all-empty collections, for formatter tests. */
const baseData: InfoData = {
  name: 'clabox',
  version: '9.9.9',
  description: 'Run Claude Code in a sandbox for super-safe YOLO mode',
  node: 'v20.0.0',
  nodeBin: '/usr/bin/node',
  platform: 'darwin',
  claboxBin: '/opt/clabox/lib/cli.js',
  claboxRoot: '/opt/clabox',
  claudeBin: '/usr/local/bin/claude',
  sandboxExec: '/usr/bin/sandbox-exec',
  box: null,
  slug: 'proj',
  projectDir: '/proj',
  profileFile: '/tmp/clabox-proj-abcd1234.sb',
  profileExists: false,
  configFile: null,
  configDir: '/cfg',
  network: true,
  ulimitProcs: 1024,
  claudeArgs: ['--settings', '{"includeCoAuthoredBy": false}'],
  mcpServers: [],
  hasSystemPrompt: false,
  hookEvents: [],
  bot: { name: 'claudeBOT', email: 'bot@example.com', sshDir: '~/.ssh/claudebot' },
  paths: { readWrite: [], readOnly: [], exec: [], deny: [] },
  denyHome: ['Documents'],
  denyDotConfigs: ['aws'],
  env: [],
  extraArgs: [],
  extraFiles: [],
  processEnv: [],
};

describe('formatInfo', () => {
  test('renders the headline + every section header', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('clabox v9.9.9 — Run Claude Code in a sandbox');
    for (const h of ['[clabox]', '[box]', '[config]', '[extras]', '[env]']) {
      expect(out).toContain(h);
    }
  });

  test('shows version, the resolved self-path, claude bin, box=(none), not-built marker', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('version         9.9.9');
    expect(out).toContain('claboxBin       /opt/clabox/lib/cli.js');
    expect(out).toContain('claboxRoot      /opt/clabox');
    expect(out).toContain('claudeBin       /usr/local/bin/claude');
    expect(out).toContain('box             (none)');
    expect(out).toContain('(not built)');
  });

  test('marks missing binaries / unknown self-path instead of crashing', () => {
    const out = formatInfo({
      ...baseData,
      claboxBin: null,
      claboxRoot: null,
      claudeBin: null,
      sandboxExec: null,
    });
    expect(out).toContain('claboxBin       (unknown)');
    expect(out).toContain('claboxRoot      (unknown)');
    expect(out).toContain('claudeBin       not found');
    expect(out).toContain('sandbox-exec    not found (macOS only)');
  });

  test('empty list fields render as "-"', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('readWrite       -');
    expect(out).toContain('mcp             (none)');
  });

  test('collapses a multiline extra arg onto one line', () => {
    const out = formatInfo({
      ...baseData,
      extraArgs: ['--append-system-prompt', 'line one\n\nline two'],
    });
    expect(out).toContain('line one line two');
    expect(out).not.toContain('line one\n\nline two');
  });

  test('color: true wraps output in ANSI codes; default stays plain', () => {
    expect(formatInfo(baseData)).not.toContain('\x1b[');
    const colored = formatInfo(baseData, { color: true });
    expect(colored).toContain('\x1b[1m'); // bold section headers
    expect(colored).toContain('\x1b[36m'); // cyan labels
  });
});
