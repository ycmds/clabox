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
  /** `clabox` binary baked into the generated `command`. null → autodetect. */
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

/** Extra rules layered on top of the built-in base profile. */
export interface PathRules {
  /** RW subpaths (beyond project dir + configDir + /tmp). */
  readWrite: string[];
  /** RO subpaths. */
  readOnly: string[];
  /** process-exec subpaths. */
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
   * `<configDir>/mcp/<slug>.json` and launches claude with
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
  /** Extra directory granted read + execute inside the sandbox. null → disabled. */
  hooksDir: string | null;
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
  hooksDir: env.CLABOX_HOOKS_DIR ?? null,
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

const BOX_SUFFIXES = ['.config.mjs', '.mjs'];

/** Candidate file paths for a box name, in resolution order. */
function boxCandidates(name: string, dir: string): string[] {
  return BOX_SUFFIXES.map((s) => path.join(dir, `${name}${s}`));
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
 * Resolve a box name to its config file in {@link configsDir}, preferring
 * `<name>.config.mjs` over a bare `<name>.mjs`.
 *
 * @throws if no matching file exists (the message lists the available boxes).
 */
export function resolveBox(name: string, dir: string = configsDir()): string {
  // `_`-prefixed files are shared partials (e.g. `_presets.mjs`), not boxes —
  // keep them un-resolvable so `-b` matches what `listBoxes` advertises.
  if (!name.startsWith('_')) {
    const found = boxCandidates(name, dir).find((c) => fs.existsSync(c));
    if (found) return found;
  }
  const available = listBoxes(dir);
  const hint = available.length ? `available: ${available.join(', ')}` : `none found in ${dir}`;
  throw new Error(`clabox: box '${name}' not found in ${dir} (${hint})`);
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
