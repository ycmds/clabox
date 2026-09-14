// Tests for the terminal-tab decoration in `src/sandbox/tab.ts` — the OSC
// sequences that make a `--rc` tab (Remote Control reachable, feature flags on)
// look different from a private tab of the same box.
//
//   bun test

import { describe, expect, test } from 'bun:test';
import { buildTabDecor, normalizeColor, shortenHome, tabTitle } from '../src/sandbox/tab.js';
import { type Config, defaultConfig, HOME } from '../src/utils/config.js';

function cfg(over: Partial<Config> = {}): Config {
  return { ...defaultConfig, configDir: '/cfg', cwd: '/proj/box', ...over };
}

describe('normalizeColor', () => {
  test('accepts #rgb / #rrggbb and expands the short form', () => {
    expect(normalizeColor('#2A1A12')).toBe('#2a1a12');
    expect(normalizeColor('2a1a12')).toBe('#2a1a12');
    expect(normalizeColor('#f0a')).toBe('#ff00aa');
  });

  test('accepts a bare X11 color name', () => {
    expect(normalizeColor('MidnightBlue')).toBe('midnightblue');
  });

  test('rejects anything that could break out of the OSC string', () => {
    // Cosmetics must never be an injection point into the terminal stream.
    expect(normalizeColor('#2a1a12\x07ls')).toBeNull();
    expect(normalizeColor('\x1b]0;pwned\x07')).toBeNull();
    expect(normalizeColor('#12345')).toBeNull();
    expect(normalizeColor('')).toBeNull();
    expect(normalizeColor(null)).toBeNull();
  });
});

describe('tabTitle / shortenHome', () => {
  test('the project dir is shortened with ~', () => {
    expect(shortenHome(`${HOME}/projects/app`)).toBe('~/projects/app');
    expect(shortenHome('/opt/app')).toBe('/opt/app');
  });

  test('a badge is prefixed, and control chars are stripped from both', () => {
    expect(tabTitle('~/app', '📡 rc')).toBe('📡 rc ~/app');
    expect(tabTitle('~/app', '')).toBe('~/app');
    expect(tabTitle('~/a\x07pp', '\x1b]0;x')).toBe(']0;x ~/app');
  });
});

describe('buildTabDecor', () => {
  test('a plain run keeps the terminal colors and only sets the title', () => {
    const d = buildTabDecor(cfg(), { projectDir: '/proj/box' });
    expect(d.title).toBe('/proj/box');
    expect(d.background).toBeNull();
    expect(d.enter).toBe('\x1b]0;/proj/box\x07');
    expect(d.leave).toBe('');
  });

  test('--rc badges the title and repaints bg + cursor, with resets to undo both', () => {
    // The default `--rc` look: a warm background *and* a bright cursor, because
    // a background alone is washed out by background-opacity/blur.
    const d = buildTabDecor(cfg(), { projectDir: '/proj/box', rc: true });
    expect(d.title).toBe('📡 RC /proj/box');
    expect(d.background).toBe('#5c1a00');
    expect(d.cursor).toBe('#ff8c1a');
    expect(d.foreground).toBeNull();
    expect(d.enter).toBe('\x1b]0;📡 RC /proj/box\x07\x1b]11;#5c1a00\x07\x1b]12;#ff8c1a\x07');
    // OSC 111 / 112 = reset background / cursor, in the same order they were set.
    expect(d.leave).toBe('\x1b]111\x07\x1b]112\x07');
  });

  test('foreground (OSC 10) is supported too, and reset with OSC 110', () => {
    const c = cfg({ tab: { rcForeground: '#ffe9d6', rcBackground: null, rcCursor: null } });
    const d = buildTabDecor(c, { projectDir: '/p', rc: true });
    expect(d.foreground).toBe('#ffe9d6');
    expect(d.enter).toBe('\x1b]0;/p\x07\x1b]10;#ffe9d6\x07');
    expect(d.leave).toBe('\x1b]110\x07');
  });

  test('a plain run ignores every rc* color', () => {
    const c = cfg({ tab: { rcBackground: '#5c1a00', rcCursor: '#ff8c1a', rcForeground: '#fff' } });
    const d = buildTabDecor(c, { projectDir: '/p' });
    expect(d).toMatchObject({ background: null, cursor: null, foreground: null, leave: '' });
  });

  test('a box can set its own title/colors; rcBackground wins for --rc', () => {
    const c = cfg({
      tab: { title: '🐈‍⬛ AX', rcBadge: '· RC', background: '#0d1117', rcBackground: '#3a1020' },
    });
    expect(buildTabDecor(c, { projectDir: '/proj/box' })).toMatchObject({
      title: '🐈‍⬛ AX',
      background: '#0d1117',
    });
    expect(buildTabDecor(c, { projectDir: '/proj/box', rc: true })).toMatchObject({
      title: '· RC 🐈‍⬛ AX',
      background: '#3a1020',
    });
  });

  test('without rcBackground, --rc falls back to the box background', () => {
    const c = cfg({ tab: { background: '#0d1117', rcBackground: null } });
    expect(buildTabDecor(c, { projectDir: '/p', rc: true }).background).toBe('#0d1117');
  });

  test('cursor falls back to the box cursor, and nulls everywhere leave the terminal alone', () => {
    const withCursor = cfg({ tab: { cursor: '#58a6ff', rcCursor: null, rcBackground: null } });
    expect(buildTabDecor(withCursor, { projectDir: '/p', rc: true }).cursor).toBe('#58a6ff');

    const c = cfg({ tab: { rcBadge: null, rcBackground: null, rcCursor: null } });
    const d = buildTabDecor(c, { projectDir: '/p', rc: true });
    expect(d.enter).toBe('\x1b]0;/p\x07');
    expect(d.leave).toBe('');
  });

  test('a config without `tab` at all still works (optional field)', () => {
    const c = cfg();
    c.tab = undefined;
    expect(buildTabDecor(c, { projectDir: '/p', rc: true })).toEqual({
      enter: '\x1b]0;/p\x07',
      leave: '',
      title: '/p',
      background: null,
      foreground: null,
      cursor: null,
    });
  });
});
