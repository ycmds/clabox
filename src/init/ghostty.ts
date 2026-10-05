// Pure builders for the Ghostty-app artifacts emitted by `clabox init`.
//
// For a box that opts in via `app` (see AppConfig), `init` generates a Ghostty
// config whose `command` launches `clabox -b <box>`, then clones Ghostty.app and
// points the clone at that config through a private `XDG_CONFIG_HOME`. Everything
// here is text-only (no I/O) so it can be unit-tested without macOS; the actual
// build lives in init/app.ts.

import path from 'node:path';
import type { AppConfig } from '../utils/config.js';

/** What {@link buildShellCommand} needs to boot a box (all paths absolute). */
export interface BoxCommandOptions {
  /** The `-b` box name to launch, or null to run `clabox` with no box. */
  boxName: string | null;
  /** Absolute project dir to `cd` into. null → don't `cd` (run in launch cwd). */
  projectDir: string | null;
  /**
   * Absolute `CLABOX_CONFIGS_DIR` so `-b` resolves the box from any cwd, or
   * null to omit it — when null, `-b` finds the box via the runtime default
   * (`~/.config/clabox/configs`) at launch time.
   */
  configsDir: string | null;
  /**
   * The `clabox` command baked into the launcher. Default is a bare `clabox`
   * resolved from PATH at launch time by the `zsh -lic` login shell (survives
   * package-manager moves, e.g. bun → npm/homebrew); pass an absolute path only
   * to pin a specific binary.
   */
  claboxBin: string;
  /** Extra args appended after `-b <box>` (e.g. `['--rc']`). */
  extraArgs?: string[];
  /**
   * The private `XDG_CONFIG_HOME` an app bundle injects via `LSEnvironment`
   * (see {@link ghosttyHomeDir}) — set it, and the command drops the var again
   * before the box starts.
   *
   * The variable is how the clone finds its config, but it is inherited by
   * everything the terminal spawns, and plenty of tools key off it (`gh` reads
   * `$XDG_CONFIG_HOME/gh/hosts.yml`, nvim its whole config) — inside the box
   * they'd look in Ghostty's private home and find nothing. The reset is
   * **conditional** on the value still being ours: `zsh -lic` loads the login
   * profile first, so a user who exports their own `XDG_CONFIG_HOME` has
   * already overwritten it by then and must keep it.
   */
  resetXdgConfigHome?: string | null;
}

/** Inputs for {@link buildGhosttyConfig} — a box command plus the app's looks. */
export interface GhosttyConfigOptions extends BoxCommandOptions {
  app: AppConfig;
  /** An app config always names its box. */
  boxName: string;
  /** Absolute path to a base Ghostty config, emitted as a leading `config-file`. */
  baseGhosttyConfig?: string | null;
}

/**
 * Quote a value for a POSIX double-quoted shell string. The inner command is
 * itself wrapped in single quotes (`zsh -lic '…'`), so double quotes nest
 * cleanly and keep paths with spaces (e.g. iCloud's `~/Library/Mobile
 * Documents/…`) from being split into two `cd` arguments.
 */
function shQuote(s: string): string {
  return `"${s.replace(/(["$`\\])/g, '\\$1')}"`;
}

/**
 * Reject a config value that would break out of the single line / single
 * statement it's interpolated into.
 *
 * Both generators here are line-oriented: a Ghostty config is `key = value` per
 * line, and the shell command is one statement. A `\n` in a value is therefore
 * not a quoting problem but a *syntax* one — `cwd` with a newline in it injects
 * a second `command = …` into the app config (scalar keys: last wins, so it runs
 * at every launch, outside the sandbox). Config values are author-controlled,
 * and with box configs coming from repos (utils/trust.ts) "author" can mean
 * "whoever wrote the repo", so this throws instead of silently escaping.
 */
export function assertSingleLine(value: string, what: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that's the point
  if (/[\r\n\0\x1b]/.test(value)) {
    throw new Error(
      `clabox: ${what} must not contain newlines or control characters (got ${JSON.stringify(value)})`,
    );
  }
  return value;
}

/**
 * What an `app.name` may be: a plain filename, since it becomes
 * `<appsDir>/<name>.app` — a path `clabox init` `rm -rf`s and then clones
 * Ghostty onto. Unvalidated, `path.join` happily resolves a `../../..` out of
 * `appsDir` (`name: '../../../tmp/x'` deletes `/tmp/x.app`), and `name:
 * 'Ghostty'` with `appsDir: '/Applications'` deletes the donor app itself. No
 * separators, no `..`, no leading dot, no control characters; spaces and emoji
 * are fine (`"AX Manager"` is a real app name).
 */
