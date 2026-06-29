// `clabox info` — introspection: who clabox is, what it resolved, and how the
// effective config / box would launch claude. Mirrors the pure/I-O split used
// elsewhere: `gatherInfo` does the I/O (resolve bins, read package.json, probe
// the env), `formatInfo` is a pure text builder (unit-tested without touching
// the filesystem).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boxSlug, buildBoxExtras } from '../sandbox/extras.js';
import { profilePath, resolveProjectDir, which } from '../sandbox/run.js';
import { type BotConfig, type Config, expandHome, HOME, type PathRules } from '../utils/config.js';

/** clabox's own package: the install root + version, located at runtime. */
export interface ClaboxPackage {
  /** Directory that holds clabox's package.json (its install root). */
  root: string | null;
  version: string;
}

/**
 * Locate clabox's own package.json by walking up from this module. A relative
 * `../../package.json` is unreliable because the bundler hoists shared code into
 * hashed chunks at an unpredictable depth (`lib/info-<hash>.js`), so the literal
 * `..` count no longer matches the source tree. Walking up until we hit the
 * package.json whose `name` is `clabox` survives every layout: the source tree
 * (`src/info/`), the built tree (`lib/`, `lib/<chunk>.js`) and an installed
 * `node_modules/clabox/`.
 */
export function resolveClaboxPackage(): ClaboxPackage {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
      if (pkg.name === 'clabox') return { root: dir, version: pkg.version ?? 'unknown' };
    } catch {
      // no/unreadable package.json here — keep climbing.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  return { root: null, version: 'unknown' };
}

/** clabox's own version (best-effort; `'unknown'` if it can't be located). */
export function claboxVersion(): string {
  return resolveClaboxPackage().version;
}

/** Everything `formatInfo` needs — a plain, serializable snapshot (no I/O). */
export interface InfoData {
  name: string;
  version: string;
  description: string;
  /** Node runtime version (`process.version`). */
  node: string;
  /** Node executable that's running clabox (`process.execPath`). */
  nodeBin: string;
  platform: string;
  /** Path to the clabox entry actually running (`process.argv[1]`), null if unknown. */
  claboxBin: string | null;
  /** clabox's install root (dir of its package.json), null if it can't be found. */
  claboxRoot: string | null;
  /** Resolved `claude` binary (config → PATH → ~/.local/bin), null if absent. */
  claudeBin: string | null;
  /** Resolved `sandbox-exec` (this machine can sandbox iff non-null). */
  sandboxExec: string | null;
  /** Named box (`-b <name>`), null when none. */
  box: string | null;
  /** Per-box slug used to name the materialized mcp/settings files. */
  slug: string;
  /** Dir claude runs in and that's granted RW as the project. */
  projectDir: string;
  /** Deterministic profile path for {@link InfoData.projectDir}. */
  profileFile: string;
  /** Whether the profile has been generated already. */
  profileExists: boolean;
  /** Config file the effective config came from, null → built-in defaults. */
  configFile: string | null;
  /** Expanded `config.configDir` (Claude's profile dir). */
  configDir: string;
  network: boolean;
  ulimitProcs: number;
  claudeArgs: string[];
  /** Per-box MCP server names (keys of `config.mcp`). */
  mcpServers: string[];
  /** Whether a per-box `systemPrompt` is set. */
  hasSystemPrompt: boolean;
  /** Per-box hook event names (keys of `config.hooks`). */
  hookEvents: string[];
  bot: BotConfig;
  paths: PathRules;
  denyHome: string[];
  denyDotConfigs: string[];
  /** Forced extra env (`config.env`) as `KEY=VALUE` strings. */
  env: string[];
  /** claude args compiled from this box's mcp/systemPrompt/hooks. */
  extraArgs: string[];
  /** Files the extras reference (mcp/settings json under ~/.config/clabox). */
  extraFiles: string[];
  /** clabox-relevant vars present in the process env (`KEY=VALUE`). */
  processEnv: string[];
}

/** Env vars clabox itself reads (shown verbatim in the `[env]` section). */
const TRACKED_ENV = [
  'CLAUDE_CONFIG_DIR',
  'CLABOX_CONFIG',
  'CLABOX_CONFIGS_DIR',
  'CLABOX_CWD',
  'CLABOX_CLAUDE_BIN',
  'CLABOX_DEBUG',
];

/** Options for {@link gatherInfo}. */
export interface GatherInfoOptions {
  configFile?: string | null;
  box?: string | null;
}

