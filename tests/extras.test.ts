// Tests for per-box "extras" — the declarative `mcp` / `systemPrompt` / `hooks`
// config compiled into claude args (+ the materialized MCP / settings json).
//
//   bun test

import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { boxSlug, buildBoxExtras } from '../src/sandbox/extras.js';
import {
  type Config,
  claboxMcpDir,
  claboxSettingsDir,
  defaultConfig,
} from '../src/utils/config.js';

/**
 * A config with a fixed (Claude) configDir + any overrides for the field under
 * test. The extras now materialize under clabox's own home (`~/.config/clabox`),
 * NOT this configDir — `/cfg` is kept to assert it no longer affects the paths.
 */
function cfg(over: Partial<Config>): Config {
  return { ...defaultConfig, configDir: '/cfg', ...over };
}

describe('boxSlug', () => {
  test('strips the .config.mjs box suffix', () => {
    expect(boxSlug('/x/configs/is-mg.config.mjs', '/proj')).toBe('is-mg');
  });
  test('strips a bare .mjs suffix', () => {
    expect(boxSlug('/x/configs/ax-root.mjs', '/proj')).toBe('ax-root');
  });
  test('falls back to the project dir basename when there is no config file', () => {
    expect(boxSlug(null, '/Users/me/projects/foo')).toBe('foo');
  });
});

describe('buildBoxExtras — MCP', () => {
  test('compiles mcp to <claboxHome>/mcp/<slug>.json and adds strict flags', () => {
    const servers = { 'is-mg': { type: 'http' as const, url: 'https://x/mcp' } };
    const { claudeArgs, files } = buildBoxExtras(cfg({ mcp: servers }), 'is-mg');

    const mcpFile = path.join(claboxMcpDir(), 'is-mg.json');
    expect(claudeArgs).toEqual(['--strict-mcp-config', '--mcp-config', mcpFile]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(mcpFile);
    expect(JSON.parse(files[0].content)).toEqual({ mcpServers: servers });
  });

  test('materializes under clabox home regardless of the Claude configDir', () => {
    const { files } = buildBoxExtras(
      cfg({ configDir: '~/.claude_x', mcp: { a: { url: 'u' } } }),
      'b',
    );
    // configDir is '~/.claude_x' but the file lands under ~/.config/clabox/mcp.
    expect(files[0].path).toBe(path.join(claboxMcpDir(), 'b.json'));
  });

  test('no mcp flags or files when mcp is absent or empty', () => {
    expect(buildBoxExtras(cfg({}), 's')).toEqual({ claudeArgs: [], files: [] });
    expect(buildBoxExtras(cfg({ mcp: {} }), 's')).toEqual({ claudeArgs: [], files: [] });
  });
});

describe('buildBoxExtras — systemPrompt', () => {
  test('appends a string prompt inline (no file)', () => {
    const { claudeArgs, files } = buildBoxExtras(cfg({ systemPrompt: 'be terse' }), 's');
    expect(claudeArgs).toEqual(['--append-system-prompt', 'be terse']);
    expect(files).toEqual([]);
  });

  test('joins a string[] prompt with blank lines', () => {
    const { claudeArgs } = buildBoxExtras(cfg({ systemPrompt: ['one', 'two'] }), 's');
    expect(claudeArgs).toEqual(['--append-system-prompt', 'one\n\ntwo']);
  });

  test('ignores a blank / whitespace-only prompt', () => {
    expect(buildBoxExtras(cfg({ systemPrompt: '   ' }), 's').claudeArgs).toEqual([]);
  });
});

describe('buildBoxExtras — hooks', () => {
  const stopHook = {
    Stop: [{ hooks: [{ type: 'command' as const, command: '/h/notify.sh' }] }],
  };

  test('compiles hooks to <claboxHome>/settings/<slug>.json and adds --settings', () => {
    // claudeArgs: [] → no inline --settings to merge, so the file is hooks-only.
    const { claudeArgs, files } = buildBoxExtras(cfg({ claudeArgs: [], hooks: stopHook }), 'is-mg');
    const settingsFile = path.join(claboxSettingsDir(), 'is-mg.json');
    expect(claudeArgs).toEqual(['--settings', settingsFile]);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe(settingsFile);
    expect(JSON.parse(files[0].content)).toEqual({ hooks: stopHook });
  });

  test('merges hooks into the inline --settings instead of clobbering it', () => {
    const claudeArgs = ['--settings', '{"includeCoAuthoredBy": false}', '--foo'];
    const { files } = buildBoxExtras(cfg({ claudeArgs, hooks: stopHook }), 'b');
    expect(JSON.parse(files[0].content)).toEqual({
      includeCoAuthoredBy: false,
      hooks: stopHook,
    });
  });

  test('no settings flag or file when hooks is absent or empty', () => {
    expect(buildBoxExtras(cfg({}), 's')).toEqual({ claudeArgs: [], files: [] });
    expect(buildBoxExtras(cfg({ hooks: {} }), 's')).toEqual({ claudeArgs: [], files: [] });
  });
});

describe('buildBoxExtras — combined', () => {
  test('emits MCP flags first, then the system prompt', () => {
    const { claudeArgs } = buildBoxExtras(
      cfg({ mcp: { a: { url: 'u' } }, systemPrompt: 'hi' }),
      'box',
    );
    expect(claudeArgs).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      path.join(claboxMcpDir(), 'box.json'),
      '--append-system-prompt',
      'hi',
    ]);
  });

  test('emits MCP, then system prompt, then --settings (hooks) last', () => {
    const hooks = { Stop: [{ hooks: [{ type: 'command' as const, command: '/h/n.sh' }] }] };
    const { claudeArgs } = buildBoxExtras(
      cfg({ mcp: { a: { url: 'u' } }, systemPrompt: 'hi', hooks }),
      'box',
    );
    expect(claudeArgs).toEqual([
      '--strict-mcp-config',
      '--mcp-config',
      path.join(claboxMcpDir(), 'box.json'),
      '--append-system-prompt',
      'hi',
      '--settings',
      path.join(claboxSettingsDir(), 'box.json'),
    ]);
  });
});
