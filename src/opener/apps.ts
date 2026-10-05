// I/O half of the routing: what is actually installed, and what an Obsidian
// vault looks like on disk. Runs in the broker, i.e. OUTSIDE every box — a
// sandboxed process cannot read /Applications at all, which is precisely why
// the choice of app is made here and not in the box.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where macOS keeps apps, in the order LaunchServices would consider them. */
export const APP_DIRS = [
  '/Applications',
  '/Applications/Utilities',
  path.join(os.homedir(), 'Applications'),
  '/System/Applications',
  '/System/Applications/Utilities',
];

/**
 * Names (without `.app`) of the applications installed on this machine.
 *
 * Deliberately a plain directory listing rather than `mdfind`/LaunchServices:
 * it needs no Spotlight index, no extra entitlement, and it is instant. Missing
 * directories are skipped.
 */
export function installedApps(dirs: string[] = APP_DIRS): string[] {
  const out = new Set<string>();
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir);
    } catch {
      continue; // no such dir on this machine
    }
    for (const e of entries) if (e.endsWith('.app')) out.add(e.slice(0, -4));
  }
  return [...out];
}

/**
 * True when `file` sits inside an Obsidian vault — i.e. some ancestor holds a
 * `.obsidian` directory. Stops at `stopAt` (the broker's root) so it never
 * walks the whole filesystem, and at `/` regardless.
 */
export function inObsidianVault(file: string, stopAt?: string): boolean {
  let dir = path.dirname(path.resolve(file));
  const stop = stopAt ? path.resolve(stopAt) : null;
  for (;;) {
    try {
      if (fs.statSync(path.join(dir, '.obsidian')).isDirectory()) return true;
    } catch {
      // not here — keep climbing
    }
    if (stop && dir === stop) return false;
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}
