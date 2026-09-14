// Pure builders for the Ghostty-app artifacts emitted by `clabox init`.
//
// For a box that opts in via `app` (see AppConfig), `init` generates a Ghostty
// config whose `command` launches `clabox -b <box>`, then clones Ghostty.app
// with a tiny C launcher that bakes in `--config-file=<that config>`. Everything
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
  const cd = opts.projectDir ? `cd ${shQuote(opts.projectDir)} && ` : '';
  const env = opts.configsDir ? `CLABOX_CONFIGS_DIR=${shQuote(opts.configsDir)} ` : '';
  const box = opts.boxName ? ` -b ${opts.boxName}` : '';
  const extra = (opts.extraArgs ?? []).map((a) => ` ${shQuote(a)}`).join('');
  const inner = `${cd}${env}${shQuote(opts.claboxBin)}${box}${extra}; exec zsh`;
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

/** Escape a string for embedding as a C double-quoted literal. */
function cEscape(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * Build the C launcher source. It finds itself, locates `ghostty.real` next to
 * it, and re-execs it with `--config-file=<configPath>` prepended — so the clone
 * always boots with its own config regardless of how it's launched.
 */
export function buildLauncherSource(configPath: string): string {
  return `// Generated by clabox init. Launches ghostty.real with a baked config.
#include <stdio.h>
#include <unistd.h>
#include <stdlib.h>
#include <libgen.h>
#include <mach-o/dyld.h>

static const char *CONFIG_PATH = "${cEscape(configPath)}";

int main(int argc, char *argv[]) {
    char path[4096];
    uint32_t size = sizeof(path);
    _NSGetExecutablePath(path, &size);

    char *dir = dirname(path);
    char real_path[4096];
    snprintf(real_path, sizeof(real_path), "%s/ghostty.real", dir);

    char config_arg[4096];
    snprintf(config_arg, sizeof(config_arg), "--config-file=%s", CONFIG_PATH);

    char **new_argv = malloc(sizeof(char *) * (argc + 2));
    new_argv[0] = real_path;
    new_argv[1] = config_arg;
    for (int i = 1; i < argc; i++) new_argv[i + 1] = argv[i];
    new_argv[argc + 1] = NULL;

    execv(real_path, new_argv);
    return 1;
}
`;
}

/** Absolute path to the built `.app` bundle. */
export function appBundlePath(appsDir: string, app: AppConfig): string {
  return path.join(appsDir, `${app.name}.app`);
}

/** Bundle identifier for the clone (explicit, or derived from the box name). */
export function bundleId(boxName: string, app: AppConfig): string {
  return app.bundleId ?? `com.ghostty.custom.${boxName.replace(/-/g, '.')}`;
}
