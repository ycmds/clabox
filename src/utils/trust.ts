// Trust for config files clabox `import()`s — the gate in front of the one step
// that runs third-party code OUTSIDE the sandbox.
//
// A box config is plain JavaScript, evaluated by `loadConfig` **before**
// `sandbox-exec` is anywhere in the picture: its top-level code runs as the
// user, and what it returns *is* the sandbox policy. Three paths lead there from
// a tree a sandboxed agent can write:
//
//   * a bare `clabox` in a repo auto-loads `./clabox.config.mjs` (findConfigFile);
//   * `-b ./boxes/vibe.mjs` names a repo file directly (a documented feature);
//   * `clabox init --dir <repo>` imports every config under `<repo>/configs`.
//
// So the agent writes the file, and the next launch executes it unsandboxed.
// This module makes that step explicit: a config is loaded only from clabox's
// own home, or after the user has recorded it with `clabox trust <path>` —
// keyed by content hash, so an *edit* needs re-trusting, not just the path.
// Pure except for the obvious fs reads/writes; it deliberately knows nothing
// about `Config` (the clabox home is passed in) so config.ts can import it
// without a cycle.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** `<claboxHome>/trusted.json` — the record of configs the user accepted. */
export function trustFilePath(claboxHome: string): string {
  return path.join(claboxHome, 'trusted.json');
}

/** sha256 of a file's bytes, `sha256:<hex>`; null when unreadable. */
export function hashFile(file: string): string | null {
  try {
    return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
  } catch {
    return null;
  }
}

/**
 * Resolve a path as far as it exists (symlinks included), keeping the part that
 * doesn't exist yet lexical.
 *
 * Containment has to be judged on the **real** path: that's the one the sandbox
 * grants are matched against, and a symlinked clabox home (a documented layout —
 * the box configs relocated into a repo) is exactly the case where nominal and
 * real disagree. `realpathSync` is all-or-nothing, so for a path whose last
 * component is missing it would return the lexical form *including* an
 * unresolved symlink in the middle — i.e. exactly the case this is here to
 * catch. Hence the walk up to the deepest existing ancestor.
 */
export function realpath(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    const dir = path.dirname(abs);
    // At the filesystem root there's nothing left to resolve.
    return dir === abs ? abs : path.join(realpath(dir), path.basename(abs));
  }
}

/** True when `child` is `parent` or sits underneath it (both resolved first). */
export function isInside(parent: string, child: string): boolean {
  const p = realpath(parent);
  const c = realpath(child);
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** The `path → hash` map in the trust file (empty when absent/corrupt). */
export function readTrustStore(claboxHome: string): Record<string, string> {
  try {
    const raw = JSON.parse(fs.readFileSync(trustFilePath(claboxHome), 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      return Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          ([, v]) => typeof v === 'string',
        ) as Array<[string, string]>,
      );
    }
  } catch {
    // absent or unparseable → nothing is trusted, which is the safe answer.
  }
  return {};
}

/** Trust state of a config file — what {@link assertConfigTrusted} acts on. */
export type TrustState =
  /** Inside clabox's own home: trusted by location, no record needed. */
  | 'home'
  /** Recorded in `trusted.json` and the content still matches. */
  | 'trusted'
  /** Recorded, but the file changed since — re-trust needed. */
  | 'stale'
  /** Never recorded. */
  | 'unknown';

/** Classify a config file against the trust store. Pure-ish (reads the file). */
export function configTrustState(configFile: string, claboxHome: string): TrustState {
  if (isInside(claboxHome, configFile)) return 'home';
  const recorded = readTrustStore(claboxHome)[realpath(configFile)];
  if (!recorded) return 'unknown';
  return recorded === hashFile(configFile) ? 'trusted' : 'stale';
}

/** Options for {@link assertConfigTrusted}. */
export interface TrustCheckOptions {
  claboxHome: string;
  /** `--trust` / `CLABOX_TRUST=1` — accept this config for this run only. */
  allow?: boolean;
}

/**
 * Throw unless `configFile` may be `import()`ed. The error names the file, says
 * *why* it's refused and how to accept it — this fires on a legitimate layout
 * (a repo carrying its own boxes) as well as on an attack, and the two look
 * identical from here, so the message has to be actionable rather than scary.
 */
export function assertConfigTrusted(configFile: string, opts: TrustCheckOptions): TrustState {
  const state = configTrustState(configFile, opts.claboxHome);
  if (state === 'home' || state === 'trusted' || opts.allow) return state;
  const why = state === 'stale' ? 'it changed since you trusted it' : 'it is not trusted';
  throw new Error(
    [
      `clabox: refusing to load '${configFile}' — ${why}.`,
      'A config is JS that clabox runs OUTSIDE the sandbox and that defines the',
      'sandbox policy, so a box able to write this tree could have planted it.',
      `Review it, then: clabox trust ${configFile}`,
      '(or --trust for one run, or keep the box under ~/.config/clabox/configs).',
    ].join('\n'),
  );
}

/** Result of {@link trustConfig}. */
export interface TrustRecord {
  file: string;
  hash: string;
}

/**
 * Record `configFile` as trusted at its current content. Writes the store
 * `0600` through a stage+rename, so a crash can't leave a half-written file
 * that would silently de-trust every box.
 */
export function trustConfig(configFile: string, claboxHome: string): TrustRecord {
  const file = realpath(configFile);
  if (!fs.statSync(file).isFile()) throw new Error(`clabox: not a file: ${configFile}`);
  const hash = hashFile(file);
  if (!hash) throw new Error(`clabox: cannot read ${configFile}`);
  const store = { ...readTrustStore(claboxHome), [file]: hash };
  const dest = trustFilePath(claboxHome);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const stage = `${dest}.tmp`;
  fs.writeFileSync(stage, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(stage, dest);
  return { file, hash };
}

/** Drop a config from the trust store. Returns true when it was there. */
export function untrustConfig(configFile: string, claboxHome: string): boolean {
  const file = realpath(configFile);
  const store = readTrustStore(claboxHome);
  if (!(file in store)) return false;
  delete store[file];
  const dest = trustFilePath(claboxHome);
  const stage = `${dest}.tmp`;
  fs.writeFileSync(stage, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(stage, dest);
  return true;
}

/** Every recorded config with whether its content still matches. */
export function listTrusted(claboxHome: string): Array<{ file: string; state: TrustState }> {
  return Object.entries(readTrustStore(claboxHome))
    .map(([file, hash]) => ({
      file,
      state: (hashFile(file) === hash ? 'trusted' : 'stale') as TrustState,
    }))
    .sort((a, b) => a.file.localeCompare(b.file));
}
