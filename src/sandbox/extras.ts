// Per-box "extras": compile a box's declarative `mcp` / `systemPrompt` config
// into the claude args (and the files they reference) — so user config stays
// pure data and clabox owns the wiring. Pure builder; callers (run.ts at launch,
// scaffold.ts at `init`) do the actual fs writes.

import path from 'node:path';
import { type Config, expandHome } from '../utils/config.js';

/** A file to materialize before launching claude (absolute path + content). */
export interface ExtraFile {
  path: string;
  content: string;
}

/** Compiled box extras: the claude args to inject + the files they reference. */
export interface BoxExtras {
  /** Appended after `config.claudeArgs`, before any CLI args. */
  claudeArgs: string[];
  /** Files to write (under configDir, which the sandbox grants RW). */
  files: ExtraFile[];
}

/**
 * Stable per-box slug used to name the materialized files. Prefers the config
 * file's basename (so `-b is-mg` → `is-mg`, matching `init`'s box name), else
 * falls back to the project dir's basename.
 */
export function boxSlug(configFile: string | null | undefined, projectDir: string): string {
  if (configFile) {
    return path.basename(configFile).replace(/\.(config\.)?(mjs|cjs|js)$/, '');
  }
  return path.basename(projectDir);
}

/**
 * Compile `config.mcp` / `config.systemPrompt` into claude args.
 *
 * - MCP: written to `<configDir>/mcp/<slug>.json` and loaded with
 *   `--strict-mcp-config --mcp-config <file>` (global/plugin servers ignored).
 *   configDir is sandbox-RW, so the json is readable inside the box.
 * - systemPrompt: appended inline via `--append-system-prompt` (no file —
 *   nothing to leave stale; `string[]` is joined with blank lines).
 */
export function buildBoxExtras(config: Config, slug: string): BoxExtras {
  const configDir = expandHome(config.configDir);
  const claudeArgs: string[] = [];
  const files: ExtraFile[] = [];

  const servers = config.mcp;
  if (servers && Object.keys(servers).length > 0) {
    const mcpFile = path.join(configDir, 'mcp', `${slug}.json`);
    files.push({
      path: mcpFile,
      content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    });
    claudeArgs.push('--strict-mcp-config', '--mcp-config', mcpFile);
  }

  const sp = config.systemPrompt;
  const text = (Array.isArray(sp) ? sp.join('\n\n') : (sp ?? '')).trim();
  if (text) claudeArgs.push('--append-system-prompt', text);

  return { claudeArgs, files };
}
