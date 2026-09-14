// Drive a running Ghostty through its AppleScript dictionary, so a box can be
// opened as a tab/window/split of the terminal you're already in — instead of a
// separate cloned `.app`.
//
// Ghostty ships `Ghostty.sdef` (verified on 1.3.1) with a `surface
// configuration` record — `command`, `initial working directory`, `initial
// input`, `environment variables`, `font size`, `wait after command` — plus
// `new window`, `new tab`, `split`, `focus`, `input text`, `send key` and
// `perform action`. That's everything needed to launch a box surface exactly the
// way the generated app config does.
//
// The script text is built purely (and unit-tested); `runAppleScript` is the
// only I/O, and `osascript` runs **outside** any box — it is a user-facing
// convenience command, not something a sandboxed agent can reach (Seatbelt
// denies both the binary and the Apple-events mach service).

import { execFileSync } from 'node:child_process';

/** Bundle id of the stock Ghostty; a cloned box app has its own. */
export const GHOSTTY_BUNDLE_ID = 'com.mitchellh.ghostty';

/** Where a box surface should be opened. */
export type SurfaceMode = 'tab' | 'window' | 'split';

/** Split directions Ghostty's `split direction` enumeration accepts. */
export const SPLIT_DIRECTIONS = ['right', 'left', 'down', 'up'] as const;

/** One of {@link SPLIT_DIRECTIONS}. */
export type SplitDirection = (typeof SPLIT_DIRECTIONS)[number];

/** Inputs for {@link buildOpenScript}. */
export interface OpenSurfaceOptions {
  /** Shell command the surface runs — `init/ghostty.ts#buildShellCommand`. */
  command: string;
  /** Working directory for the new surface. null → Ghostty's default. */
  cwd?: string | null;
  /** tab (default) / window / split of the focused surface. */
  mode?: SurfaceMode;
  /** Direction for `mode: 'split'`. Default `right`. */
  direction?: SplitDirection;
  /** Target app — override to address a cloned box app by its own bundle id. */
  bundleId?: string;
  /** Bring Ghostty to the front first. Default true. */
  activate?: boolean;
  /** Text typed into the surface after launch (Ghostty's `initial input`). */
  input?: string | null;
}

/**
 * Quote a value as an AppleScript string literal. Only `\` and `"` are special
 * inside one; control characters are dropped rather than escaped, since a raw
 * newline would end the statement and an ESC could smuggle a second command into
 * the script we hand to `osascript`.
 */
export function asQuote(value: string): string {
  const clean = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: injection guard
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
  return `"${clean}"`;
}

/**
 * Build the AppleScript that opens a box surface.
 *
 * `split` targets the focused terminal of the front window — Ghostty's `split`
 * takes a terminal specifier, so there has to *be* a window; with none open the
 * script falls back to a new window rather than failing, which is what anyone
 * typing `clabox tab` from a detached shell expects.
 */
export function buildOpenScript({
  command,
  cwd = null,
  mode = 'tab',
  direction = 'right',
  bundleId = GHOSTTY_BUNDLE_ID,
  activate = true,
  input = null,
}: OpenSurfaceOptions): string {
  const body: string[] = [];
  if (activate) body.push('activate');
  body.push('set cfg to new surface configuration');
  body.push(`set command of cfg to ${asQuote(command)}`);
  if (cwd) body.push(`set initial working directory of cfg to ${asQuote(cwd)}`);
  if (input) body.push(`set initial input of cfg to ${asQuote(input)}`);
  // Keep the surface open if the command exits, so a crash is readable instead
  // of a window that vanishes.
  body.push('set wait after command of cfg to true');

  if (mode === 'window') {
    body.push('new window with configuration cfg');
  } else if (mode === 'tab') {
    body.push('new tab with configuration cfg');
  } else {
    body.push('if (count of windows) is 0 then');
    body.push('\tnew window with configuration cfg');
    body.push('else');
    body.push('\tset target to focused terminal of selected tab of front window');
    body.push(`\tsplit target direction ${direction} with configuration cfg`);
    body.push('end if');
  }

  return [
    `tell application id ${asQuote(bundleId)}`,
    ...body.map((l) => `\t${l}`),
    'end tell',
  ].join('\n');
}

/** Result of {@link runAppleScript}. */
export interface AppleScriptResult {
  ok: boolean;
  /** osascript's stdout on success, its stderr on failure. */
  output: string;
}

/**
 * Run a script through `osascript`. Never throws: a missing Ghostty, a refused
 * automation permission or a syntax error all come back as `{ ok: false }` with
 * the message, which the CLI prints.
 */
export function runAppleScript(script: string): AppleScriptResult {
  try {
    const out = execFileSync('osascript', ['-e', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, output: out.trim() };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, output: (err.stderr ?? err.message ?? 'osascript failed').trim() };
  }
}
