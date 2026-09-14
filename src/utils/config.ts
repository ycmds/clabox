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

/**
 * Terminal-tab appearance for a run — how *this* tab announces itself. Built
 * into OSC escape sequences by `sandbox/tab.ts` and written only onto a real
 * TTY. The point is telling two tabs of the same box apart: `--rc` talks to
 * Remote Control (i.e. this session is reachable from the Claude app and
 * feature-flag fetching is on), a plain tab doesn't — and they otherwise look
 * identical.
 */
export interface TabConfig {
  /** Fixed tab title. null → the project dir (`~`-shortened), as before. */
  title?: string | null;
  /** Prefixed to the title while `--rc` is on. null/'' → no badge. */
  rcBadge?: string | null;
  /** Background color (OSC 11) for this box: `#rgb`/`#rrggbb`/X11 name. null → untouched. */
  background?: string | null;
  /** Background used while `--rc` is on; wins over {@link TabConfig.background}. */
  rcBackground?: string | null;
  /** Foreground color (OSC 10) for this box. null → untouched. */
  foreground?: string | null;
  /** Foreground used while `--rc` is on; wins over {@link TabConfig.foreground}. */
  rcForeground?: string | null;
  /**
   * Cursor color (OSC 12) for this box. null → untouched. The loudest marker of
   * the three: a background is washed out by `background-opacity`/blur, a
   * blinking cursor isn't.
   */
  cursor?: string | null;
  /** Cursor used while `--rc` is on; wins over {@link TabConfig.cursor}. */
  rcCursor?: string | null;
}

/**
 * Desktop notifications for a box — compiled into claude hooks that write
 * terminal escape sequences (`sandbox/notify.ts`), which is the only
 * notification channel that survives the sandbox: `terminal-notifier` hangs and
 * `osascript display notification` dies in-box, but the terminal emulator lives
 * outside it and already reads `/dev/tty`.
 *
 * Opt-in (`enabled: false`), because turning it on injects hooks into the box's
 * compiled settings.
 */
export interface NotifyConfig {
  /** Master switch. Env: `CLABOX_NOTIFY=1`. */
  enabled: boolean;
  /** Banner title. null → `Claude · <box slug>`. */
  title?: string | null;
  /** Banner body when a reply lands (`Stop`). null → no notification there. */
  stop?: string | null;
  /** Banner body when claude blocks on you (`Notification`). null → off. */
  waiting?: string | null;
  /**
   * Also drive the tab/dock progress indicator (OSC 9;4): yellow while claude
   * waits for you, cleared when the reply lands. Unlike a banner it stays put
   * while you're in another window.
   */
  progress?: boolean;
  /** Also ring the bell (BEL) — Ghostty's `bell-features` decides what that does. */
  bell?: boolean;
}

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
  /**
   * gitignore-style globs whose matches are denied **read**, at any depth
   * *inside the project workspace* (kept off system dirs on purpose — a global
   * `**​/__*` would also shadow CPython's `.../__init__.py` and break it). A
   * `!`-prefixed pattern re-allows; last match wins, exactly like `.gitignore`,
   * so order matters. `*` = a run of non-slash chars, `**` = any run, `?` = one
   * non-slash char; a directory match also covers its contents. Compiled to
   * SBPL regex by `globToRegexBody` — the patterns live here as data.
   */
  denyGlobs: string[];
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
   * Claude configDir) and launches claude with `--mcp-config <file>`, plus
   * `--strict-mcp-config` unless {@link Config.strictMcp} is false.
   * Materialized on every `run` and during `init`. Absent → no MCP flags.
   */
  mcp?: Record<string, McpServer>;
  /**
   * Whether a box declaring {@link Config.mcp} *also* gets `--strict-mcp-config`
   * (default `true`, env `CLABOX_STRICT_MCP=0`). Ignored without `mcp`.
   *
   * `true` — the box sees **exactly** its own servers: a shared configDir's
   * global and plugin MCP servers are ignored. But claude reads "ignoring all
   * other MCP configurations" wider than the config files: it also drops the
   * **claude.ai connectors** (Linear, Slack, Figma, … — served through
   * `mcp-proxy.anthropic.com`, which no local file declares), leaving only the
   * built-ins (`claude-in-chrome`).
   *
   * `false` — a plain `--mcp-config`, which **merges**: the box's own servers on
   * top of the account's cloud connectors and the configDir's own. Pick this for
   * a box that wants its MCP *in addition to* the cloud ones.
   */
  strictMcp: boolean;
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
   *
   * A **`null` value means "unset it"** (`env -u KEY`) — the way to *drop* a var
   * the shell (or a shared preset) exported, which no assignment can do. That
   * matters for claude's privacy vars: `DISABLE_TELEMETRY` / `DO_NOT_TRACK` /
   * `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` / `DISABLE_GROWTHBOOK` turn off
   * feature-flag fetching, which hides Remote Control (`/rc`) and the other
   * flag-gated features — so a box that wants `/rc` has to unset them, not
   * merely set them to `0` (claude reads the first three as "any non-empty
   * value", `0`/`false` included).
   */
  env: Record<string, string | null>;
  /** Allow outbound network. `false` → no `(allow network*)` line. */
  network: boolean;
  /**
   * Let the box hand work to claude's **background tasks** (`false` by default,
   * i.e. they're disabled in-box).
   *
   * This is a sandbox **escape hatch**, not a convenience toggle. A background
   * task isn't forked by the sandboxed claude — the request goes over a socket
   * to the singleton `claude daemon run` supervisor, which lives outside every
   * box (PPID 1 / launchd) and re-launches the session with `--fork-session
   * --resume`. The new process carries the same session id and the same
   * transcript but **no Seatbelt profile**: full read/write as the user, with
   * the box's system prompt still claiming it's sandboxed. Seatbelt is bound to
   * a process, a session is bound to a file, and background handoff swaps the
   * process — so the sandbox is simply gone. See docs/troubleshooting.md.
   *
   * Left `false`, the launcher forces {@link SANDBOX_ESCAPE_GUARDS} into the
   * box env. Flip it only for a box you'd be happy to run unsandboxed.
   */
  allowBackgroundTasks: boolean;
  /** Cap the process table inside the sandbox (fork-bomb guard). 0 → skip. */
  ulimitProcs: number;
  paths: PathRules;
  /** Home subdirectories denied entirely (read + write). */
  denyHome: string[];
  /** Dotfile config dirs under $HOME denied entirely. */
  denyDotConfigs: string[];
  /**
   * How the terminal tab looks while this box runs (title + background color).
   * The `rc*` fields kick in for a `--rc` launch, so a Remote-Control tab is
   * visually distinct from a private one.
   */
  tab?: TabConfig;
  /**
   * Opt-in desktop notifications that work *inside* the sandbox, by writing
   * terminal escape sequences to `/dev/tty` from compiled hooks. See
   * {@link NotifyConfig} and `sandbox/notify.ts`.
   */
  notify?: NotifyConfig;
  /**
   * Opt-in: build a standalone Ghostty app for this box during `clabox init`.
   * Absent → the box only gets a shell alias (the default).
   */
  app?: AppConfig;
  /** Machine-wide settings for the `clabox init` Ghostty-app builder. */
  appBuilder: AppBuilderConfig;
}

