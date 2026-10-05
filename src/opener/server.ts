// I/O for the opener broker: the unix-socket server that runs OUTSIDE every box
// and turns a validated request into one `open` invocation.
//
// Everything that decides *whether* a request is allowed lives in
// ./protocol.ts (pure). This file only does the parts that touch the world:
// bind the socket, resolve the path, exec `open`, append to the log.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import {
  type Config,
  openerAliasesPath,
  openerDir,
  openerLogPath,
  openerPidPath,
  openerSocketPath,
  resolvedOpener,
} from '../utils/config.js';
import { buildClaudeAliases } from './aliases.js';
import { inObsidianVault, installedApps } from './apps.js';
import {
  buildOpenArgs,
  type DenyReason,
  MAX_REQUEST_BYTES,
  type OpenRequest,
  parseOpenRequest,
  RateLimiter,
  validateTarget,
} from './protocol.js';
import { describeApp, routeTarget } from './routing.js';

/** Outcome of one request — what the client is told and what gets logged. */
export interface OpenOutcome {
  ok: boolean;
  request?: OpenRequest;
  reason?: DenyReason | string;
  /** Which app handled it — reported back, so "it opened somewhere" is answerable. */
  with?: string;
}

// The broker's own paths (socket, pid, log) all come from `openerDir()` in
// utils/config.ts — re-exported here because this is the module that uses them.
export { openerLogPath } from '../utils/config.js';

/**
 * Resolve a requested path the way the policy check needs it: symlinks
 * followed, because a symlink inside an allowed root is exactly how a path
 * would otherwise point outside it. Returns null when the path doesn't exist —
 * the broker only ever reveals/opens things that are already there, which also
 * means it can't be used to probe for paths outside the roots (the answer is
 * the same `denied` either way).
 */
export function resolveRequested(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

/** Options for {@link handleRequest} — the broker's resolved policy. */
export interface HandlerOptions {
  roots: string[];
  /**
   * An explicit `--editor` / `opener.editor`. null → the app is chosen per file
   * by `routing.ts` out of what's installed (code → Zed/Cursor/VS Code/…, a
   * vault note → Obsidian, an image → Preview), falling back to the system text
   * editor. Either way the choice is the broker's, never the request's.
   */
  editor: string | null;
  /** Apps available on this machine; injected so tests need no /Applications. */
  installed?: string[];
  /** Vault detection, injected for the same reason. */
  isVault?: (file: string) => boolean;
  extensions?: string[];
  limiter: RateLimiter;
  /** Injected for tests; defaults to a real `open`. */
  run?: (args: string[]) => void;
  /** Injected for tests; defaults to `Date.now`. */
  now?: () => number;
  log?: (line: string) => void;
}

/**
 * Decide and (if allowed) perform one request. Pure-ish: every side effect is
 * injectable, so the tests drive this directly without a socket or a Finder.
 */
export function handleRequest(line: string, opts: HandlerOptions): OpenOutcome {
  const now = opts.now ?? Date.now;
  const request = parseOpenRequest(line);
  if (!request) return { ok: false, reason: 'malformed request' };

  if (!opts.limiter.allow(now())) return { ok: false, request, reason: 'rate limited' };

  const real = resolveRequested(request.target);
  // A missing path and a path outside the roots get the same answer on purpose:
  // the broker must not become an oracle for what exists outside the box.
  if (!real) return { ok: false, request, reason: 'path escapes the allowed roots' };

  const denied = validateTarget(request, real, {
    roots: opts.roots,
    extensions: opts.extensions,
  });
  if (denied) return { ok: false, request, reason: denied };

  // `realTarget`, not the requested spelling: what we validated is what we open.
  // For `edit` the app comes from the routing table; `reveal` is always Finder.
  const app =
    request.action === 'reveal'
      ? null
      : routeTarget(real, {
          installed: opts.installed ?? [],
          inVault: (opts.isVault ?? ((f: string) => inObsidianVault(f)))(real),
          editor: opts.editor,
        });
  // A directory gets its own Finder window instead of being selected in its
  // parent — see buildOpenArgs. The stat lives here because protocol.ts is pure.
  let isDir = false;
  try {
    isDir = fs.statSync(real).isDirectory();
  } catch {
    // Raced away between realpath and here: treat it as a file; `open` will fail
    // harmlessly and the broker is not in the business of reporting that.
  }
  const args = buildOpenArgs({ ...request, target: real }, app, isDir);
  (opts.run ?? defaultRun)(args);
  return { ok: true, request, with: request.action === 'reveal' ? 'Finder' : describeApp(app) };
}

function defaultRun(args: string[]): void {
  // execFile, never a shell: the path is an argv entry, so nothing in it can be
  // re-interpreted. Failures are the broker's business, not the box's.
  execFile('/usr/bin/open', args, () => {});
}

/** Result of {@link runOpener}. */
export interface OpenerResult {
  socket: string;
  logFile: string;
  /** The generated shell helpers, so the CLI can print the `source` line. */
  aliasesFile: string;
  roots: string[];
  editor: string | null;
  /** Set when a broker was already running: its pid. Nothing was started. */
  alreadyRunning?: number;
  /** With no explicit editor: the app routing picks for code, shown in the banner. */
  autoEditor?: string | null;
}

/** The pid of a live broker, or null (no pid file, or that process is gone). */
export function openerPid(): number | null {
  try {
    const pid = Number.parseInt(fs.readFileSync(openerPidPath(), 'utf8').trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    process.kill(pid, 0); // signal 0 = "does it exist, and may I signal it?"
    return pid;
  } catch {
    return null;
  }
}

/**
 * Stop the running broker. Returns the pid it signalled, or null when none was
 * running. Cleans up the socket and the pid file either way, so a crashed
 * broker never blocks the next start.
 */
export function stopOpener(): number | null {
  const pid = openerPid();
  if (pid !== null) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone between the check and the signal — nothing to do.
    }
  }
  fs.rmSync(openerSocketPath(), { force: true });
  fs.rmSync(openerPidPath(), { force: true });
  return pid;
}

