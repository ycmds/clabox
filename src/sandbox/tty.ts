// Line-discipline guard for the handoff of the terminal to `claude`.
//
// What it fixes: claude probes the terminal at startup — XTVERSION (`CSI > 0 q`),
// an OSC 11 background query for light/dark detection, and a DA1 (`CSI c`) flush
// sentinel — and reads the answers back off stdin. Those answers are *input*: if
// they arrive while the tty is still in canonical mode with ECHO on — the window
// before claude has raw mode up, which is wider in a box because every startup
// read goes through Seatbelt — the line discipline prints them instead of claude
// consuming them, and the banner comes out as
//
//     ^[P>|ghosttClaude1Code[v2.1.26352c  ▐▛███▛█
//
// i.e. the terminal's own replies (ESC rendered as `^[` by ECHOCTL) interleaved
// with the welcome box. Ghostty answers in microseconds, so it shows up there
// first — a slower terminal tends to reply after claude is already in raw mode.
//
// The launcher owns the terminal right up to the handoff, so it can close that
// window: mute the terminal before spawning (see MUTE_ARGS — echo *and* canonical
// mode, so it doesn't imitate a password prompt) and put the saved termios back
// afterwards.
// Two bonuses: libuv snapshots the tty state on claude's *first* `setRawMode`,
// so claude's own raw-mode toggles (early input capture → Ink mount) restore our
// echo-less state instead of a noisy one; and a claude that dies without
// restoring the terminal no longer leaves the shell mute, because the restore
// happens here.
//
// Same rule as the tab decoration: this is cosmetics around a launch and must
// never fail one, so every `stty` error degrades to a no-op guard.

import { execFileSync } from 'node:child_process';

/** Undo handle returned by {@link suppressEcho}. Idempotent. */
export interface TtyGuard {
  /** Put the saved terminal settings back. Safe to call more than once. */
  restore(): void;
}

/** The `stty` calls {@link suppressEcho} needs, injected so it stays testable. */
export interface SttyIo {
  /** stdin is a real terminal — there's nothing to guard otherwise. */
  isTty: boolean;
  /** Run `stty` with these args against the terminal; stdout, or null if it failed. */
  run(args: string[]): string | null;
}

/** Guard that does nothing — used whenever there's no terminal to protect. */
export const NO_GUARD: TtyGuard = { restore() {} };

/**
 * How the terminal is muted for the handoff: echo off **and** canonical mode off.
 *
 * `-icanon` is not optional. ECHO off *with* ICANON on is the exact termios
 * signature of a password prompt (`read -s`, `sudo`), and terminal emulators
 * watch for it: Ghostty's `macos-auto-secure-input` (on by default) calls
 * `tcgetattr` on the pty, decides a password is being typed and turns on macOS
 * **Secure Input** — `EnableSecureEventInput`, the padlock in the title bar,
 * which blocks every app from reading keyboard events (and, per Ghostty's own
 * docs, interferes with accessibility software). A plain `stty -echo` guard
 * therefore made every box launch look like a password prompt. Dropping ICANON
 * too makes the window look like what it actually is — a TUI about to take the
 * terminal — which no emulator flags. ISIG stays on, so Ctrl+C still works in
 * the handful of milliseconds before claude sets its own raw mode.
 */
export const MUTE_ARGS = ['-echo', '-icanon'];

/**
 * Mute the terminal for the duration of the launch ({@link MUTE_ARGS}), returning
 * the handle that restores it exactly as it was (`stty -g` → `stty <state>`).
 *
 * Degrades to {@link NO_GUARD} when stdin isn't a tty or `stty` is unavailable:
 * without a saved state we'd have nothing to restore, and leaving a terminal
 * mute would be far worse than the garbled banner we're preventing.
 */
export function suppressEcho(io: SttyIo): TtyGuard {
  if (!io.isTty) return NO_GUARD;
  const saved = io.run(['-g'])?.trim();
  if (!saved) return NO_GUARD;
  // Prints nothing on success, so only a null (thrown) result is a failure.
  if (io.run(MUTE_ARGS) === null) return NO_GUARD;
  let done = false;
  return {
    restore() {
      if (done) return;
      done = true;
      io.run([saved]);
    },
  };
}

/**
 * The real `stty`, talking to the inherited terminal on fd 0. `CLABOX_TTY_GUARD=0`
 * opts out (the escape hatch for a terminal where touching the line settings
 * misbehaves — the only cost is the garbled startup banner coming back).
 */
export function sttyIo(env: NodeJS.ProcessEnv = process.env): SttyIo {
  return {
    isTty: Boolean(process.stdin.isTTY) && env.CLABOX_TTY_GUARD !== '0',
    run(args: string[]): string | null {
      try {
        // stdin inherited: `stty` reads/writes the settings of *this* terminal.
        return execFileSync('/bin/stty', args, {
          stdio: ['inherit', 'pipe', 'ignore'],
          encoding: 'utf8',
        });
      } catch {
        return null;
      }
    },
  };
}
