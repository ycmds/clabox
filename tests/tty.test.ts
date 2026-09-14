// Tests for the terminal line-discipline guard in `src/sandbox/tty.ts` — the
// `stty -echo` window that keeps claude's own startup probe answers (XTVERSION,
// OSC 11, DA1) from being echoed into its banner.
//
//   bun test

import { describe, expect, test } from 'bun:test';
import { MUTE_ARGS, NO_GUARD, type SttyIo, sttyIo, suppressEcho } from '../src/sandbox/tty.js';

/** Recording `stty` double: every call lands in `calls`, answers come from `reply`. */
function fakeIo(
  reply: (args: string[]) => string | null = () => '',
  isTty = true,
): SttyIo & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    isTty,
    calls,
    run(args) {
      calls.push(args);
      return reply(args);
    },
  };
}

const SAVED = 'gfmt1:cflag=4b00:iflag=2b02:lflag=200005cf:oflag=3';

describe('suppressEcho', () => {
  test('saves the termios, mutes the terminal, and restores exactly what it saved', () => {
    const io = fakeIo((args) => (args[0] === '-g' ? `${SAVED}\n` : ''));
    const guard = suppressEcho(io);
    expect(io.calls).toEqual([['-g'], MUTE_ARGS]);
    guard.restore();
    // Restored with the saved state verbatim (trimmed), not with a bare `echo`.
    expect(io.calls).toEqual([['-g'], MUTE_ARGS, [SAVED]]);
  });

  test('canonical mode is dropped too, or the tty looks like a password prompt', () => {
    // ECHO off + ICANON on is exactly what `read -s`/sudo leave behind, and
    // Ghostty's macos-auto-secure-input reads termios and turns on macOS Secure
    // Input (the padlock) when it sees it. Muting must not imitate that.
    expect(MUTE_ARGS).toContain('-echo');
    expect(MUTE_ARGS).toContain('-icanon');
  });

  test('restore is idempotent — the launcher may call it twice', () => {
    const io = fakeIo((args) => (args[0] === '-g' ? SAVED : ''));
    const guard = suppressEcho(io);
    guard.restore();
    guard.restore();
    expect(io.calls.filter((c) => c[0] === SAVED)).toHaveLength(1);
  });

  test('does nothing when stdin is not a terminal', () => {
    const io = fakeIo(() => '', false);
    expect(suppressEcho(io)).toBe(NO_GUARD);
    expect(io.calls).toEqual([]);
  });

  test('a failing `stty -g` leaves the terminal alone', () => {
    // No saved state means no way back, and a terminal stuck without echo would
    // be far worse than the garbled banner this guards against.
    const io = fakeIo(() => null);
    expect(suppressEcho(io)).toBe(NO_GUARD);
    expect(io.calls).toEqual([['-g']]);
  });

  test('an empty `stty -g` answer is treated as a failure too', () => {
    const io = fakeIo(() => '  \n');
    expect(suppressEcho(io)).toBe(NO_GUARD);
    expect(io.calls).toEqual([['-g']]);
  });

  test('a failing mute yields a guard that restores nothing', () => {
    const io = fakeIo((args) => (args[0] === '-g' ? SAVED : null));
    const guard = suppressEcho(io);
    expect(guard).toBe(NO_GUARD);
    guard.restore();
    expect(io.calls).toEqual([['-g'], MUTE_ARGS]);
  });
});

describe('sttyIo', () => {
  test('CLABOX_TTY_GUARD=0 opts out', () => {
    expect(sttyIo({ CLABOX_TTY_GUARD: '0' }).isTty).toBe(false);
  });

  test('without the opt-out it tracks stdin', () => {
    expect(sttyIo({}).isTty).toBe(Boolean(process.stdin.isTTY));
  });

  test('a failing stty call returns null instead of throwing', () => {
    // `--definitely-not-a-flag` makes the real /bin/stty exit non-zero.
    expect(sttyIo({}).run(['--definitely-not-a-flag'])).toBeNull();
  });
});
