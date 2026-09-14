// Tests for `src/sandbox/applescript.ts` — the AppleScript that opens a box as a
// tab/window/split of the *running* Ghostty (its scripting dictionary, verified
// against Ghostty 1.3.1's Ghostty.sdef).
//
//   bun test

import { describe, expect, test } from 'bun:test';
import {
  asQuote,
  buildOpenScript,
  GHOSTTY_BUNDLE_ID,
  SPLIT_DIRECTIONS,
} from '../src/sandbox/applescript.js';

describe('asQuote', () => {
  test('escapes the two characters AppleScript treats as special', () => {
    expect(asQuote('plain')).toBe('"plain"');
    expect(asQuote('say "hi"')).toBe('"say \\"hi\\""');
    expect(asQuote('C:\\path')).toBe('"C:\\\\path"');
  });

  test('control characters are dropped, not escaped', () => {
    // A raw newline would end the statement and let the rest be read as its own
    // AppleScript command — the string must never be able to break out.
    expect(asQuote('a\nb\tc')).toBe('"a b c"');
    expect(asQuote('x\x1b]0;y')).toBe('"x ]0;y"');
  });
});

describe('buildOpenScript', () => {
  const base = { command: "zsh -lic 'clabox -b ax'", cwd: '/proj/ax' };

  test('a tab: configure a surface, then `new tab`', () => {
    const s = buildOpenScript(base);
    expect(s.startsWith(`tell application id "${GHOSTTY_BUNDLE_ID}"`)).toBe(true);
    expect(s).toContain('activate');
    expect(s).toContain('set cfg to new surface configuration');
    expect(s).toContain(`set command of cfg to "zsh -lic 'clabox -b ax'"`);
    expect(s).toContain('set initial working directory of cfg to "/proj/ax"');
    // Keep a crashed launch readable instead of closing the surface instantly.
    expect(s).toContain('set wait after command of cfg to true');
    expect(s).toContain('new tab with configuration cfg');
    expect(s.endsWith('end tell')).toBe(true);
  });

  test('--window uses `new window`', () => {
    expect(buildOpenScript({ ...base, mode: 'window' })).toContain(
      'new window with configuration cfg',
    );
  });

  test('--split targets the focused terminal and falls back to a window', () => {
    const s = buildOpenScript({ ...base, mode: 'split', direction: 'down' });
    expect(s).toContain('set target to focused terminal of selected tab of front window');
    expect(s).toContain('split target direction down with configuration cfg');
    // With no window open there is no terminal to split — don't fail, open one.
    expect(s).toContain('if (count of windows) is 0 then');
    expect(s).toContain('new window with configuration cfg');
  });

  test('every documented split direction is accepted', () => {
    for (const d of SPLIT_DIRECTIONS) {
      expect(buildOpenScript({ ...base, mode: 'split', direction: d })).toContain(
        `direction ${d} `,
      );
    }
  });

  test('a box app is addressed by its own bundle id', () => {
    const s = buildOpenScript({ ...base, bundleId: 'com.ghostty.custom.ax' });
    expect(s).toContain('tell application id "com.ghostty.custom.ax"');
  });

  test('optional bits are omitted when unset', () => {
    const s = buildOpenScript({ command: 'clabox', cwd: null, activate: false });
    expect(s).not.toContain('activate');
    expect(s).not.toContain('initial working directory');
    expect(s).not.toContain('initial input');
  });

  test('initial input is passed through when asked for', () => {
    expect(buildOpenScript({ ...base, input: '/rc\n' })).toContain(
      'set initial input of cfg to "/rc "',
    );
  });
});
