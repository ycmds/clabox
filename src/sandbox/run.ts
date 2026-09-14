// Profile materialization + launching `claude` under sandbox-exec.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, expandHome, HOME, SANDBOX_ESCAPE_GUARDS } from '../utils/config.js';
import { boxSlug, buildBoxExtras, type ExtraFile } from './extras.js';
import { buildProfile, detectPackagePaths } from './profile.js';
import { buildTabDecor } from './tab.js';
import { sttyIo, suppressEcho } from './tty.js';

const TMPDIR = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');

/** Deterministic per-project profile path under TMPDIR. */
export function profilePath(projectDir: string = process.cwd()): string {
  const hash = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
  return path.join(TMPDIR, `clabox-${path.basename(projectDir)}-${hash}.sb`);
}

/**
 * Effective project dir: `config.cwd` (with `~` expanded, resolved to an
 * absolute path so SBPL `subpath` rules stay valid) if set, else the shell CWD.
 */
export function resolveProjectDir(config: Config): string {
  return config.cwd ? path.resolve(expandHome(config.cwd)) : process.cwd();
}

/** Resolve a binary via the shell's `command -v`; null if not on PATH. */
export function which(bin: string): string | null {
  try {
    return (
      execFileSync('command', ['-v', bin], { shell: '/bin/sh', encoding: 'utf8' }).trim() || null
    );
  } catch {
    return null;
  }
}

function requireSandboxExec(): void {
  if (!which('sandbox-exec')) {
    throw new Error('sandbox-exec not found. This tool requires macOS with sandbox-exec.');
  }
}

/** Resolve the `claude` binary: `config.claudeBin`, then PATH, then ~/.local/bin. */
export function resolveClaudeBin(config: Config): string {
  const candidate = config.claudeBin || which('claude') || path.join(HOME, '.local/bin/claude');
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error(`claude not found at '${candidate}'`);
  }
  return candidate;
}

/** Generate the profile file for the current project, return its path. */
export function generateProfile(
  config: Config,
  projectDir: string = resolveProjectDir(config),
): string {
  requireSandboxExec();
  const file = profilePath(projectDir);
  const text = buildProfile(config, { projectDir, detectedPaths: detectPackagePaths() });
  fs.writeFileSync(file, text);
  return file;
}

/** Build the `env KEY=VALUE …` argument list forced onto the sandboxed claude. */
export function buildEnvArgs(config: Config): string[] {
  const sshDir = expandHome(config.bot.sshDir);
  const botKey = path.join(sshDir, 'id_ed25519');
  const botCfg = path.join(sshDir, 'config');
  const args = [
    `PATH=${path.join(HOME, '.local/bin')}:${process.env.PATH || ''}`,
    `CLAUDE_CONFIG_DIR=${expandHome(config.configDir)}`,
    `GIT_AUTHOR_NAME=${config.bot.name}`,
    `GIT_AUTHOR_EMAIL=${config.bot.email}`,
    `GIT_COMMITTER_NAME=${config.bot.name}`,
    `GIT_COMMITTER_EMAIL=${config.bot.email}`,
    'GIT_CONFIG_COUNT=2',
    'GIT_CONFIG_KEY_0=commit.gpgsign',
    'GIT_CONFIG_VALUE_0=false',
    'GIT_CONFIG_KEY_1=tag.gpgsign',
    'GIT_CONFIG_VALUE_1=false',
  ];
  // Keep the session inside the process that carries the profile: background
  // tasks are served by the UNsandboxed daemon, which re-hosts the session with
  // `--fork-session --resume` and no Seatbelt policy. `allowBackgroundTasks` is
  // the opt-out — and it has to be a config flag rather than an `env` entry,
  // because `env` takes its `-u` flags ahead of the assignments, so a
  // `{ KEY: null }` could never undo a `KEY=1` we put in this list.
  if (!config.allowBackgroundTasks) {
    for (const [key, value] of Object.entries(SANDBOX_ESCAPE_GUARDS)) {
      args.push(`${key}=${value}`);
    }
  }
  // Pin git ssh to the bot key only when it actually exists, so the sandbox
  // stays usable without a dedicated bot key configured.
  if (fs.existsSync(botKey)) {
    args.push(
      `GIT_SSH_COMMAND=ssh -F ${botCfg} -i ${botKey} -o IdentitiesOnly=yes -o IdentityAgent=none`,
    );
  }
  // User-declared extras go last so they win over the built-in vars above
  // (duplicate keys: `env` keeps the last assignment). A `null` value means
  // "unset" — `env -u KEY`, the only way to *drop* a var the shell exported
  // (e.g. `DISABLE_TELEMETRY`, which would otherwise keep feature-flag fetching
  // off and hide `/rc`). `-u` flags must precede the assignments, so they're
  // spliced in ahead of the whole list rather than appended.
  const unset: string[] = [];
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === null) unset.push('-u', key);
    else args.push(`${key}=${value}`);
  }
  return [...unset, ...args];
}

/**
 * Write the per-box extra files (mkdir -p their dirs) `0600`. They live under
 * clabox's home (`~/.config/clabox`) and can carry secrets (e.g. an MCP auth
 * token in a URL/header), so they're kept out of argv (vs. an inline
 * `--mcp-config '<json>'`) AND off the world-readable bit on disk. Returns the
 * paths.
 */
export function writeExtraFiles(files: ExtraFile[]): string[] {
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, { mode: 0o600 });
    fs.chmodSync(f.path, 0o600); // enforce even if the file pre-existed
  }
  return files.map((f) => f.path);
}

