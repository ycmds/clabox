// Configuration: sane defaults, env overrides, and an optional JS config file.
//
// Resolution order (later wins):
//   1. defaultConfig (below)
//   2. env vars (CLAUDE_CONFIG_DIR, CLABOX_*, …)
//   3. a JS config file (see loadConfig)
//
// A config file default-exports either a plain object (merged over the defaults)
// or a function `(defaults) => config` for full programmatic control.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const HOME = os.homedir();

/** Expand a leading `~` / `~/` to the user's home directory. */
export function expandHome(p: string): string {
  if (!p) return p;
  if (p === '~') return HOME;
  if (p.startsWith('~/')) return path.join(HOME, p.slice(2));
  return p;
}

const env = process.env;

/** Dedicated git/ssh identity for commits made from inside the sandbox. */
export interface BotConfig {
  name: string;
  email: string;
  /** If `${sshDir}/id_ed25519` exists, git ssh is pinned to it. */
  sshDir: string;
}

/**
 * Opt-in marker that turns a box into a standalone Ghostty app. When a box
 * config carries an `app`, `clabox init` generates a Ghostty config for it and
 * builds a cloned `<appsDir>/<name>.app` that launches `clabox -b <box>`.
 */
export interface AppConfig {
  /** App display name → `<appsDir>/<name>.app` + CFBundleName. */
  name: string;
  /** Ghostty window title. Defaults to {@link AppConfig.name}. */
  title?: string;
  /** Emoji for the generated Raycast command. Default: the title's leading emoji. */
  emoji?: string;
  /** Path to a `.icns`/`.png` icon for the .app. `.png` is converted. `~` ok. */
  icon?: string;
  /** Ghostty built-in `macos-icon` (e.g. `retro`, `holographic`). */
  macosIcon?: string;
  /** Extra raw `key = value` lines appended to the generated Ghostty config. */
  ghostty?: Record<string, string>;
  /** Bundle id. Default: `com.ghostty.custom.<name dot-joined>`. */
  bundleId?: string;
}

/** Machine-wide settings for the `clabox init` Ghostty-app builder. */
export interface AppBuilderConfig {
  /** Donor app to clone. `~` is expanded. */
  ghosttyApp: string;
  /** Where built apps land. `~` is expanded. */
  appsDir: string;
  /** codesign identity. null → ad-hoc (`codesign -s -`). */
  signId: string | null;
  /** Optional base Ghostty config emitted as a leading `config-file = …`. */
  baseGhosttyConfig: string | null;
  /** Absolute `clabox` path to pin in the generated `command`. null → bare `clabox` (PATH-resolved at launch). */
  claboxBin: string | null;
}

/**
 * A single MCP server entry — the value under a key in claude's `mcpServers`
 * map. Loose on purpose (mirrors claude's mcp.json schema): `stdio` servers use
 * `command`/`args`/`env`, remote `http`/`sse` servers use `url`/`headers`.
 */