/**
 * Start the broker. One per machine: `clabox opener` holds the terminal,
 * `--detach` backgrounds it (same shape as `clabox daemon`). Every box talks to
 * the same socket, so this is started once and serves all of them.
 *
 * Policy comes from the config it was started with (usually the global
 * `~/.config/clabox/config.mjs`) and can be overridden per run with `roots` /
 * `editor` — i.e. `clabox opener --root ~/vault --editor Obsidian` needs no
 * config file at all.
 */
export function runOpener(
  config: Config,
  {
    onEvent,
    replace = false,
    ...overrides
  }: {
    onEvent?: (outcome: OpenOutcome) => void;
    /** Stop a running broker and take its place (`--replace`). */
    replace?: boolean;
    /** `--root` (repeatable): overrides the config's roots entirely. */
    roots?: string[];
    /** `--editor`: overrides the config's editor. */
    editor?: string | null;
  } = {},
): OpenerResult {
  const policy = resolvedOpener(config) ?? { roots: [], editor: null };
  // Flags win over the config, so a broker can be started with nothing but
  // `clabox opener --root ~/vault --editor Obsidian`.
  const roots0 = overrides.roots?.length ? overrides.roots : policy.roots;
  const editor0 = overrides.editor ?? policy.editor;
  const socket = openerSocketPath();
  const logFile = openerLogPath();
  // Everything up to `listen` touches the clabox home, which is READ-ONLY inside
  // a box — so running the broker in a box fails here, before the bind, with a
  // bare `EPERM … opener-501.sock` that explains nothing. Same message as the
  // listen failure below: the fix is the same, a terminal outside the sandbox.
  const outsideOnly = (e: unknown): never => {
    const err = e as NodeJS.ErrnoException;
    throw new Error(
      `clabox: cannot set up the broker socket at ${socket} (${err.code ?? err.message}) — ` +
        'the broker has to run OUTSIDE the sandbox (a box may connect to its socket, not create it)',
    );
  };
  try {
    fs.mkdirSync(openerDir(), { recursive: true });
  } catch (e) {
    outsideOnly(e);
  }
  // The shell helpers, refreshed beside the socket and the log. Best-effort and
  // deliberately not fatal: the broker's job is answering requests, and a
  // read-only home (or a user who made the file immutable) must not stop it.
  // Rewritten rather than written-if-absent so the helpers always match the
  // clabox that generated them — it is documented in its own header as
  // generated, and personal shell functions belong in the rc that sources it.
  const aliasesFile = openerAliasesPath();
  try {
    fs.writeFileSync(aliasesFile, buildClaudeAliases(socket), { mode: 0o644 });
  } catch {
    // ignored: see above
  }

  // Singleton. The first version unlinked the socket and bound its own, so a
  // repeated `clabox opener --detach` left the previous broker alive with
  // nothing to serve: invisible, unreachable, killable only by hand. Now a live
  // broker is reported instead of displaced; `replace` is how you swap one out
  // after changing `--editor`.
  const running = openerPid();
  if (running !== null && !replace) {
    return { socket, logFile, aliasesFile, roots: [], editor: null, alreadyRunning: running };
  }
  if (running !== null) stopOpener();
  // A stale socket (crashed broker, no live pid) would otherwise fail the bind.
  try {
    fs.rmSync(socket, { force: true });
  } catch (e) {
    outsideOnly(e);
  }

  const limiter = new RateLimiter(policy.maxPerMinute ?? 12);
  // Scanned once: /Applications doesn't change mid-session, and listing it per
  // request would be wasted work.
  const installed = installedApps();
  const autoEditor = routeTarget('x.ts', { installed });
  const roots = roots0.map((r) => resolveRequested(r) ?? r);
  const log = (line: string) => {
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // Logging must never take the broker down.
    }
  };

  // ONE request per connection: reply, then close. The reply used to be a
  // `write` with the connection left open for more lines, which nothing ever
  // sent — and it made the broker unusable from a plain shell: `printf … | nc -U
  // <socket>` prints the answer and then hangs forever waiting for EOF. Closing
  // is what lets the generated helpers (`opener/aliases.ts`) talk to the socket
  // with nothing but `nc`, instead of exec'ing clabox inside the box.
  const server = net.createServer((conn) => {
    let buf = '';
    conn.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (buf.length > MAX_REQUEST_BYTES) {
        conn.end('denied: malformed request\n');
        buf = '';
        return;
      }
      const nl = buf.indexOf('\n');
      if (nl < 0) return; // partial line: wait for the rest
      const line = buf.slice(0, nl);
      buf = '';
      const outcome = handleRequest(line, {
        roots,
        editor: editor0,
        extensions: policy.extensions,
        limiter,
        installed,
      });
      const what = outcome.request
        ? `${outcome.request.action} ${outcome.request.target}`
        : '(unparsed)';
      log(outcome.ok ? `ok ${what} → ${outcome.with}` : `denied ${what} — ${outcome.reason}`);
      onEvent?.(outcome);
      conn.end(outcome.ok ? `ok: ${outcome.with}\n` : `denied: ${outcome.reason}\n`);
    });
    conn.on('error', () => {});
  });

  // Without this, a failed bind is an uncaught exception: the process dies and
  // the only trace is a "broker started" line that was never true. The likeliest
  // cause by far is running `clabox opener` *inside* a box — binding a unix
  // socket needs `network-bind`, which no box has (a box may only connect to the
  // broker's socket), so the error is EPERM and the fix is a different terminal.
  server.on('error', (e) => {
    const err = e as NodeJS.ErrnoException;
    const hint =
      err.code === 'EPERM' || err.code === 'EACCES'
        ? ' — the broker has to run OUTSIDE the sandbox (a box may connect to its socket, not bind it)'
        : err.code === 'EADDRINUSE'
          ? ' — another broker already holds this socket'
          : '';
    log(`listen failed: ${err.code ?? err.message}${hint}`);
    console.error(`clabox: cannot listen on ${socket}: ${err.message}${hint}`);
    process.exit(1);
  });

  server.listen(socket, () => {
    // 0600: only this uid may talk to the broker. The sandbox grant decides
    // which *boxes* can reach it, this decides which users can.
    try {
      fs.chmodSync(socket, 0o600);
    } catch {
      // best-effort; the socket is inside a 0700-ish home anyway
    }
    // Logged here, not before `listen`: the broker is only started once it is
    // actually listening.
    // The pid file lands at the same moment as the log line, for the same
    // reason: neither may advertise a broker that isn't serving yet.
    try {
      fs.writeFileSync(openerPidPath(), `${process.pid}\n`, { mode: 0o600 });
    } catch {
      // Without it a second start can't find this one — not worth dying over.
    }
    log(
      `broker started (pid ${process.pid}) — roots=${roots.join(',')} ` +
        `editor=${editor0 ?? `auto (code → ${autoEditor ?? 'system text editor'})`}`,
    );
  });
  const cleanup = () => {
    server.close();
    fs.rmSync(socket, { force: true });
    fs.rmSync(openerPidPath(), { force: true });
  };
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });

  return { socket, logFile, aliasesFile, roots, editor: editor0, autoEditor };
}