/** Processes currently owned by this uid; null when `ps` can't be read. */
export function countUserProcs(): number | null {
  try {
    const out = execFileSync('/bin/ps', ['-u', String(process.getuid?.() ?? ''), '-o', 'pid='], {
      encoding: 'utf8',
    });
    return out.split('\n').filter((l) => l.trim()).length;
  } catch {
    return null;
  }
}

/** Hard per-uid process cap (`kern.maxprocperuid`); null when unreadable. */
export function maxProcPerUid(): number | null {
  try {
    const n = Number(
      execFileSync('/usr/sbin/sysctl', ['-n', 'kern.maxprocperuid'], { encoding: 'utf8' }).trim(),
    );
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Effective `ulimit -u` value, or null for "don't set one".
 *
 * `RLIMIT_NPROC` counts processes **per uid, machine-wide** — not per session.
 * A desktop macOS login easily runs 1000+ processes, so an *absolute* cap of
 * e.g. 1024 doesn't limit the box, it bricks it: every fork inside fails with
 * EAGAIN from the first second, including the `security` subprocess claude
 * spawns to read its OAuth token — which surfaces as
 * `Not logged in · Please run /login` and an `API Usage Billing` header.
 *
 * So `config.ulimitProcs` is **headroom**: how many processes the box may add
 * on top of what the user already runs. Clamped to the hard limit
 * (`kern.maxprocperuid`), since asking for more than that fails outright.
 * Without a process count there's nothing to be relative to, so the guard is
 * skipped rather than guessed — a cap we can't reason about is the bug above.
 */
export function resolveUlimit(
  headroom: number,
  { current, hard }: { current: number | null; hard: number | null },
): number | null {
  const extra = Math.floor(Number(headroom));
  if (!Number.isFinite(extra) || extra <= 0) return null; // 0 / garbage → guard off
  if (current === null) return null;
  const wanted = current + extra;
  return hard === null ? wanted : Math.min(wanted, hard);
}

/** Options accepted by {@link runClaude}. */
export interface RunOptions {
  configFile?: string | null;
  /**
   * The launch came from `--rc`. Only used for the tab decoration — a
   * Remote-Control tab (reachable from the Claude app, feature-flag fetching on)
   * gets `config.tab.rcBadge`/`rcBackground` so it can't be confused with a
   * private tab of the same box. The env unsets themselves already live in
   * `config.env` by the time we get here.
   */
  rc?: boolean;
}

/** Generate the profile and exec claude under sandbox-exec. Returns exit code. */
export function runClaude(
  config: Config,
  claudeArgs: string[],
  { configFile, rc }: RunOptions = {},
): number {
  const projectDir = resolveProjectDir(config);
  const claudeBin = resolveClaudeBin(config);
  const profileFile = generateProfile(config, projectDir);

  // Compile the box's declarative mcp / systemPrompt into claude args, and
  // materialize the files they reference (under ~/.config/clabox, granted RO
  // in-box).
  const extras = buildBoxExtras(config, boxSlug(configFile, projectDir));
  const extraFiles = writeExtraFiles(extras.files);

  if (process.env.CLABOX_DEBUG) {
    console.error(`→ Running Claude Code sandboxed in:  ${projectDir}`);
    console.error(`→ Profile: ${profileFile}`);
    console.error(`→ Config:  ${expandHome(config.configDir)}`);
    if (configFile) console.error(`→ Config file: ${configFile}`);
    for (const f of extraFiles) console.error(`→ MCP:     ${f}`);
  }

  // Tab looks: title (cwd with `~` for $HOME, as the bash version did) plus,
  // for a `--rc` launch, a badge and a repainted background — so a tab that's
  // reachable from the Claude app is recognizable at a glance. Only onto a real
  // TTY: piped output would just get escape garbage.
  const decor = buildTabDecor(config, { projectDir, rc });
  const tty = Boolean(process.stdout.isTTY);
  if (tty) process.stdout.write(decor.enter);

  const envArgs = buildEnvArgs(config);
  const defaultArgs = Array.isArray(config.claudeArgs) ? config.claudeArgs : [];
  const inner = [
    'sandbox-exec',
    '-f',
    profileFile,
    'env',
    ...envArgs,
    claudeBin,
    ...defaultArgs,
    ...extras.claudeArgs,
    ...claudeArgs,
  ];

  // `ulimit` is a shell builtin; run the whole thing under sh so we can set it.
  // The cap is *relative* to the processes already running under this uid --
  // see `resolveUlimit`; an absolute one would make the box unable to fork.
  // `exec "$@"` keeps argv intact without re-quoting (args start after $0=sh).
  const procLimit = resolveUlimit(config.ulimitProcs, {
    current: countUserProcs(),
    hard: maxProcPerUid(),
  });
  const ulimit = procLimit === null ? '' : `ulimit -u ${procLimit} 2>/dev/null; `;
  // Hand the terminal over with ECHO off: claude's startup probes (XTVERSION,
  // OSC 11, DA1) are answered by the terminal as *input*, and anything arriving
  // before claude has raw mode up would otherwise be echoed into the banner as
  // `^[P>|ghostty…`. Restored right after the run — see sandbox/tty.ts.
  const ttyGuard = suppressEcho(sttyIo());
  let res: ReturnType<typeof spawnSync>;
  try {
    res = spawnSync('/bin/sh', ['-c', `${ulimit}exec "$@"`, 'sh', ...inner], {
      cwd: projectDir,
      stdio: 'inherit',
    });
  } finally {
    ttyGuard.restore();
    // Give the terminal its own background back, however claude exited (a kill
    // -9 of clabox itself can still leave it repainted — reopening the tab, or
    // any shell printing `\e]111\a`, undoes it).
    if (tty) process.stdout.write(decor.leave);
  }
  if (res.error) throw res.error;
  if (res.signal) return 1;
  return res.status ?? 0;
}
