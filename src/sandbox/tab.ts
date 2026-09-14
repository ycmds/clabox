// Terminal-tab decoration — pure builders for the OSC escape sequences the
// launcher writes around a run, so one tab is visually distinguishable from
// another (the motivating case: a `--rc` tab talks to Remote Control and is not
// private, a plain tab is — and they otherwise look identical).
//
// The knobs are all optional and all live under `config.tab`:
//   - the **title** (OSC 0) — free, but claude rewrites it as it works (unless
//     the box exports `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`), so it's a hint;
//   - the **background color** (OSC 11, reset with OSC 111) — survives whatever
//     claude prints, which is what makes it the actual indicator. On macOS
//     Ghostty the native tab takes the surface background, so this is literally
//     the tab's color;
//   - the **foreground** (OSC 10 / 110) and the **cursor** (OSC 12 / 112) — the
//     loud part of an `--rc` tab: a background gets washed out by
//     `background-opacity`/blur, while a bright blinking cursor does not.
//
// Everything here is pure text; `sandbox/run.ts` decides whether to write it
// (only onto a real TTY) and restores the terminal afterwards.

import { type Config, HOME } from '../utils/config.js';

/** The sequences to write around a run, plus what they resolved to. */
export interface TabDecor {
  /** Written before launching claude (title + whichever colors resolved). */
  enter: string;
  /** Written after it exits — resets exactly the colors we set. `''` when none. */
  leave: string;
  /** Resolved tab title (badge included). */
  title: string;
  /** Resolved background, or null when the terminal's own is left alone. */
  background: string | null;
  /** Resolved foreground, or null when the terminal's own is left alone. */
  foreground: string | null;
  /** Resolved cursor color, or null when the terminal's own is left alone. */
  cursor: string | null;
}

/** Options for {@link buildTabDecor}. */
export interface TabDecorOptions {
  /** Effective project dir — the default title. */
  projectDir: string;
  /** `--rc` was passed: use the rc badge/background instead. */
  rc?: boolean;
}

const HEX = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const NAMED = /^[a-zA-Z]{3,24}$/;

/**
 * Normalize a user-supplied color to something safe to embed in an OSC string:
 * `#rgb` / `#rrggbb` (expanded to the 6-digit form) or a bare X11 color name
 * (`black`, `midnightblue`). Anything else — including anything carrying an
 * `ESC`/`BEL` that could break out of the sequence — returns null, i.e. "leave
 * the terminal alone". Cosmetics never fail a launch, so a typo is ignored
 * rather than thrown.
 */
export function normalizeColor(value: string | null | undefined): string | null {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  const hex = HEX.exec(raw);
  if (hex) {
    const body = hex[1].toLowerCase();
    return `#${body.length === 3 ? [...body].map((c) => c + c).join('') : body}`;
  }
  return NAMED.test(raw) ? raw.toLowerCase() : null;
}

/** Strip the control chars that would terminate (or escape) an OSC string. */
function sanitize(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
  return text.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** `~`-shortened project dir — the default tab title. */
export function shortenHome(dir: string): string {
  return dir.startsWith(HOME) ? `~${dir.slice(HOME.length)}` : dir;
}

/** Compose the tab title: an optional badge in front of the base title. */
export function tabTitle(base: string, badge?: string | null): string {
  const b = sanitize(badge ?? '');
  return b ? `${b} ${sanitize(base)}` : sanitize(base);
}

/**
 * Build the escape sequences for this run. `config.tab.rcBadge` /
 * `config.tab.rcBackground` win over `title` / `background` when `rc` is set —
 * that's the whole point: the tab you launched with `--rc` looks different from
 * the same box launched without it.
 */
export function buildTabDecor(config: Config, { projectDir, rc }: TabDecorOptions): TabDecor {
  const tab = config.tab ?? {};
  const base = tab.title ? sanitize(tab.title) : shortenHome(projectDir);
  const title = tabTitle(base, rc ? tab.rcBadge : null);
  /** `rc*` wins for an `--rc` launch and falls back to the plain field when null. */
  const pick = (rcValue: string | null | undefined, plain: string | null | undefined) =>
    normalizeColor(rc ? (rcValue ?? plain) : plain);
  const background = pick(tab.rcBackground, tab.background);
  const foreground = pick(tab.rcForeground, tab.foreground);
  const cursor = pick(tab.rcCursor, tab.cursor);
  // BEL-terminated OSC, matching what the launcher has always written for the
  // title (understood by Ghostty, iTerm2, kitty, WezTerm, Terminal.app …).
  // Each color has a paired reset one hundred codes up: 11→111, 10→110, 12→112.
  const colors: [number, string | null][] = [
    [11, background],
    [10, foreground],
    [12, cursor],
  ];
  const set = colors.filter(([, v]) => v).map(([code, v]) => `\x1b]${code};${v}\x07`);
  const reset = colors.filter(([, v]) => v).map(([code]) => `\x1b]${code + 100}\x07`);
  return {
    enter: `\x1b]0;${title}\x07${set.join('')}`,
    leave: reset.join(''),
    title,
    background,
    foreground,
    cursor,
  };
}
