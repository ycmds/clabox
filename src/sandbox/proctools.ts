// De-privileged copies of system tools the sandbox refuses to exec.
//
// `/bin/ps` and `/usr/bin/top` are setuid **root** (`-rwsr-xr-x root wheel`),
// and Seatbelt denies `exec` of any setuid/setgid binary — the denial is
// `forbidden-exec-sugid`, and it is enforced regardless of how wide the
// `process-exec` grant is. Apple was asked for a profile directive to exec a
// suid binary de-privileged and the answer was no; there is nothing to add to
// the profile that makes `ps` run. So the box sees `operation not permitted:
// /bin/ps` and the agent is blind: it can spawn `npm run dev` but can neither
// list it nor (without the `signal` rule) kill it.
//
// The way out is to *remove* privilege rather than grant any. A plain copy of
// `/bin/ps` has no setuid bit, and `ps` only needs root for processes owned by
// *other* users: KERN_PROCARGS2 and most of proc_pidinfo() are gated by
// PRIV_GLOBAL_PROC_INFO, but same-uid lookups are not. So an unprivileged copy
// still shows everything the agent itself started — which is the whole point —
// and nothing belonging to root or another user.
//
// One catch, found the hard way: the copy is SIGKILLed on launch (exit 137).
// `/bin/ps` carries the restricted entitlement `com.apple.system-task-ports.read`,
// which is only honored for Apple platform binaries; the copy is not one, so
// AMFI kills it. Re-signing it ad-hoc (`codesign -f -s -`) drops the
// entitlement along with Apple's signature and the copy runs fine.
//
// Everything here happens OUTSIDE the sandbox, before launch: the box gets the
// dir read-only (`<claboxHome>` already has the post-deny read + `process-exec`
// carve-out), so this adds no rule to the profile at all.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { claboxBinDir } from '../utils/config.js';

/** A system tool that can't be exec'd in place, and where its copy goes. */
export interface ProcTool {
  /** Absolute path of the setuid original. */
  source: string;
  /** Basename the copy is installed under (what the box invokes). */
  name: string;
}

/**
 * The tools we de-privilege. `ps` only — `top` is setuid too, but it is an
 * interactive full-screen tool an agent has no use for, and every extra copy is
 * another binary to keep in sync with the OS.
 */
export const PROC_TOOLS: ProcTool[] = [{ source: '/bin/ps', name: 'ps' }];

/** Outcome of one tool install, for diagnostics (`clabox info`). */
export interface ProcToolResult {
  name: string;
  path: string;
  /** 'installed' — (re)copied now; 'cached' — already current; 'skipped' — no source. */
  status: 'installed' | 'cached' | 'skipped';
  warning?: string;
}

/**
 * Whether the copy has to be refreshed. Pure, so the staleness rule is
 * testable without touching the filesystem.
 *
 * `fs.copyFileSync` stamps the copy with the current time rather than
 * preserving the source's, so a copy *older* than its source means the OS was
 * updated underneath us (a macOS update replaces `/bin/ps`) — that is the
 * refresh trigger.
 *
 * The copy's size is deliberately NOT compared against the source's: re-signing
 * rewrites the signature and changes it, so that check would refresh on every
 * single launch. Torn copies can't happen anyway, since the install stages into
 * a temp name and renames atomically — only an empty file is treated as broken.
 */
export function needsRefresh(
  src: { mtimeMs: number },
  dst: { size: number; mtimeMs: number } | null,
): boolean {
  if (!dst) return true;
  return dst.size === 0 || dst.mtimeMs < src.mtimeMs;
}

function statOrNull(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/**
 * Install one de-privileged copy. Best-effort: a failure is reported as a
 * warning and never throws, because a missing `ps` must not keep a box from
 * launching.
 */
function installTool(tool: ProcTool, dir: string): ProcToolResult {
  const dest = path.join(dir, tool.name);
  const src = statOrNull(tool.source);
  if (!src) {
    return { name: tool.name, path: dest, status: 'skipped', warning: `${tool.source} not found` };
  }
  if (!needsRefresh(src, statOrNull(dest))) {
    return { name: tool.name, path: dest, status: 'cached' };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    // Stage + rename so a box launching concurrently never execs a half-copied
    // binary, and never a still-Apple-signed one (which AMFI would SIGKILL).
    const stage = `${dest}.new`;
    fs.copyFileSync(tool.source, stage);
    fs.chmodSync(stage, 0o755);
    // Drop Apple's signature and with it the restricted entitlement that makes
    // AMFI kill a non-platform copy. Without this the binary exits 137.
    execFileSync('codesign', ['-f', '-s', '-', stage], { stdio: 'ignore' });
    fs.renameSync(stage, dest);
    return { name: tool.name, path: dest, status: 'installed' };
  } catch (err) {
    const warning = err instanceof Error ? err.message : String(err);
    try {
      fs.rmSync(`${dest}.new`, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    return { name: tool.name, path: dest, status: 'skipped', warning };
  }
}

/**
 * Materialize every de-privileged tool into `<claboxHome>/bin`, returning one
 * result per tool. Call from outside the sandbox, before launch.
 */
export function ensureProcTools(dir: string = claboxBinDir()): ProcToolResult[] {
  if (process.platform !== 'darwin') return [];
  return PROC_TOOLS.map((tool) => installTool(tool, dir));
}