/** Snapshot the effective config + runtime resolution into an {@link InfoData}. */
export function gatherInfo(config: Config, opts: GatherInfoOptions = {}): InfoData {
  const projectDir = resolveProjectDir(config);
  const slug = boxSlug(opts.configFile, projectDir);
  const extras = buildBoxExtras(config, slug);
  const profileFile = profilePath(projectDir);
  const claudeBin = config.claudeBin ?? which('claude');
  const pkg = resolveClaboxPackage();

  const processEnv = TRACKED_ENV.filter((k) => process.env[k] != null).map(
    (k) => `${k}=${process.env[k]}`,
  );

  return {
    name: 'clabox',
    version: pkg.version,
    description: 'Run Claude Code in a sandbox for super-safe YOLO mode',
    node: process.version,
    nodeBin: process.execPath,
    platform: process.platform,
    claboxBin: process.argv[1] ?? which('clabox'),
    claboxRoot: pkg.root,
    claudeBin,
    sandboxExec: which('sandbox-exec'),
    box: opts.box ?? null,
    slug,
    projectDir,
    profileFile,
    profileExists: fs.existsSync(profileFile),
    configFile: opts.configFile ?? null,
    configDir: expandHome(config.configDir),
    network: config.network,
    ulimitProcs: config.ulimitProcs,
    claudeArgs: config.claudeArgs,
    mcpServers: Object.keys(config.mcp ?? {}),
    hasSystemPrompt: Boolean(
      (Array.isArray(config.systemPrompt)
        ? config.systemPrompt.join('')
        : (config.systemPrompt ?? '')
      ).trim(),
    ),
    hookEvents: Object.keys(config.hooks ?? {}),
    bot: config.bot,
    paths: config.paths,
    denyHome: config.denyHome,
    denyDotConfigs: config.denyDotConfigs,
    env: Object.entries(config.env ?? {}).map(([k, v]) => `${k}=${v}`),
    extraArgs: extras.claudeArgs,
    extraFiles: extras.files.map((f) => f.path),
    processEnv,
  };
}

const LABEL_WIDTH = 16;

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
} as const;

/** `~`-collapse a path under $HOME for compact display (best-effort). */
function tildify(p: string): string {
  return p.startsWith(HOME) ? `~${p.slice(HOME.length)}` : p;
}

/** Collapse newlines and cap length so a long/multiline arg stays one row. */
function oneLine(s: string, max = 72): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Options for {@link formatInfo}. */
export interface FormatInfoOptions {
  /** Wrap headers/labels/placeholders in ANSI colors. Default: false. */
  color?: boolean;
}

/**
 * Render an {@link InfoData} into the human-readable `clabox info` report.
 * Pure: pass `{ color: true }` for ANSI styling (the CLI keys this off a TTY),
 * leave it off for plain text (tests, pipes).
 */
export function formatInfo(d: InfoData, { color = false }: FormatInfoOptions = {}): string {
  const paint = (code: string, s: string): string => (color ? `${code}${s}${ANSI.reset}` : s);
  // Empty/placeholder values (`-`, `(none)`, …) read as dim; everything else plain.
  const dimIfEmpty = (v: string): string => (/^(-|\(.*\))$/.test(v) ? paint(ANSI.dim, v) : v);

  const lines: string[] = [];
  const header = (title: string, note = ''): void => {
    lines.push('', paint(ANSI.bold, `[${title}]`) + (note ? paint(ANSI.dim, `  ${note}`) : ''));
  };
  const row = (label: string, value: string | number | boolean | null | undefined): void => {
    const raw = value === null || value === undefined || value === '' ? '-' : String(value);
    lines.push(`  ${paint(ANSI.cyan, label.padEnd(LABEL_WIDTH))}${dimIfEmpty(raw)}`);
  };
  // One labeled line per value (label only on the first); `-` when empty.
  const listRows = (label: string, values: string[]): void => {
    if (values.length === 0) {
      row(label, '-');
      return;
    }
    values.forEach((v, i) => {
      row(i === 0 ? label : '', v);
    });
  };

  lines.push(paint(ANSI.bold, `${d.name} v${d.version}`) + paint(ANSI.dim, ` — ${d.description}`));

  header('clabox');
  row('version', d.version);
  row('claboxBin', d.claboxBin ?? '(unknown)');
  row('claboxRoot', d.claboxRoot ? tildify(d.claboxRoot) : '(unknown)');
  row('node', `${d.node} (${tildify(d.nodeBin)})`);
  row('platform', d.platform);
  row('claudeBin', d.claudeBin ? tildify(d.claudeBin) : paint(ANSI.yellow, 'not found'));
  row('sandbox-exec', d.sandboxExec ?? paint(ANSI.yellow, 'not found (macOS only)'));

  header('box');
  row('box', d.box ?? '(none)');
  row('slug', d.slug);
  row('project', tildify(d.projectDir));
  const builtNote = d.profileExists ? '' : paint(ANSI.dim, ' (not built)');
  row('profile', tildify(d.profileFile) + builtNote);

  header('config');
  row('configFile', d.configFile ? tildify(d.configFile) : '(defaults — no file)');
  row('configDir', tildify(d.configDir));
  row('network', d.network);
  row('ulimitProcs', d.ulimitProcs || '(off)');
  row('bot', `${d.bot.name} <${d.bot.email}>`);
  row('mcp', d.mcpServers.join(', ') || '(none)');
  row('systemPrompt', d.hasSystemPrompt ? '(set)' : '(none)');
  row('hooks', d.hookEvents.join(', ') || '(none)');
  listRows('claudeArgs', d.claudeArgs);
  listRows('readWrite', d.paths.readWrite);
  listRows('readOnly', d.paths.readOnly);
  listRows('exec', d.paths.exec);
  listRows('deny', d.paths.deny);
  row('denyHome', d.denyHome.join(', ') || '(none)');
  row('denyDotConfigs', d.denyDotConfigs.join(', ') || '(none)');
  listRows('env', d.env);

  header('extras', 'compiled from this box: mcp / systemPrompt / hooks');
  listRows(
    'args',
    d.extraArgs.map((a) => oneLine(a)),
  );
  listRows('files', d.extraFiles.map(tildify));

  header('env', 'clabox-relevant vars in the environment');
  listRows('', d.processEnv);

  return lines.join('\n');
}
