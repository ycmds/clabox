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
  /** Path to the `claude` binary. null → autodetect (PATH, then ~/.local/bin). */
  claudeBin: string | null;
  /** Claude config/profile directory — supports multiple accounts. */
  configDir: string;
  /** Extra args always passed to `claude`, before any args from the CLI. */
  claudeArgs: string[];
  bot: BotConfig;
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
}

/** Built-in defaults. Everything here is meant to be overridable. */
export const defaultConfig: Config = {
  claudeBin: env.CLABOX_CLAUDE_BIN ?? null,
  configDir: env.CLAUDE_CONFIG_DIR ?? '~/.claude',
  claudeArgs: ['--settings', '{"includeCoAuthoredBy": false}'],
  bot: {
    name: env.CLABOX_BOT_NAME ?? 'claudeBOT',
    email: env.CLABOX_BOT_EMAIL ?? 'bot@example.com',
    sshDir: env.CLABOX_BOT_SSH_DIR ?? '~/.ssh/claudebot',
  },
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