/**
 * Read a `config.tab` env override: unset → the built-in default, set-but-empty
 * → `null` (explicitly "off", e.g. `CLABOX_TAB_RC_BACKGROUND=` to stop the
 * `--rc` repaint without writing a config file).
 */
function tabEnv(raw: string | undefined, fallback: string | null): string | null {
  if (raw === undefined) return fallback;
  return raw.trim() || null;
}

/** Built-in defaults. Everything here is meant to be overridable. */
export const defaultConfig: Config = {
  cwd: env.CLABOX_CWD ?? null,
  claudeBin: env.CLABOX_CLAUDE_BIN ?? null,
  configDir: env.CLAUDE_CONFIG_DIR ?? '~/.claude',
  claudeArgs: ['--settings', '{"includeCoAuthoredBy": false}'],
  // Strict by default: a box gets exactly its own MCP servers. Set false (or
  // CLABOX_STRICT_MCP=0) to keep the claude.ai cloud connectors alongside them.
  strictMcp: env.CLABOX_STRICT_MCP !== '0',
  bot: {
    name: env.CLABOX_BOT_NAME ?? 'claudeBOT',
    email: env.CLABOX_BOT_EMAIL ?? 'bot@example.com',
    sshDir: env.CLABOX_BOT_SSH_DIR ?? '~/.ssh/claudebot',
  },
  env: {},
  network: true,
  // Background tasks escape the sandbox (they're launched by the unsandboxed
  // daemon, not forked in-box) — off unless a box explicitly opts in.
  allowBackgroundTasks: env.CLABOX_ALLOW_BACKGROUND_TASKS === '1',
  ulimitProcs: 1024,
  paths: {
    readWrite: [],
    readOnly: [],
    exec: [],
    deny: [],
    // gitignore-style read-deny inside the project (opt-in, empty by default).
    // e.g. ['**/.env*', '!**/.env.example', '**/___*'] to hide `.env*` secrets
    // + `___*` files (triple `_` dodges Python dunders like `__init__.py`).
    denyGlobs: [],
  },
  denyHome: ['Documents', 'Desktop', 'Downloads', 'Pictures', 'Movies', 'Music'],
  // `.config/git` is always carved back out for git RO config in the profile.
  denyDotConfigs: ['aws', 'gnupg', 'kube', 'docker', 'config'],
  // Tab looks: plain runs keep the terminal's own colors, a `--rc` run repaints
  // them so a Remote-Control tab can't be mistaken for a private one. The
  // background alone is easy to miss (a box with `background-opacity`/blur
  // washes it out, and on a dark theme every dark tint looks the same), so the
  // `--rc` default is a warm, clearly-not-your-theme background plus a bright
  // amber cursor — small, moving, and impossible to miss. Each is overridable
  // per box or by env, where an empty value (`CLABOX_TAB_RC_CURSOR=`) means off.
  tab: {
    title: tabEnv(env.CLABOX_TAB_TITLE, null),
    rcBadge: tabEnv(env.CLABOX_TAB_RC_BADGE, '📡 RC'),
    background: tabEnv(env.CLABOX_TAB_BACKGROUND, null),
    rcBackground: tabEnv(env.CLABOX_TAB_RC_BACKGROUND, '#5c1a00'),
    foreground: tabEnv(env.CLABOX_TAB_FOREGROUND, null),
    rcForeground: tabEnv(env.CLABOX_TAB_RC_FOREGROUND, null),
    cursor: tabEnv(env.CLABOX_TAB_CURSOR, null),
    rcCursor: tabEnv(env.CLABOX_TAB_RC_CURSOR, '#ff8c1a'),
  },
  // Off by default: switching it on injects hooks into the box's settings, and
  // a box that already has its own notification hooks shouldn't grow a second
  // banner behind the user's back. `CLABOX_NOTIFY=1` turns it on machine-wide.
  notify: {
    enabled: env.CLABOX_NOTIFY === '1',
    title: tabEnv(env.CLABOX_NOTIFY_TITLE, null),
    stop: 'reply is ready',
    waiting: 'waiting for you',
    progress: true,
    bell: true,
  },
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
 * The env vars that turn claude's **feature-flag fetching** off. Any one of them,
 * from any source (the box `env`, the login shell, a `settings.json` `env`
 * block), is enough — and with fetching off the flag-gated features fall back to
 * their code defaults, which hides Remote Control (`/rc`), auto mode by default,
 * cross-machine session messaging, `/import`, `/skill-doctor` and more:
 * https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching
 *
 * The first two count **any non-empty value** (`0` and `false` included), so
 * they can only be neutralized by *unsetting* them — which is what the `--rc`
 * CLI flag does (it maps to `withExtraEnv(config, FLAG_FETCH_BLOCKERS)`).
 */
/**
 * Env vars the launcher forces into every box that hasn't set
 * {@link Config.allowBackgroundTasks} — the vars that close claude's
 * **background-task escape hatch**.
 *
 * Why it's an escape and not just a feature: a background task is not forked by
 * the sandboxed claude (a macOS sandbox is inherited and can't be dropped, so a
 * real fork would stay confined). The in-box process asks the singleton
 * `claude daemon run` supervisor over its control socket, and that daemon runs
 * **outside every box** — PPID 1, started by launchd, no `sandbox-exec` anywhere
 * in its ancestry. It answers by launching `claude --fork-session --resume
 * <same-session-id>`, so the work continues with the identical transcript and an
 * empty Seatbelt policy. Observed ancestry of such a session:
 *
 *     zsh ← claude --fork-session --resume ← ClaudeCode.app --bg-pty-host
 *         ← claude daemon run   (PPID 1, launchd)
 *
 * It reads `~/Library/Logs/DiagnosticReports`, writes `~/Desktop`, and still
 * carries the box's "you're in a sandbox" system prompt. Only the keychain-level
 * hard denies survive, because they're macOS ACLs rather than profile rules.
 *
 * Emitted **before** `config.env` so a box (or `-e KEY=VALUE`) can still
 * override them — the guard is a default, not a lock.
 */
export const SANDBOX_ESCAPE_GUARDS: Record<string, string> = {
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1',
};

export const FLAG_FETCH_BLOCKERS = [
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'DISABLE_TELEMETRY',
  'DO_NOT_TRACK',
  'DISABLE_GROWTHBOOK',
];

/**
 * Layer ad-hoc env overrides (from the repeatable `--env`/`-e` CLI flag) onto
 * `config.env`. Each entry is either `KEY=VALUE` (set it) or a bare `KEY`
 * (**unset** it — emitted as `env -u KEY`, the only way to drop a var a shared
 * preset or the shell exported). Later entries win, and they win over the
 * config's own `env`, so one tab can differ from its box without a new config:
 *
 *     clabox -b ax-mg -e DISABLE_TELEMETRY      # this tab gets /rc
 *     clabox -b ax-mg -e DISABLE_TELEMETRY=1    # this tab stays private
 *
 * Pure; returns the same config when nothing is passed. Entries without a name
 * (e.g. `=1`) are ignored rather than producing a broken `env` argument.
 */
export function withExtraEnv(config: Config, entries: string[] = []): Config {
  if (!entries.length) return config;
  const env: Record<string, string | null> = { ...(config.env ?? {}) };
  for (const entry of entries) {
    const eq = entry.indexOf('=');
    const key = (eq === -1 ? entry : entry.slice(0, eq)).trim();
    if (!key) continue;
    env[key] = eq === -1 ? null : entry.slice(eq + 1);
  }
  return { ...config, env };
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
