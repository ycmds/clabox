// `clabox daemon` — run claude's Remote Control daemon for a box, but
// deliberately OUTSIDE the sandbox.
//
// Remote Control (`/rc`, sessions started from the Claude app) needs a
// supervisor daemon. It is a singleton per Claude config dir (socket
// `/tmp/cc-daemon-<uid>/<hash(configDir)>/control.sock`) and claude starts it
// **on demand** — so whoever asks first owns it. If that first ask happens
// inside a box, the daemon is born inside Seatbelt and is crippled two ways:
//
//   1. It probes its own start time by exec'ing `/bin/ps`, which is setgid
//      `kmem` — Seatbelt refuses to exec setgid binaries no matter how wide the
//      `process-exec` grant is. The daemon then logs `own process start-time
//      probe failed twice — writing a procStart-less lock; kill paths will
//      refuse to signal this daemon`, i.e. it can no longer be stopped by
//      `claude daemon stop`, and a new daemon "never displaces a running one".
//   2. A macOS sandbox is inherited by children and cannot be dropped, so every
//      worker the daemon spawns for a remote session stays confined to *that*
//      box's profile — a session for any other project can't read its own
//      directory and dies (`bg settled … (crashed): exit 1 before init`).
//
// Hence this command: it launches `claude daemon …` with the box's `configDir`
// and `env` but **without** `sandbox-exec`, so the daemon is already up (and
// healthy) before any box asks for one. See docs/troubleshooting.md.
//
// Same pure/I-O split as the rest: `buildDaemonArgs`/`buildDaemonEnv` are pure,
// `runDaemon` does the spawning.

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { resolveClaudeBin, resolveProjectDir } from '../sandbox/run.js';
import { type Config, expandHome } from '../utils/config.js';

/** `claude daemon` subcommand used when `clabox daemon` is called bare. */
export const DEFAULT_DAEMON_ARGS = ['run'];

/** Pure: the full argv handed to `claude` (`run` when nothing is passed). */
export function buildDaemonArgs(args: string[] = []): string[] {
  return ['daemon', ...(args.length ? args : DEFAULT_DAEMON_ARGS)];
}

/**
 * Pure: the environment for the daemon process — the inherited env plus the
 * box's `configDir` (which is what the daemon keys its socket, lock, roster and
 * log off) and the box's `config.env`, so the worker sessions it spawns get the
 * same vars a box run would give them. No sandbox/hardening vars: this process
 * is intentionally unsandboxed.
 */
export function buildDaemonEnv(
  config: Config,
  base: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_CONFIG_DIR = expandHome(config.configDir);
  // Same contract as the sandboxed launcher: a `null` value means "unset".
  for (const [key, value] of Object.entries(config.env ?? {})) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return env;
}

/** Where the daemon writes its log (claude's default, under the config dir). */
export function daemonLogPath(config: Config): string {
  return path.join(expandHome(config.configDir), 'daemon.log');
}

/** Options accepted by {@link runDaemon}. */
export interface DaemonOptions {
  /** Spawn detached and return immediately instead of running in foreground. */
  detach?: boolean;
}

/** Outcome of {@link runDaemon}. */
export interface DaemonResult {
  /** Exit code (always 0 for a detached start). */
  status: number;
  /** The detached daemon's pid; null when it ran in the foreground. */
  pid: number | null;
  /** Log file the daemon writes to. */
  logFile: string;
  /** The `configDir` the daemon was pinned to. */
  configDir: string;
}

/**
 * Run `claude daemon …` unsandboxed for this box. Foreground by default (Ctrl+C
 * stops it, exactly like `claude daemon run`); `detach: true` puts it in the
 * background — its output goes to the daemon log, not this terminal.
 */
export function runDaemon(
  config: Config,
  args: string[] = [],
  { detach = false }: DaemonOptions = {},
): DaemonResult {
  const claudeBin = resolveClaudeBin(config);
  const argv = buildDaemonArgs(args);
  const env = buildDaemonEnv(config);
  const cwd = resolveProjectDir(config);
  const base = { logFile: daemonLogPath(config), configDir: env.CLAUDE_CONFIG_DIR };

  if (detach) {
    const child = spawn(claudeBin, argv, { cwd, env, detached: true, stdio: 'ignore' });
    child.unref();
    return { status: 0, pid: child.pid ?? null, ...base };
  }

  const res = spawnSync(claudeBin, argv, { cwd, env, stdio: 'inherit' });
  if (res.error) throw res.error;
  return { status: res.signal ? 1 : (res.status ?? 0), pid: null, ...base };
}