export function assertSafeAppName(name: string): string {
  const bad =
    !name ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    name.includes('/') ||
    name.includes('\\') ||
    // biome-ignore lint/suspicious/noControlCharactersInRegex: filename guard
    /[\0-\x1f:]/.test(name);
  if (bad) {
    throw new Error(
      `clabox: unsafe app.name ${JSON.stringify(name)} — it names <appsDir>/<name>.app, so it must be a plain filename (no '/', no '..', no leading '.')`,
    );
  }
  return name;
}

/**
 * The `zsh -lic '…'` shell command that boots clabox for the box — the value of
 * the Ghostty `command` key, and the same string the AppleScript surface
 * configuration takes (`sandbox/applescript.ts`), so a tab opened either way
 * behaves identically.
 *
 * Login + interactive zsh so a GUI-launched app inherits the user's PATH
 * (/etc/zprofile→path_helper for Homebrew, ~/.zshrc for fnm/nvm/volta). A bare
 * `bash -c` gets only launchd's minimal PATH and can't find `node` (clabox's
 * shebang is `#!/usr/bin/env node`).
 */
export function buildShellCommand(opts: BoxCommandOptions): string {
  for (const [what, value] of [
    ['projectDir', opts.projectDir],
    ['configsDir', opts.configsDir],
    ['claboxBin', opts.claboxBin],
    ['box name', opts.boxName],
  ] as Array<[string, string | null]>) {
    if (value) assertSingleLine(value, what);
  }
  const reset = opts.resetXdgConfigHome
    ? `[ "$XDG_CONFIG_HOME" = ${shQuote(opts.resetXdgConfigHome)} ] && unset XDG_CONFIG_HOME; `
    : '';
  const cd = opts.projectDir ? `cd ${shQuote(opts.projectDir)} && ` : '';
  const env = opts.configsDir ? `CLABOX_CONFIGS_DIR=${shQuote(opts.configsDir)} ` : '';
  // Quoted like every other interpolated value, even though `resolveBox`
  // already restricts box names to a safe charset — a generator shouldn't rely
  // on a check that lives two modules away.
  const box = opts.boxName ? ` -b ${shQuote(opts.boxName)}` : '';
  const extra = (opts.extraArgs ?? []).map((a) => ` ${shQuote(a)}`).join('');
  const inner = `${reset}${cd}${env}${shQuote(opts.claboxBin)}${box}${extra}; exec zsh`;
  // The whole thing is handed over inside single quotes, so a `'` anywhere in a
  // path or an extra arg would end the string early — close/escape/reopen it the
  // POSIX way instead.
  return `zsh -lic '${inner.replace(/'/g, `'\\''`)}'`;
}

/** The `command = zsh -lic '…'` line that boots clabox for the box. */
export function buildCommand(opts: GhosttyConfigOptions): string {
  return `command = ${buildShellCommand(opts)}`;
}

/**
 * Terminal-protocol hardening for a box's own app.
 *
 * Seatbelt confines files and processes; it has no idea the terminal protocol is
 * **bidirectional**. A sandboxed agent that can print to its own stdout can ask
 * the emulator — which runs outside every box — to hand things back:
 *
 *   - `OSC 52` reads the *system clipboard* (`clipboard-read`), i.e. whatever
 *     you last copied, passwords included, straight past the file rules;
 *   - `OSC 21` reports the window/tab title back as input (`title-report`),
 *     leaking whatever other context the title carries.
 *
 * Both are gated by Ghostty config, so the generated app config denies them.
 * Emitted *before* the box's own `app.ghostty`, so a box that really wants
 * clipboard reads can still override (scalar keys: last value wins).
 */
export const GHOSTTY_SECURITY_DEFAULTS: Record<string, string> = {
  'clipboard-read': 'deny',
  'title-report': 'false',
};

/**
 * Non-security defaults worth having in every generated app config.
 * `window-colorspace = display-p3` widens the gamut, which is what makes a
 * marker color (e.g. the `--rc` background) actually look saturated on a modern
 * Mac display instead of muddy sRGB.
 */
export const GHOSTTY_APP_DEFAULTS: Record<string, string> = {
  'window-colorspace': 'display-p3',
};

/** Build the Ghostty config text for an app box. */
export function buildGhosttyConfig(opts: GhosttyConfigOptions): string {
  const { app } = opts;
  // Every value below ends up as a `key = value` line; a newline in one of them
  // would add a line of its own (a second `command =` being the interesting
  // case). Checked up front so the error names the field.
  assertSafeAppName(app.name);
  assertSingleLine(app.title ?? app.name, 'app.title');
  if (app.macosIcon) assertSingleLine(app.macosIcon, 'app.macosIcon');
  if (opts.baseGhosttyConfig) assertSingleLine(opts.baseGhosttyConfig, 'baseGhosttyConfig');
  for (const [key, value] of Object.entries(app.ghostty ?? {})) {
    assertSingleLine(key, 'app.ghostty key');
    assertSingleLine(value, `app.ghostty['${key}']`);
  }
  const lines: string[] = [
    '# Generated by `clabox init` — do not edit; rerun it after changing the box config.',
  ];
  if (opts.baseGhosttyConfig) lines.push(`config-file = ${opts.baseGhosttyConfig}`);
  // After the base config-file (so these win over it) and before `app.ghostty`
  // (so the box can still override): deny the escape sequences that would let a
  // sandboxed agent read the clipboard / the window title, plus the display-p3
  // colorspace.
  lines.push('', '# clabox: terminal-protocol hardening (a box must not read your clipboard)');
  for (const [key, value] of Object.entries(GHOSTTY_SECURITY_DEFAULTS)) {
    lines.push(`${key} = ${value}`);
  }
  for (const [key, value] of Object.entries(GHOSTTY_APP_DEFAULTS)) {
    lines.push(`${key} = ${value}`);
  }
  lines.push('', `title = "${app.title ?? app.name}"`);
  if (app.macosIcon) lines.push(`macos-icon = ${app.macosIcon}`);
  if (app.ghostty && Object.keys(app.ghostty).length > 0) {
    lines.push('');
    for (const [key, value] of Object.entries(app.ghostty)) lines.push(`${key} = ${value}`);
  }
  lines.push('', buildCommand(opts));
  return `${lines.join('\n')}\n`;
}

/**
 * The private `XDG_CONFIG_HOME` for a box's app: `<base>/ghostty-home/<box>`.
 *
 * This is how a clone gets its own config **without a launcher binary**. The
 * obvious design — keep the real Ghostty as `ghostty.real` and make
 * `CFBundleExecutable` a wrapper that re-execs it with `--config-file=…` — is
 * what the builder used to do, and it quietly destroys the bundle's identity:
 * LaunchServices keys its record on the running **executable path**, so when
 * the image changes under it (even via `execv`, which keeps the pid) it moves
 * the launch data to `originalExecutablePath`/`originalPid` and **clears the
 * `pid` field**. `NSRunningApplication.processIdentifier` then returns `-1`,
 * which breaks every consumer that goes bundle → pid → API: window managers
 * (`AXUIElementCreateApplication(-1)` yields no windows, so Rectangle silently
 * can't move the app's windows), AppleScript targeting, Dock integration, and
 * TCC, which prompts against a signing identity that is no longer the bundle's
 * (a wrapper leaves the real binary signed standalone, `Info.plist` not bound).
 *
 * Injecting the var via `LSEnvironment` keeps the shipped Ghostty binary as the
 * bundle's one and only executable, so the process LaunchServices started is
 * the process that keeps running.
 */
export function ghosttyHomeDir(baseDir: string, boxName: string): string {
  return path.join(baseDir, 'ghostty-home', boxName);
}

/** The file Ghostty actually reads inside that home: `<home>/ghostty/config`. */
export function ghosttyHomeConfigPath(home: string): string {
  return path.join(home, 'ghostty', 'config');
}

/**
 * Contents of that file: a one-line `config-file` pointing at the box's real
 * generated config. Indirection on purpose — the box config stays at the
 * familiar `<base>/ghostty/<box>.config` (where `+validate-config` checks it
 * and a user can read it), and the XDG home holds nothing but the pointer.
 */
export function buildHomeConfigShim(configPath: string): string {
  return [
    '# Generated by `clabox init` — do not edit; rerun it after changing the box config.',
    '# Ghostty reads this because the .app injects XDG_CONFIG_HOME via LSEnvironment.',
    `config-file = ${configPath}`,
    '',
  ].join('\n');
}

/**
 * Absolute path to the built `.app` bundle — validated to stay inside
 * `appsDir`, since the builder `rm -rf`s this path before cloning onto it.
 */
export function appBundlePath(appsDir: string, app: AppConfig): string {
  assertSafeAppName(app.name);
  const dir = path.resolve(appsDir);
  const out = path.resolve(dir, `${app.name}.app`);
  // Belt and braces: the name check above already rules out separators, so a
  // failure here means someone found a form it doesn't cover.
  if (path.dirname(out) !== dir) {
    throw new Error(`clabox: app bundle path escapes appsDir: ${out}`);
  }
  return out;
}

/**
 * Bundle identifier for the clone (explicit, or derived from the box name).
 * Restricted to the reverse-DNS charset: it's written into `Info.plist` and is
 * the key every LaunchServices / TCC record hangs off.
 */
export function bundleId(boxName: string, app: AppConfig): string {
  const id = app.bundleId ?? `com.ghostty.custom.${boxName.replace(/-/g, '.')}`;
  if (!/^[A-Za-z0-9.-]+$/.test(id)) {
    throw new Error(
      `clabox: unsafe bundle id ${JSON.stringify(id)} — use letters, digits, '.' and '-' only`,
    );
  }
  return id;
}
