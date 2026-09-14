// Tests for `src/sandbox/notify.ts` — the in-sandbox notification channel:
// OSC 777 banners, OSC 9;4 tab progress and the bell, compiled into claude hooks
// that write to /dev/tty (the only terminal fd a box is granted).
//
//   bun test

import { describe, expect, test } from 'bun:test';
import {
  BELL,
  buildNotifyHooks,
  defaultNotifyTitle,
  mergeHooks,
  notifySeq,
  progressSeq,
  sanitizeOscText,
  ttyWrite,
} from '../src/sandbox/notify.js';
import type { HooksConfig, NotifyConfig } from '../src/utils/config.js';

const ESC = '\x1b';
const BEL = '\x07';

function notify(over: Partial<NotifyConfig> = {}): NotifyConfig {
  return { enabled: true, stop: 'done', waiting: 'your turn', progress: true, bell: true, ...over };
}

describe('sanitizeOscText', () => {
  test('drops control chars and neutralizes the field separator', () => {
    // A `;` would split the payload into extra OSC fields; ESC/BEL would end it.
    expect(sanitizeOscText('a;b')).toBe('a,b');
    expect(sanitizeOscText(`x${ESC}]0;pwned${BEL}y`)).toBe('x ]0,pwned y');
  });

  test('caps the length', () => {
    expect(sanitizeOscText('x'.repeat(500)).length).toBe(200);
    expect(sanitizeOscText('xyz', 2)).toBe('xy');
  });
});

describe('notifySeq / progressSeq', () => {
  test('OSC 777 notify, BEL-terminated', () => {
    expect(notifySeq('Claude · ax', 'done')).toBe(`${ESC}]777;notify;Claude · ax;done${BEL}`);
  });

  test('progress states map to the ConEmu codes, clear carries no percent', () => {
    expect(progressSeq('clear')).toBe(`${ESC}]9;4;0${BEL}`);
    expect(progressSeq('paused')).toBe(`${ESC}]9;4;4;0${BEL}`);
    expect(progressSeq('normal', 42)).toBe(`${ESC}]9;4;1;42${BEL}`);
  });

  test('percent is clamped and rounded', () => {
    expect(progressSeq('normal', 999)).toBe(`${ESC}]9;4;1;100${BEL}`);
    expect(progressSeq('normal', -5)).toBe(`${ESC}]9;4;1;0${BEL}`);
    expect(progressSeq('normal', 12.6)).toBe(`${ESC}]9;4;1;13${BEL}`);
  });
});

describe('ttyWrite', () => {
  test('renders the sequence as printf escapes aimed at /dev/tty', () => {
    expect(ttyWrite(`${ESC}]9;4;0${BEL}`)).toBe(
      "printf '\\033]9;4;0\\a' > /dev/tty 2>/dev/null || true",
    );
  });

  test('escapes printf and shell metacharacters in the payload', () => {
    // `%` would be a printf format spec, `'` would end the quoted format, and a
    // literal backslash must survive as one.
    const cmd = ttyWrite(notifySeq('100%', "it's \\ fine"));
    expect(cmd).toContain('100%%');
    expect(cmd).toContain(`it'\\''s`);
    expect(cmd).toContain('\\\\');
    // Nothing raw escapes into the command — printf re-creates the bytes.
    expect(cmd).not.toContain(ESC);
    expect(cmd).not.toContain(BEL);
  });
});

describe('buildNotifyHooks', () => {
  test('disabled (the default) injects nothing', () => {
    expect(buildNotifyHooks(undefined, 'ax')).toEqual({});
    expect(buildNotifyHooks(notify({ enabled: false }), 'ax')).toEqual({});
  });

  test('Stop clears the progress, Notification parks it at paused', () => {
    const hooks = buildNotifyHooks(notify(), 'ax');
    const stop = hooks.Stop?.[0].hooks[0].command ?? '';
    const wait = hooks.Notification?.[0].hooks[0].command ?? '';
    expect(stop).toContain('777;notify;Claude · ax;done');
    expect(stop).toContain('9;4;0'); // cleared
    expect(wait).toContain('777;notify;Claude · ax;your turn');
    expect(wait).toContain('9;4;4;0'); // paused → yellow tab
    // Both ring the bell, and both are shielded from failing the event.
    expect(stop.endsWith('|| true')).toBe(true);
    expect(wait).toContain('\\a');
  });

  test('a null body switches that event off entirely', () => {
    const hooks = buildNotifyHooks(notify({ stop: null, progress: false, bell: false }), 'ax');
    expect(hooks.Stop).toBeUndefined();
    expect(hooks.Notification).toBeDefined();
  });

  test('progress/bell can be used without any banner text', () => {
    const hooks = buildNotifyHooks(
      notify({ stop: null, waiting: null, progress: true, bell: false }),
      'ax',
    );
    // No body and no bell, but progress still wants both events marked.
    expect(hooks.Stop?.[0].hooks[0].command).toContain('9;4;0');
    expect(hooks.Stop?.[0].hooks[0].command).not.toContain('777');
  });

  test('an explicit title wins over the box slug', () => {
    const hooks = buildNotifyHooks(notify({ title: 'BOX' }), 'ax');
    expect(hooks.Stop?.[0].hooks[0].command).toContain('777;notify;BOX;done');
    expect(defaultNotifyTitle('')).toBe('Claude');
  });

  test('BEL is the plain bell byte', () => {
    expect(BELL).toBe(BEL);
  });
});

describe('mergeHooks', () => {
  test('concatenates matchers per event instead of replacing them', () => {
    const a: HooksConfig = { Stop: [{ hooks: [{ type: 'command', command: 'afplay ping' }] }] };
    const b: HooksConfig = { Stop: [{ hooks: [{ type: 'command', command: 'printf x' }] }] };
    const merged = mergeHooks(a, b);
    expect(merged.Stop).toHaveLength(2);
    expect(merged.Stop?.[0].hooks[0].command).toBe('afplay ping');
    expect(merged.Stop?.[1].hooks[0].command).toBe('printf x');
  });

  test('undefined maps are skipped', () => {
    expect(mergeHooks(undefined, undefined)).toEqual({});
  });
});
