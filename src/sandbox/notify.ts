// Desktop notifications, tab progress and the bell — from *inside* the sandbox,
// using nothing but bytes written to the terminal.
//
// Why this exists: Notification Center is unreachable from a box. A hook that
// shells out to `terminal-notifier` hangs (wedging every later Stop hook), and
// `osascript display notification` dies with "NSNotificationCenter connection
// invalid" — both need mach services that a sandboxed process can't get. But the
// terminal emulator is *outside* the sandbox and already listening on a file the
// profile grants: the tty. Ghostty (verified on 1.3.1) implements
//
//   - OSC 777 `notify`      → a real macOS notification banner,
//   - OSC 9;4 (ConEmu)      → the progress indicator on the tab/dock,
//   - BEL                   → bell, i.e. `bell-features` (attention/dock bounce),
//
// so writing a handful of bytes gets all three with zero extra grants. kitty,
// WezTerm and iTerm2 understand OSC 777/9 too; a terminal that doesn't simply
// ignores the sequence.
//
// The one catch: a hook's stdout is captured by claude, so printing to stdout
// reaches nobody. The sequences must go to `/dev/tty` — which the profile grants
// read+write (`^/dev/(tty.*|null|zero|dtracehelper)`), so nothing new is opened
// up. `2>/dev/null || true` keeps a headless run (`claude -p`, no controlling
// terminal) from failing the hook.
//
// Pure builders only — `sandbox/extras.ts` folds the result into the box's
// compiled `--settings` file.

import type { HooksConfig, NotifyConfig } from '../utils/config.js';

/** Where the sequences are written — the one terminal fd a box always has. */
export const NOTIFY_TTY = '/dev/tty';

/** ConEmu/OSC 9;4 progress states, as understood by Ghostty's tab indicator. */
export const PROGRESS_STATES = {
  /** Remove the indicator. */
  clear: 0,
  /** Determinate, `percent` filled. */
  normal: 1,
  /** Red — something failed. */
  error: 2,
  /** Barber-pole; percent is ignored. */
  indeterminate: 3,
  /** Yellow — stalled, waiting on someone. */
  paused: 4,
} as const;

/** Name of a {@link PROGRESS_STATES} entry. */
export type ProgressState = keyof typeof PROGRESS_STATES;

/**
 * Make a string safe to carry inside an OSC payload: drop the control chars that
 * would end (or escape out of) the sequence, turn `;` — the field separator —
 * into a comma, and cap the length so a runaway value can't paint the screen.
 */
export function sanitizeOscText(text: string, max = 200): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
      .replace(/[\x00-\x1f\x7f]/g, ' ')
      .replace(/;/g, ',')
      .trim()
      .slice(0, max)
  );
}

/** OSC 777 desktop notification, BEL-terminated (no backslash to re-escape). */
export function notifySeq(title: string, body: string): string {
  return `\x1b]777;notify;${sanitizeOscText(title)};${sanitizeOscText(body)}\x07`;
}

/** OSC 9;4 progress report — `clear` needs no percent, the rest clamp to 0–100. */
export function progressSeq(state: ProgressState, percent = 0): string {
  const code = PROGRESS_STATES[state];
  const pct = Math.max(0, Math.min(100, Math.round(percent) || 0));
  return code === PROGRESS_STATES.clear ? `\x1b]9;4;0\x07` : `\x1b]9;4;${code};${pct}\x07`;
}

/** The bell — `bell-features` decides whether that's a sound, a tab mark, both. */
export const BELL = '\x07';

/**
 * Wrap raw escape sequences into a shell command that writes them to the tty.
 *
 * Everything is funnelled through a single-quoted `printf` format string, so the
 * escaping has to happen in this order: backslashes first (before we introduce
 * our own), then `%` (printf's own metacharacter), then the control bytes as
 * octal/`\a`, then the single quote. `|| true` because a cosmetic hook must
 * never fail the event it's attached to.
 */
export function ttyWrite(seq: string, tty: string = NOTIFY_TTY): string {
  const fmt = seq
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '%%')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC/BEL are the payload
    .replace(/\x1b/g, '\\033')
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC/BEL are the payload
    .replace(/\x07/g, '\\a')
    .replace(/'/g, `'\\''`);
  return `printf '${fmt}' > ${tty} 2>/dev/null || true`;
}

/** Default banner title when the box doesn't set one: `Claude · <box>`. */
export function defaultNotifyTitle(slug: string): string {
  return slug ? `Claude · ${slug}` : 'Claude';
}

/** One `settings.json` hook entry running `command`. */
function hookEntry(command: string) {
  return [{ hooks: [{ type: 'command' as const, command }] }];
}

/**
 * Compile `config.notify` into claude hooks.
 *
 * Two events, because they mean opposite things to whoever stepped away:
 * **Stop** (the reply landed — banner + bell, and the progress indicator is
 * cleared) and **Notification** (claude is blocked on you — banner + bell, and
 * the tab goes yellow via the `paused` progress state, which survives being
 * tabbed away from in a way a banner doesn't). A `null` body switches that event
 * off; `enabled: false` returns `{}` and nothing is injected at all.
 */
export function buildNotifyHooks(notify: NotifyConfig | undefined, slug = ''): HooksConfig {
  if (!notify?.enabled) return {};
  const title = notify.title ?? defaultNotifyTitle(slug);
  const hooks: HooksConfig = {};

  const compose = (body: string | null | undefined, progress: ProgressState) => {
    const parts: string[] = [];
    if (body) parts.push(notifySeq(title, body));
    if (notify.progress) parts.push(progressSeq(progress));
    if (notify.bell) parts.push(BELL);
    return parts.length ? ttyWrite(parts.join('')) : null;
  };

  const stop = compose(notify.stop, 'clear');
  if (stop) hooks.Stop = hookEntry(stop);
  const waiting = compose(notify.waiting, 'paused');
  if (waiting) hooks.Notification = hookEntry(waiting);
  return hooks;
}

/**
 * Merge hook maps left-to-right, concatenating the matchers of an event both
 * sides define. A box's own `hooks` must keep running (the `afplay` pings people
 * already rely on), so the injected notification is an addition, never a
 * replacement.
 */
export function mergeHooks(...maps: (HooksConfig | undefined)[]): HooksConfig {
  const out: HooksConfig = {};
  for (const map of maps) {
    for (const [event, matchers] of Object.entries(map ?? {})) {
      out[event] = [...(out[event] ?? []), ...matchers];
    }
  }
  return out;
}
