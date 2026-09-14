// Per-box "extras": compile a box's declarative `mcp` / `systemPrompt` config
// into the claude args (and the files they reference) — so user config stays
// pure data and clabox owns the wiring. Pure builder; callers (run.ts at launch,
// scaffold.ts at `init`) do the actual fs writes.

import path from 'node:path';
import { type Config, claboxMcpDir, claboxSettingsDir } from '../utils/config.js';
import { buildNotifyHooks, mergeHooks } from './notify.js';

/** A file to materialize before launching claude (absolute path + content). */
export interface ExtraFile {
  path: string;
  content: string;
}

/** Compiled box extras: the claude args to inject + the files they reference. */
export interface BoxExtras {
  /** Appended after `config.claudeArgs`, before any CLI args. */
  claudeArgs: string[];
  /** Files to write (under clabox's home `~/.config/clabox`, granted RO in-box). */
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
 * Parse the inline JSON value of the last `--settings` already present in
 * `claudeArgs`, so a box's hooks can merge into it rather than clobber it: a
 * second `--settings` flag *replaces* the first (it does not deep-merge), so
 * emitting hooks in their own file would otherwise drop the existing
 * `includeCoAuthoredBy` setting. Returns `{}` when there's no `--settings` or
 * its value isn't inline JSON we can parse (e.g. a file path — extras is a pure
 * builder and can't read it; that case just loses the merge, not correctness).
 */
function readInlineSettings(claudeArgs: string[]): Record<string, unknown> {
  let raw: string | null = null;
  for (let i = 0; i < claudeArgs.length - 1; i++) {
    if (claudeArgs[i] === '--settings') raw = claudeArgs[i + 1];
  }
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * Compile `config.mcp` / `config.systemPrompt` / `config.hooks` into claude args.
 *
 * All materialized files live under clabox's own home (`~/.config/clabox`, via
 * {@link claboxMcpDir} / {@link claboxSettingsDir}) — NOT the Claude `configDir`,
 * so clabox never pollutes Claude's profile dir. The sandbox profile re-grants
 * READ to just those two subdirs (after its hard `.config` deny) so the box can
 * read them; clabox writes them before launch, so no in-box write is needed.
 *
 * - MCP: written to `<claboxHome>/mcp/<slug>.json` and loaded with
 *   `--mcp-config <file>`, preceded by `--strict-mcp-config` unless the box sets
 *   `strictMcp: false` (strict also hides the claude.ai cloud connectors).
 * - systemPrompt: appended inline via `--append-system-prompt` (no file —
 *   nothing to leave stale; `string[]` is joined with blank lines).
 * - hooks: `config.hooks` plus the compiled `config.notify` banners (see
 *   `sandbox/notify.ts`), merged into the inline `--settings` (see {@link readInlineSettings})
 *   and written to `<claboxHome>/settings/<slug>.json`, loaded with
 *   `--settings <file>` — which, emitted after `config.claudeArgs`, wins the
 *   last-`--settings`-takes-all race while carrying the merged result.
 */
export function buildBoxExtras(config: Config, slug: string): BoxExtras {
  const claudeArgs: string[] = [];
  const files: ExtraFile[] = [];

  const servers = config.mcp;
  if (servers && Object.keys(servers).length > 0) {
    const mcpFile = path.join(claboxMcpDir(), `${slug}.json`);
    files.push({
      path: mcpFile,
      content: `${JSON.stringify({ mcpServers: servers }, null, 2)}\n`,
    });
    // `--strict-mcp-config` means "only these servers" — and claude counts the
    // claude.ai cloud connectors (Linear, Slack, …) among the configurations it
    // then ignores, not just the configDir's own files. A box that wants its
    // server *alongside* them sets `strictMcp: false` and gets a plain
    // `--mcp-config`, which merges.
    if (config.strictMcp !== false) claudeArgs.push('--strict-mcp-config');
    claudeArgs.push('--mcp-config', mcpFile);
  }

  const sp = config.systemPrompt;
  const text = (Array.isArray(sp) ? sp.join('\n\n') : (sp ?? '')).trim();
  if (text) claudeArgs.push('--append-system-prompt', text);

  // The box's own hooks plus, when `config.notify.enabled`, the compiled
  // terminal-escape notifications — merged per event (concatenated), never
  // replacing each other: a box that already pings with `afplay` keeps doing so.
  const hooks = mergeHooks(config.hooks, buildNotifyHooks(config.notify, slug));
  if (hooks && Object.keys(hooks).length > 0) {
    const settingsFile = path.join(claboxSettingsDir(), `${slug}.json`);
    const merged = { ...readInlineSettings(config.claudeArgs), hooks };
    files.push({ path: settingsFile, content: `${JSON.stringify(merged, null, 2)}\n` });
    claudeArgs.push('--settings', settingsFile);
  }

  return { claudeArgs, files };
}