export interface McpServer {
  type?: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** A single hook command — one entry in claude's settings.json hook list. */
export interface HookCommand {
  type: 'command';
  /** Shell command to run (e.g. an absolute path to a script). */
  command: string;
  /** Optional per-command timeout in seconds. */
  timeout?: number;
}

/** A matcher group under a hook event. */
export interface HookMatcher {
  /** Tool-name matcher for `PreToolUse`/`PostToolUse`; omit for `Stop`/`Notification`/… */
  matcher?: string;
  hooks: HookCommand[];
}

/**
 * Per-box hooks, mirroring claude's settings.json `hooks` map: an event name
 * (`Stop`, `Notification`, `PreToolUse`, …) → its matcher groups.
 */
export type HooksConfig = Record<string, HookMatcher[]>;

/** Extra rules layered on top of the built-in base profile. */
export interface PathRules {
  /** RW subpaths (beyond project dir + configDir + /tmp). */
  readWrite: string[];
  /** RO subpaths. */
  readOnly: string[];
  /** process-exec subpaths (e.g. a hook-scripts dir so `config.hooks` can run). */
  exec: string[];
  /** explicit deny subpaths (read + write). */
  deny: string[];
}

/** Effective clabox configuration. */
export interface Config {
  /**
   * Working directory to run `claude` in (and grant RW as the project dir).
   * null → the shell's CWD. Handy for named boxes that always target one
   * project regardless of where `clabox` is invoked from. `~` is expanded.
   */
  cwd: string | null;
  /** Path to the `claude` binary. null → autodetect (PATH, then ~/.local/bin). */
  claudeBin: string | null;
  /** Claude config/profile directory — supports multiple accounts. */
  configDir: string;
  /** Extra args always passed to `claude`, before any args from the CLI. */
  claudeArgs: string[];
  /**
   * Per-box MCP servers (the `mcpServers` map). clabox compiles them to
   * `<claboxHome>/mcp/<slug>.json` (i.e. `~/.config/clabox/mcp/…`, NOT the
   * Claude configDir) and launches claude with
   * `--strict-mcp-config --mcp-config <file>`, so a shared configDir's global /
   * plugin MCP servers are ignored — each box gets exactly these and no more.
   * Materialized on every `run` and during `init`. Absent → no MCP flags.
   */
  mcp?: Record<string, McpServer>;
  /**
   * Text appended to claude's system prompt via `--append-system-prompt`.
   * `string[]` is joined with blank lines. Use it for per-box pre-prompts while
   * sharing one configDir (the user-level CLAUDE.md is shared; this is not).
   */
  systemPrompt?: string | string[];
  /**
   * Per-box hooks (claude's settings.json `hooks` map). clabox merges them into
   * a settings JSON written to `<claboxHome>/settings/<slug>.json` (i.e.
   * `~/.config/clabox/settings/…`, NOT the Claude configDir) and launches
   * claude with `--settings <file>` — merging (not clobbering) any inline
   * `--settings` already in `claudeArgs`, so `includeCoAuthoredBy` survives.
   * Materialized on every `run` and during `init`. Absent → no settings flag.
   */
  hooks?: HooksConfig;
  bot: BotConfig;
  /**
   * Extra environment variables forced onto the sandboxed `claude` process,
   * layered over the inherited shell env and after the built-in hardening vars
   * (so a key set here wins). Use it to pass secrets like `GITHUB_TOKEN`.
   */
  env: Record<string, string>;
  /** Allow outbound network. `false` → no `(allow network*)` line. */
  network: boolean;
  /** Cap the process table inside the sandbox (fork-bomb guard). 0 → skip. */
  ulimitProcs: number;
  paths: PathRules;
  /** Home subdirectories denied entirely (read + write). */
  denyHome: string[];
  /** Dotfile config dirs under $HOME denied entirely. */
  denyDotConfigs: string[];
  /**
   * Opt-in: build a standalone Ghostty app for this box during `clabox init`.
   * Absent → the box only gets a shell alias (the default).
   */
  app?: AppConfig;
  /** Machine-wide settings for the `clabox init` Ghostty-app builder. */
  appBuilder: AppBuilderConfig;
}

/** Built-in defaults. Everything here is meant to be overridable. */
export const defaultConfig: Config = {
  cwd: env.CLABOX_CWD ?? null,
  claudeBin: env.CLABOX_CLAUDE_BIN ?? null,
  configDir: env.CLAUDE_CONFIG_DIR ?? '~/.claude',
  claudeArgs: ['--settings', '{"includeCoAuthoredBy": false}'],
  bot: {
    name: env.CLABOX_BOT_NAME ?? 'claudeBOT',
    email: env.CLABOX_BOT_EMAIL ?? 'bot@example.com',
    sshDir: env.CLABOX_BOT_SSH_DIR ?? '~/.ssh/claudebot',
  },
  env: {},
  network: true,
  ulimitProcs: 1024,
  paths: {
    readWrite: [],
    readOnly: [],
    exec: [],
    deny: [],
  },
  denyHome: ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'],
  // `.config/git` is always carved back out for git RO config in the profile.
  denyDotConfigs: ['aws', 'gnupg', 'kube', 'docker', 'config'],
  // `app` is opt-in per box, so there's no default — it stays undefined.
  appBuilder: {
    ghosttyApp: env.CLABOX_GHOSTTY_APP ?? '/Applications/Ghostty.app',
    appsDir: env.CLABOX_APPS_DIR ?? '~/Applications',
    signId: env.CLABOX_SIGN_ID ?? null,
    baseGhosttyConfig: env.CLABOX_GHOSTTY_BASE_CONFIG ?? null,
    claboxBin: env.CLABOX_CLABOX_BIN ?? null,
  },
};

type Plain = Record<string, unknown>;

function isPlainObject(v: unknown): v is Plain {
  return v != null && typeof v === 'object' && !Array.isArray(v);
}

/** Shallow-deep merge: nested plain objects merge, everything else replaces. */
function deepMerge(base: Plain, override: Plain): Plain {
  const out: Plain = { ...base };
  for (const [key, val] of Object.entries(override)) {
    if (val === undefined) continue;
    const baseVal = base[key];
    out[key] = isPlainObject(val) && isPlainObject(baseVal) ? deepMerge(baseVal, val) : val;
  }
  return out;
}

/** Merge a (partial) override over a full config, returning a new config. */
export function mergeConfig(base: Config, override: unknown): Config {
  if (!isPlainObject(override)) return base;
  return deepMerge(base as unknown as Plain, override) as unknown as Config;
}

/**
 * Append extra path grants (e.g. from the `--ro`/`--rw` CLI flags) onto a
 * config's `paths`. Unlike a config-file merge — where arrays *replace* — these
 * are **additive**: they concatenate onto `config.paths.readOnly`/`readWrite`,
 * so an ad-hoc CLI grant never wipes out a box's own paths. Returns the same
 * config unchanged when nothing extra is supplied.
 */
export function withExtraPaths(
  config: Config,
  extra: { readOnly?: string[]; readWrite?: string[] } = {},
): Config {
  const readOnly = extra.readOnly ?? [];
  const readWrite = extra.readWrite ?? [];
  if (!readOnly.length && !readWrite.length) return config;
  return {
    ...config,
    paths: {
      ...config.paths,
      readOnly: [...config.paths.readOnly, ...readOnly],
      readWrite: [...config.paths.readWrite, ...readWrite],
    },
  };
}

/**
 * Locate a config file: explicit (CLI arg, then `CLABOX_CONFIG` env),
 * then CWD, then ~/.config. The CLI arg wins over the env var.
 */
export function findConfigFile(explicit?: string | null): string | null {
  const chosen = explicit ?? env.CLABOX_CONFIG;
  if (chosen) return expandHome(chosen);
  const candidates = [
    path.join(process.cwd(), 'clabox.config.mjs'),
    path.join(process.cwd(), 'clabox.config.js'),
    path.join(HOME, '.config', 'clabox', 'config.mjs'),
  ];
  return candidates.find((c) => fs.existsSync(c)) ?? null;
}

/**
 * Global directory holding named "box" configs (`<name>.config.mjs`), used by
 * the `clabox --box <name>` / `-b` flag. Override with `CLABOX_CONFIGS_DIR`.
 */
export function configsDir(): string {
  return expandHome(env.CLABOX_CONFIGS_DIR ?? '~/.config/clabox/configs');
}

/**
 * Clabox's own home dir — the parent of {@link configsDir} (default
 * `~/.config/clabox`, honoring `CLABOX_CONFIGS_DIR`). Holds clabox-owned
 * generated artifacts (`scripts/`, `ghostty/`, `apps/`) and the per-box extras
 * compiled by `buildBoxExtras` (`mcp/`, `settings/`). Deliberately kept OUT of
 * Claude's `configDir` so clabox never pollutes Claude's own profile dir.
 */
export function claboxHomeDir(): string {
  return path.dirname(configsDir());
}

/** `<claboxHome>/mcp` — per-box compiled `--mcp-config` json lives here. */
export function claboxMcpDir(): string {
  return path.join(claboxHomeDir(), 'mcp');
}

/** `<claboxHome>/settings` — per-box compiled `--settings` (hooks) json lives here. */
export function claboxSettingsDir(): string {
  return path.join(claboxHomeDir(), 'settings');
}

const BOX_SUFFIXES = ['.config.mjs', '.mjs'];

/** Candidate file paths for a box name, in resolution order. */
function boxCandidates(name: string, dir: string): string[] {
  return BOX_SUFFIXES.map((s) => path.join(dir, `${name}${s}`));
}

/** True if `p` exists and is a regular file (not a directory). */
function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/** Named box configs (sorted, de-duplicated) available in {@link configsDir}. */
export function listBoxes(dir: string = configsDir()): string[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const names = new Set<string>();
  for (const f of entries) {
    // `_`-prefixed files are shared partials (e.g. `_presets.mjs`), not boxes.
    if (f.startsWith('_')) continue;
    const suffix = BOX_SUFFIXES.find((s) => f.endsWith(s));
    if (suffix) names.add(f.slice(0, -suffix.length));
  }
  return [...names].sort();
}

/**
 * Resolve a `-b`/`--box` ref to its config file. Three forms:
 *
 *  - `<name>` — a named box in {@link configsDir} (or `dir`), preferring
 *    `<name>.config.mjs` over a bare `<name>.mjs`;
 *  - `path/to/<name>` — the same name lookup, but inside that directory
 *    (`~`-expanded, relative to the CWD), so a repo can carry its own boxes;
 *  - `path/to/file.mjs` — an explicit config file, used as-is.
 *
 * @throws if no matching file exists (the message lists the available boxes).
 */
export function resolveBox(ref: string, dir: string = configsDir()): string {
  const expanded = expandHome(ref);
  // Explicit file path: `-b path/vibe.mjs` (covers `.config.mjs` too).
  if (expanded.endsWith('.mjs')) {
    const file = path.resolve(expanded);
    if (isFile(file)) return file;
    throw new Error(`clabox: box config '${ref}' not found (${file})`);
  }
  // Directory-qualified name: `-b path/to/vibe` = box `vibe` inside `path/to`
  // — same suffix preference and `_`-partial refusal as a named box.
  if (expanded.includes(path.sep)) {
    const p = path.resolve(expanded);
    return resolveBox(path.basename(p), path.dirname(p));
  }
  // `_`-prefixed files are shared partials (e.g. `_presets.mjs`), not boxes —
  // keep them un-resolvable so `-b` matches what `listBoxes` advertises.
  if (!ref.startsWith('_')) {
    const found = boxCandidates(ref, dir).find((c) => isFile(c));
    if (found) return found;
  }
  const available = listBoxes(dir);
  const hint = available.length ? `available: ${available.join(', ')}` : `none found in ${dir}`;
  throw new Error(`clabox: box '${ref}' not found in ${dir} (${hint})`);
}

/** Result of {@link loadConfig}: the effective config and the file it came from. */
export interface LoadedConfig {
  config: Config;
  configFile: string | null;
}

/**
 * Build the effective config: defaults ⊕ env ⊕ config file.
 *
 * @param explicitConfig optional config-file path (e.g. from `--config`);
 *   takes precedence over `CLABOX_CONFIG` and the default lookup locations.
 */
export async function loadConfig(explicitConfig?: string | null): Promise<LoadedConfig> {
  let cfg: Config = defaultConfig;
  const file = findConfigFile(explicitConfig);
  if (file) {
    const mod = await import(pathToFileURL(file).href);
    const exported = mod.default ?? mod.config ?? mod;
    const resolved = typeof exported === 'function' ? await exported(defaultConfig) : exported;
    cfg = mergeConfig(defaultConfig, resolved);
  }
  return { config: cfg, configFile: file };
}
