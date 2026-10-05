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
  profileFile: '/cfg-home/profiles/clabox-proj-abcd1234.sb',
  profileExists: false,
  configFile: null,
  configTrust: null,
  escapeHatches: [],
  configDir: '/cfg',
  network: true,
  ulimitProcs: 1024,
  procsRunning: 900,
  ulimitEffective: 1924,
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
  procTools: [],
};

describe('formatInfo', () => {
  test('renders the headline + every section header', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('clabox v9.9.9 — Run Claude Code in a sandbox');
    for (const h of ['[clabox]', '[box]', '[config]', '[extras]', '[env]']) {
      expect(out).toContain(h);
    }
  });

  test('reports the de-privileged tool copies the box runs instead of setuid ones', () => {
    expect(formatInfo(baseData)).toContain('procTools       (none)');
    expect(formatInfo({ ...baseData, procTools: ['ps: ready'] })).toContain(
      'procTools       ps: ready',
    );
  });

  test('shows version, the resolved self-path, claude bin, box=(none), profile marker', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('version         9.9.9');
    expect(out).toContain('claboxBin       /opt/clabox/lib/cli.js');
    expect(out).toContain('claboxRoot      /opt/clabox');
    expect(out).toContain('claudeBin       /usr/local/bin/claude');
    expect(out).toContain('box             (none)');
    // The launch passes the profile to `sandbox-exec -p` inline; the path is
    // only where `clabox generate` materializes a copy to read.
    expect(out).toContain('profile         inline at launch');
    expect(out).toContain('(not generated)');
  });

  // Each escape hatch hands work to a process that does NOT carry the profile,
  // so `info` has to say so out loud rather than leaving it to the paths tables.
  test('escape hatches are listed, and "(none)" is the default', () => {
    expect(formatInfo(baseData)).toContain('escapes         (none)');
    const out = formatInfo({
      ...baseData,
      escapeHatches: ['allowOpen (`open` starts processes outside the box)'],
    });
    expect(out).toContain('escapes         allowOpen');
  });

  test('the config-file row carries how it passed the trust gate', () => {
    const out = formatInfo({
      ...baseData,
      configFile: '/repo/boxes/x.mjs',
      configTrust: 'trusted',
    });
    expect(out).toContain('/repo/boxes/x.mjs (trust: trusted)');
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
    expect(out).toContain('write           -');
    expect(out).toContain('mcp             (none)');
  });

  // The report prints the three access classes under their canonical names, with
  // the legacy `readOnly`/`readWrite` aliases folded in — so a box that still
  // spells it the old way sees its grants under `read`/`write` all the same.
  test('path grants are reported as write / read / stat, aliases folded in', () => {
    const out = formatInfo({
      ...baseData,
      paths: { readWrite: ['~/w'], readOnly: ['~/ro'], read: ['~/r'], stat: ['~/s'] } as never,
    });
    expect(out).toContain('write           ~/w');
    expect(out).toContain('read            ~/ro');
    expect(out).toContain('                ~/r');
    expect(out).toContain('stat            ~/s');
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

describe('formatInfo — ulimit row', () => {
  test('shows the headroom, the effective cap and the running count', () => {
    const out = formatInfo(baseData);
    expect(out).toContain('ulimitProcs     1024 (headroom) → ulimit -u 1924, 900 procs running');
  });

  test('says no cap is set when the process count is unreadable', () => {
    const out = formatInfo({ ...baseData, procsRunning: null, ulimitEffective: null });
    expect(out).toContain('no cap set, process count unreadable');
  });

  test('(off) when the guard is disabled', () => {
    const out = formatInfo({ ...baseData, ulimitProcs: 0, ulimitEffective: null });
    expect(out).toContain('ulimitProcs     (off)');
  });
});
