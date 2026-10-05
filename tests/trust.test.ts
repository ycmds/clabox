// Tests for the config trust gate — `src/utils/trust.ts` plus the two checks
// `loadConfig` runs around the `import()`.
//
// What's being protected: a config file is JavaScript clabox executes OUTSIDE
// the sandbox, before any profile exists, and whose return value *is* the
// sandbox policy. Three doors lead there from a tree an agent can write — a
// repo's `./clabox.config.mjs` (auto-loaded), `-b ./boxes/x.mjs`, and
// `init --dir <repo>` (imports every config it finds).
//
//   bun test

import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertConfigNotBoxWritable,
  boxWritableRoots,
  defaultConfig,
  hardDeniedPath,
  loadConfig,
} from '../src/utils/config.js';
import {
  assertConfigTrusted,
  configTrustState,
  hashFile,
  isInside,
  listTrusted,
  readTrustStore,
  trustConfig,
  trustFilePath,
  untrustConfig,
} from '../src/utils/trust.js';

/** A canonical (symlink-resolved) tmp dir — macOS `os.tmpdir()` is under /var. */
function tmp(prefix: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/**
 * Path grants that deny the temp dirs.
 *
 * Every box gets `/tmp` + `$TMPDIR` read-write from the base policy, so a
 * config file living in a tmp dir — which every fixture here does — IS
 * box-writable, correctly so. Tests that aren't about that fact deny the temp
 * dirs, so the only writable tree left is the one the test sets up.
 */
const DENY_TMP = { '/tmp': 'd', '/private/tmp': 'd', '^/private/var/folders/': 'd' } as const;

/** `defaultConfig` with the temp dirs denied (see {@link DENY_TMP}). */
function cfg(over: Partial<typeof defaultConfig> = {}) {
  return {
    ...defaultConfig,
    ...over,
    paths: { ...defaultConfig.paths, ...DENY_TMP, ...(over.paths ?? {}) },
  };
}

/** Run `fn` with a throwaway clabox home + configs dir, then clean up. */
function withHome(fn: (home: string) => void): void {
  const home = tmp('cb-trust-');
  const prev = process.env.CLABOX_CONFIGS_DIR;
  process.env.CLABOX_CONFIGS_DIR = path.join(home, 'configs');
  fs.mkdirSync(path.join(home, 'configs'), { recursive: true });
  try {
    fn(home);
  } finally {
    if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
    else process.env.CLABOX_CONFIGS_DIR = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('isInside', () => {
  test('a path is inside itself and its parents, not its siblings', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a', '/a/b/c')).toBe(true);
    expect(isInside('/a/b', '/a/bc')).toBe(false); // prefix, not a child
    expect(isInside('/a/b/c', '/a/b')).toBe(false);
  });

  test('containment is judged on the REAL path, so a symlink cannot hide', () => {
    // The case this exists for: a clabox home symlinked into a repo. Nominally
    // it's `~/.config/clabox` (read-only in-box); physically it's in the project
    // dir, which is granted RW — and Seatbelt matches the resolved path.
    const root = tmp('cb-link-');
    try {
      const real = path.join(root, 'real');
      fs.mkdirSync(path.join(real, 'configs'), { recursive: true });
      fs.symlinkSync(real, path.join(root, 'link'));
      expect(isInside(real, path.join(root, 'link', 'configs', 'x.mjs'))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the trust store', () => {
  test('a config inside the clabox home is trusted by location', () => {
    withHome((home) => {
      const file = path.join(home, 'configs', 'ax.mjs');
      fs.writeFileSync(file, 'export default {}');
      expect(configTrustState(file, home)).toBe('home');
      // …and nothing is recorded for it: location is the whole answer.
      expect(readTrustStore(home)).toEqual({});
    });
  });

  test('a config outside it is unknown until recorded, then stale once edited', () => {
    withHome((home) => {
      const repo = tmp('cb-repo-');
      try {
        const file = path.join(repo, 'clabox.config.mjs');
        fs.writeFileSync(file, 'export default {}');
        expect(configTrustState(file, home)).toBe('unknown');

        const rec = trustConfig(file, home);
        expect(rec.hash).toBe(hashFile(file) as string);
        expect(configTrustState(file, home)).toBe('trusted');

        // The record is keyed by CONTENT: an edit (by you or by an agent that
        // can write the repo) de-trusts it rather than riding the old approval.
        fs.writeFileSync(file, 'export default { network: false }');
        expect(configTrustState(file, home)).toBe('stale');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test('the store is written 0600 and survives a corrupt file as "nothing trusted"', () => {
    withHome((home) => {
      const repo = tmp('cb-repo-');
      try {
        const file = path.join(repo, 'a.mjs');
        fs.writeFileSync(file, 'export default {}');
        trustConfig(file, home);
        expect(fs.statSync(trustFilePath(home)).mode & 0o077).toBe(0);

        fs.writeFileSync(trustFilePath(home), 'not json');
        expect(readTrustStore(home)).toEqual({});
        expect(configTrustState(file, home)).toBe('unknown');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test('untrustConfig removes it; listTrusted reports state per entry', () => {
    withHome((home) => {
      const repo = tmp('cb-repo-');
      try {
        const a = path.join(repo, 'a.mjs');
        const b = path.join(repo, 'b.mjs');
        fs.writeFileSync(a, 'export default {}');
        fs.writeFileSync(b, 'export default {}');
        trustConfig(a, home);
        trustConfig(b, home);
        fs.writeFileSync(b, 'export default { network: false }');

        expect(listTrusted(home)).toEqual([
          { file: a, state: 'trusted' },
          { file: b, state: 'stale' },
        ]);
        expect(untrustConfig(a, home)).toBe(true);
        expect(untrustConfig(a, home)).toBe(false);
        expect(listTrusted(home).map((e) => e.file)).toEqual([b]);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

describe('assertConfigTrusted', () => {
  test('refuses an unknown config, naming it and the way out', () => {
    withHome((home) => {
      const repo = tmp('cb-repo-');
      try {
        const file = path.join(repo, 'clabox.config.mjs');
        fs.writeFileSync(file, 'export default {}');
        expect(() => assertConfigTrusted(file, { claboxHome: home })).toThrow(
          /refusing to load[\s\S]*clabox trust/,
        );
        // `--trust` is the per-run escape hatch.
        expect(assertConfigTrusted(file, { claboxHome: home, allow: true })).toBe('unknown');
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });

  test('a stale record is refused with a different reason', () => {
    withHome((home) => {
      const repo = tmp('cb-repo-');
      try {
        const file = path.join(repo, 'a.mjs');
        fs.writeFileSync(file, 'export default {}');
        trustConfig(file, home);
        fs.writeFileSync(file, 'export default { network: false }');
        expect(() => assertConfigTrusted(file, { claboxHome: home })).toThrow(/it changed since/);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});

describe('boxWritableRoots / assertConfigNotBoxWritable', () => {
  test('the project dir counts as writable, the hard-denied ~/.config does not', () => {
    const roots = boxWritableRoots({ ...defaultConfig, cwd: '/proj/box' });
    // The temp dirs are writable for every box, which is why the fixtures below
    // have to deny them — assert that here so the reason stays visible.
    expect(roots).toContain(os.tmpdir());
    expect(roots).toContain('/proj/box');
    // `~/.config/clabox` is in the base policy as a write grant for some boxes,
    // but the hard secret deny (`~/.config`) is emitted last and wins — so it
    // must NOT be reported as writable, or the standard layout would be flagged.
    expect(roots.some((r) => r.startsWith(path.join(os.homedir(), '.config')))).toBe(false);
    // …and a regex grant (the `$TMPDIR` rule) contributes the tmp dir, not a `^…`.
    expect(roots.some((r) => r.startsWith('^'))).toBe(false);
  });

  test('a config inside the box-writable project dir is refused', () => {
    const repo = tmp('cb-proj-');
    try {
      const file = path.join(repo, 'clabox.config.mjs');
      fs.writeFileSync(file, 'export default {}');
      const config = cfg({ cwd: repo });
      expect(() => assertConfigNotBoxWritable(file, config)).toThrow(/can WRITE/);
      expect(() => assertConfigNotBoxWritable(file, config, { allow: true })).not.toThrow();
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('a config in the clabox home with an unrelated project dir is fine', () => {
    withHome((home) => {
      const file = path.join(home, 'configs', 'ax.mjs');
      fs.writeFileSync(file, 'export default {}');
      expect(() => assertConfigNotBoxWritable(file, cfg({ cwd: '/proj/elsewhere' }))).not.toThrow();
    });
  });

  // The regression this pins: a whole-disk box (`paths: {'/': 'w'}` — the `root`
  // preset) refused to start, because "is the config inside `/`?" is true for
  // every config there is. But the hard secret deny covers `~/.config` and is
  // emitted after every allow, so a config in the standard location is the one
  // place that box CANNOT write.
  test('a whole-disk box still starts with its config in the clabox home', () => {
    const file = path.join(os.homedir(), '.config/clabox/configs/whole-disk.mjs');
    const config = cfg({ cwd: '/proj/elsewhere', paths: { '/': 'w' } });
    expect(hardDeniedPath(config, file)).toBe(true);
    expect(() => assertConfigNotBoxWritable(file, config)).not.toThrow();
  });

  test('…but the same box is refused for a config outside the hard deny', () => {
    const repo = tmp('cb-wd-');
    try {
      const file = path.join(repo, 'clabox.config.mjs');
      fs.writeFileSync(file, 'export default {}');
      const config = cfg({ cwd: '/proj/elsewhere', paths: { '/': 'w' } });
      expect(hardDeniedPath(config, file)).toBe(false);
      expect(() => assertConfigNotBoxWritable(file, config)).toThrow(/can WRITE/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  test('hardDeniedPath covers every denyDotConfigs dir, nothing else', () => {
    const config = cfg({});
    for (const d of config.denyDotConfigs) {
      expect(hardDeniedPath(config, path.join(os.homedir(), `.${d}/x`))).toBe(true);
    }
    expect(hardDeniedPath(config, path.join(os.homedir(), 'projects/x'))).toBe(false);
  });

  test("a box's own write grant over its config dir is caught", () => {
    // The symlinked-clabox-home case in miniature: the config is in the home,
    // but the box also asks for write access to the tree it sits in.
    withHome((home) => {
      const file = path.join(home, 'configs', 'ax.mjs');
      fs.writeFileSync(file, 'export default {}');
      const config = cfg({ cwd: '/proj/elsewhere', paths: { [home]: 'w' } });
      expect(() => assertConfigNotBoxWritable(file, config)).toThrow(/can WRITE/);
    });
  });
});

describe('loadConfig (the gate in front of import())', () => {
  test('loads a config from the clabox home with no record needed', async () => {
    const home = tmp('cb-home-');
    const prev = process.env.CLABOX_CONFIGS_DIR;
    process.env.CLABOX_CONFIGS_DIR = path.join(home, 'configs');
    try {
      fs.mkdirSync(path.join(home, 'configs'), { recursive: true });
      const file = path.join(home, 'configs', 'ax.mjs');
      // The denied temp dirs are what keep this fixture (which lives in one)
      // out of the box-writable check — see DENY_TMP.
      fs.writeFileSync(
        file,
        `export default { network: false, cwd: '/proj/elsewhere', paths: ${JSON.stringify(DENY_TMP)} }`,
      );
      const { config, configFile, trust } = await loadConfig(file);
      expect(config.network).toBe(false);
      expect(configFile).toBe(file);
      expect(trust).toBe('home');
    } finally {
      if (prev === undefined) delete process.env.CLABOX_CONFIGS_DIR;
      else process.env.CLABOX_CONFIGS_DIR = prev;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  test('refuses an untrusted repo config — and does NOT execute it', async () => {
    withHome(async (home) => {
      const repo = tmp('cb-repo-');
      const marker = path.join(repo, 'executed');
      try {
        const file = path.join(repo, 'clabox.config.mjs');
        // Top-level side effect: if this ever runs, the gate didn't hold.
        fs.writeFileSync(
          file,
          `import fs from 'node:fs';
           fs.writeFileSync(${JSON.stringify(marker)}, 'x');
           export default { paths: { '/': 'w' } };`,
        );
        await expect(loadConfig(file)).rejects.toThrow(/refusing to load/);
        expect(fs.existsSync(marker)).toBe(false);

        // With `--trust` it loads (and, being a `cwd`-less config, isn't flagged
        // as box-writable — the project dir here is the test runner's cwd).
        const { config } = await loadConfig(file, { trust: true });
        expect(config.paths['/']).toBe('w');
        expect(fs.existsSync(marker)).toBe(true);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
      expect(home).toBeTruthy();
    });
  });

  test('a broken config names the file, not just the parser error', async () => {
    // The report this exists for: `clabox` in a project printed a bare
    // `Error: Unexpected token '['` — which reads as "clabox is broken" when it
    // means "your config has a syntax error". The message must say which file.
    withHome(async (home) => {
      const file = path.join(home, 'configs', 'broken.mjs');
      fs.writeFileSync(file, 'export default { paths: [ }\n');
      await expect(loadConfig(file)).rejects.toThrow(
        new RegExp(`config '${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}' has a syntax error`),
      );
    });
  });

  test('a config that throws at top level is reported the same way', async () => {
    withHome(async (home) => {
      const file = path.join(home, 'configs', 'throws.mjs');
      fs.writeFileSync(file, 'throw new Error("boom");\n');
      await expect(loadConfig(file)).rejects.toThrow(/failed to load: boom/);
    });
  });

  test('a trusted config whose box can write it is still refused', async () => {
    // Trust answers "did a human look at this file?". It cannot answer "can the
    // agent rewrite it before the next launch?" — that's the second gate.
    withHome(async (home) => {
      const repo = tmp('cb-proj-');
      try {
        const file = path.join(repo, 'clabox.config.mjs');
        fs.writeFileSync(file, `export default { cwd: ${JSON.stringify(repo)} }`);
        trustConfig(file, home);
        await expect(loadConfig(file)).rejects.toThrow(/can WRITE/);
      } finally {
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
