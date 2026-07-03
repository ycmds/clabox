// Tests for named "box" resolution — the `clabox --box <name>` / `-b` flag.
//
//   bun test
//
// Boxes live in a global configs dir (default ~/.config/clabox/configs,
// overridable via CLABOX_CONFIGS_DIR). These tests use a throwaway tmp dir.

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { configsDir, listBoxes, resolveBox } from '../src/utils/config.js';

/** Make a tmp configs dir seeded with the given filenames. */
function seedConfigs(files: string[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-box-'));
  for (const f of files) fs.writeFileSync(path.join(dir, f), 'export default {}');
  return dir;
}

describe('configsDir', () => {
  test('defaults to ~/.config/clabox/configs with ~ expanded', () => {
    const prev = process.env.CLABOX_CONFIGS_DIR;
    delete process.env.CLABOX_CONFIGS_DIR;
    try {
      expect(configsDir()).toBe(path.join(os.homedir(), '.config', 'clabox', 'configs'));
    } finally {
      if (prev !== undefined) process.env.CLABOX_CONFIGS_DIR = prev;
    }
  });

  test('honors CLABOX_CONFIGS_DIR (with ~ expansion)', () => {
    const prev = process.env.CLABOX_CONFIGS_DIR;
    process.env.CLABOX_CONFIGS_DIR = '~/boxes';
    try {
      expect(configsDir()).toBe(path.join(os.homedir(), 'boxes'));
    } finally {
      if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
      else process.env.CLABOX_CONFIGS_DIR = prev;
    }
  });
});

describe('listBoxes', () => {
  test('lists sorted names from both extensions and skips _partials/other files', () => {
    const dir = seedConfigs([
      'ax.config.mjs',
      'ax-root.mjs',
      'smrmg.config.mjs',
      '_presets.mjs',
      'README.md',
    ]);
    try {
      expect(listBoxes(dir)).toEqual(['ax', 'ax-root', 'smrmg']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('de-duplicates a name present as both .config.mjs and .mjs', () => {
    const dir = seedConfigs(['ax.config.mjs', 'ax.mjs']);
    try {
      expect(listBoxes(dir)).toEqual(['ax']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('returns [] for a missing dir', () => {
    expect(listBoxes('/no/such/clabox/configs/dir')).toEqual([]);
  });
});

describe('resolveBox', () => {
  test('resolves <name>.config.mjs', () => {
    const dir = seedConfigs(['ismg.config.mjs']);
    try {
      expect(resolveBox('ismg', dir)).toBe(path.join(dir, 'ismg.config.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to a bare <name>.mjs', () => {
    const dir = seedConfigs(['ax-root.mjs']);
    try {
      expect(resolveBox('ax-root', dir)).toBe(path.join(dir, 'ax-root.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('prefers .config.mjs over a bare .mjs', () => {
    const dir = seedConfigs(['ax.config.mjs', 'ax.mjs']);
    try {
      expect(resolveBox('ax', dir)).toBe(path.join(dir, 'ax.config.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws and lists the available boxes when not found', () => {
    const dir = seedConfigs(['ax.config.mjs', 'smrmg.config.mjs']);
    try {
      expect(() => resolveBox('nope', dir)).toThrow(/box 'nope' not found/);
      expect(() => resolveBox('nope', dir)).toThrow(/available: ax, smrmg/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses to resolve a _-prefixed shared partial as a box', () => {
    const dir = seedConfigs(['_presets.mjs', 'ax.config.mjs']);
    try {
      // the file exists, but `_presets` is a partial — not a runnable box
      expect(() => resolveBox('_presets', dir)).toThrow(/not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveBox (path form)', () => {
  test('resolves an explicit .mjs file path as-is', () => {
    const dir = seedConfigs(['vibe.mjs']);
    try {
      const file = path.join(dir, 'vibe.mjs');
      expect(resolveBox(file)).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves an explicit .config.mjs file path as-is', () => {
    const dir = seedConfigs(['vibe.config.mjs']);
    try {
      const file = path.join(dir, 'vibe.config.mjs');
      expect(resolveBox(file)).toBe(file);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('resolves a relative file path against the CWD', () => {
    const dir = seedConfigs(['vibe.mjs']);
    try {
      const file = path.join(dir, 'vibe.mjs');
      const rel = path.relative(process.cwd(), file);
      expect(rel).toContain(path.sep); // sanity: it really is the path form
      expect(resolveBox(rel)).toBe(path.resolve(rel));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dir-qualified name prefers .config.mjs and falls back to .mjs', () => {
    const dir = seedConfigs(['ax.config.mjs', 'ax.mjs', 'vibe.mjs']);
    try {
      expect(resolveBox(path.join(dir, 'ax'))).toBe(path.join(dir, 'ax.config.mjs'));
      expect(resolveBox(path.join(dir, 'vibe'))).toBe(path.join(dir, 'vibe.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('throws for a missing explicit file path', () => {
    expect(() => resolveBox('/no/such/dir/vibe.mjs')).toThrow(/box config .* not found/);
  });

  test('a directory is not mistaken for a config file', () => {
    const dir = seedConfigs([]);
    try {
      fs.mkdirSync(path.join(dir, 'vibe.mjs'));
      expect(() => resolveBox(path.join(dir, 'vibe.mjs'))).toThrow(/not found/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('dir-qualified missing name lists the boxes available in that dir', () => {
    const dir = seedConfigs(['ax.config.mjs']);
    try {
      expect(() => resolveBox(path.join(dir, 'nope'))).toThrow(/available: ax/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('refuses a dir-qualified _partial, but an explicit _*.mjs path works', () => {
    const dir = seedConfigs(['_presets.mjs']);
    try {
      // by name it's a partial…
      expect(() => resolveBox(path.join(dir, '_presets'))).toThrow(/not found/);
      // …but pointing at the file itself is explicit intent (like --config)
      expect(resolveBox(path.join(dir, '_presets.mjs'))).toBe(path.join(dir, '_presets.mjs'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
