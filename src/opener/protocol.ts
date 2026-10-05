// The opener broker's protocol and its security decisions — pure, so every
// rule below is unit-testable without a socket, a Finder or a sandbox.
//
// Why a broker exists at all: `open` (the `lsopen` operation) is a sandbox
// escape, because it asks LaunchServices — which runs outside every box — to
// start a target the box itself can write (see `Config.allowOpen`). But the
// thing a user actually wants from it is narrow: "show me this folder" and
// "open this file in my editor". Those two don't need the escape, provided the
// agent never chooses *what gets executed*:
//
//   * `reveal` compiles to `open -R <path>`, and `-R` is documented as
//     "Reveals the file(s) in the Finder **instead of opening them**" — so it
//     cannot start anything, `.app` bundles included;
//   * `edit` compiles to `open -a <editor> <file>`, where the editor comes from
//     the **config**, never from the request, and the file must survive
//     {@link validateTarget}.
//
// What the broker therefore does NOT grant, and `allowOpen` would: running an
// arbitrary binary or bundle, picking the application, or reaching outside the
// configured roots.
//
// The honest residual: an editor may execute what it opens (Obsidian runs
// vault plugins, dataviewjs; VS Code has tasks). That risk is not created here
// — the agent already writes those files and the user already opens them by
// hand — but a broker does let the agent pick the moment. Hence `roots`,
// the extension allowlist, and the log.

import path from 'node:path';

/** The two things the broker will do. Nothing else is representable. */
export const OPEN_ACTIONS = ['reveal', 'edit'] as const;
export type OpenAction = (typeof OPEN_ACTIONS)[number];

/** A parsed request: an action plus the absolute path it applies to. */
export interface OpenRequest {
  action: OpenAction;
  target: string;
}

/**
 * File extensions `edit` accepts by default — text a person edits, nothing
 * that a shell, a loader or LaunchServices would treat as executable. The point
 * isn't that `.md` is harmless to the editor (see the module note), it's that
 * the broker never hands over something whose *type* invites execution:
 * `.app`, `.command`, `.scpt`, `.pkg`, `.dmg`, `.terminal` and friends can
 * never match this list.
 */
export const DEFAULT_EDIT_EXTENSIONS = [
  '.md',
  '.markdown',
  '.txt',
  '.text',
  '.json',
  '.jsonc',
  '.yml',
  '.yaml',
  '.toml',
  '.csv',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.scss',
  '.html',
  '.svg',
  '.sh',
  '.zsh',
  '.py',
  '.rb',
  '.go',
  '.rs',
  '.sql',
  '.env',
  '.log',
  '.diff',
  '.patch',
];

/** Longest request we will even look at — a path, not a payload. */
export const MAX_REQUEST_BYTES = 4096;

/**
 * Parse one wire line into a request. The wire format is deliberately the
 * dullest thing that works: `<action> <absolute path>`, one per line, no flags,
 * no quoting, no escapes.
 *
 * No flags is a security property, not laziness: the moment a request can carry
 * an option, `open -a X --args …` (or `-b <bundle id>`, or `-n`) puts the choice
 * of what runs back in the agent's hands, which is the whole thing we're
 * avoiding. The action vocabulary is closed for the same reason.
 *
 * Returns null for anything malformed — the server answers `denied` and logs it.
 */
export function parseOpenRequest(line: string): OpenRequest | null {
  if (line.length > MAX_REQUEST_BYTES) return null;
  // A control character means someone is trying to be clever with the stream.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: that is the check
  if (/[\0-\x08\x0b\x0c\x0e-\x1f]/.test(line)) return null;
  const trimmed = line.trim();
  const sep = trimmed.indexOf(' ');
  if (sep <= 0) return null;
  const action = trimmed.slice(0, sep);
  const target = trimmed.slice(sep + 1).trim();
  if (!OPEN_ACTIONS.includes(action as OpenAction)) return null;
  if (!target.startsWith('/')) return null; // absolute only: no cwd to guess
  return { action: action as OpenAction, target: path.normalize(target) };
}

/** What {@link validateTarget} needs to judge a request. */
export interface OpenPolicy {
  /**
   * Directories a request may point into, already absolute and realpath'd by
   * the caller. Empty means "nothing is allowed" — a broker with no roots
   * answers `denied` to everything, which is the right default for a misread
   * config.
   */
  roots: string[];
  /** Extensions `edit` accepts. Defaults to {@link DEFAULT_EDIT_EXTENSIONS}. */
  extensions?: string[];
}

/** Why a request was refused — surfaced to the client and the log. */
export type DenyReason =
  | 'malformed request'
  | 'path escapes the allowed roots'
  | 'inside an app bundle'
  | 'file type not allowed'
  | 'rate limited';

/**
 * Decide whether a request may proceed. `realTarget` is the caller's
 * symlink-resolved path — resolution has to happen before this, because a
 * symlink is precisely how a path inside the roots can point outside them.
 *
 * Returns null when allowed, else the reason.
 */
export function validateTarget(
  request: OpenRequest,
  realTarget: string,
  policy: OpenPolicy,
): DenyReason | null {
  const inside = policy.roots.some(
    (root) => realTarget === root || realTarget.startsWith(root.endsWith('/') ? root : `${root}/`),
  );
  if (!inside) return 'path escapes the allowed roots';

  // Never hand over anything inside a bundle, for either action. A bundle is
  // never something a person means to look at or edit, and refusing it keeps the
  // two actions reasoning about the same set of paths.
  //
  // The list covers every bundle type macOS will *run* when something opens it,
  // not just `.app`: a `.workflow` runs in Automator, a `.scptd` in Script
  // Editor, `.prefPane`/`.saver`/`.plugin`/`.component`/`.qlgenerator`/`.service`
  // are all loadable code. That matters because `reveal` of a directory is now
  // `open -a Finder <dir>` (so the folder gets its own window) rather than
  // `open -R`: the pinned app is what keeps it from launching anything, and this
  // list is the second half of that guarantee.
  if (
    /(^|\/)[^/]+\.(app|bundle|framework|xpc|appex|workflow|scptd|prefpane|saver|plugin|component|qlgenerator|kext|service|wdgt|mdimporter|dSYM)(\/|$)/i.test(
      realTarget,
    )
  ) {
    return 'inside an app bundle';
  }

  if (request.action === 'edit') {
    const allowed = policy.extensions ?? DEFAULT_EDIT_EXTENSIONS;
    const ext = path.extname(realTarget).toLowerCase();
    // A dotfile with no extension (`.gitignore`) reads as ext `''` here; treat
    // the basename as the extension so `.env`-style names can be allowlisted.
    const name = path.basename(realTarget).toLowerCase();
    if (!allowed.includes(ext) && !allowed.includes(name)) return 'file type not allowed';
  }
  return null;
}

/**
 * The argv for a validated request. `open` is exec'd directly (never through a
 * shell), so the path needs no quoting — and `-R` / `-a <app>` / `-t` are the
 * only shapes this function can produce.
 *
 * @param isDir the target is a directory (the caller `stat`s it; this module
 *   stays pure). A folder gets its **own Finder window** (`open -a Finder
 *   <dir>`), because `open -R <dir>` only *selects* it in the parent — which
 *   reads as "it opened the wrong directory". A file keeps `-R`: selecting it in
 *   its folder is exactly what revealing a file means.
 * @param editor application name for `edit` (from the config).
 */
export function buildOpenArgs(
  request: OpenRequest,
  editor: string | null,
  isDir = false,
): string[] {
  // `-a Finder`, never a bare `open <dir>`: pinning the application is what
  // makes this unable to launch anything, the same property `-a <editor>` gives
  // `edit`. A bare `open` would hand the path to LaunchServices to dispatch by
  // type, and a bundle directory the agent wrote (`x.workflow`) would then run.
  // The bundle-suffix deny in `validateTarget` is the other half.
  if (request.action === 'reveal') {
    return isDir ? ['-a', 'Finder', request.target] : ['-R', request.target];
  }
  // Fallback order, learned by surprising the user twice:
  //
  //   1. the type's **registered handler** (plain `open <file>`) — tried, and
  //      wrong: on macOS the handler for `.md` is very often **Xcode**, which
  //      claims text types at install time. "Open the README" turned into
  //      "System-wide components must be installed to use Xcode".
  //   2. `-t`, the "default text editor" — what we use now. Not perfect either
  //      (it's whichever app holds that role, e.g. Sublime), but it is always a
  //      text editor, and the broker's banner names it so there's no mystery.
  //
  // The real answer is to pin one: `clabox opener --editor "Zed"`. Either way
  // the agent never chooses the app, and the extension allowlist means nothing
  // executable is ever handed over.
  return editor ? ['-a', editor, request.target] : ['-t', request.target];
}

/** Human-readable name of whatever {@link buildOpenArgs} will use. */
export function openedWith(request: OpenRequest, editor: string | null): string {
  if (request.action === 'reveal') return 'Finder';
  return editor ?? 'the system text editor (set one with --editor)';
}

/**
 * A fixed-window rate limiter over the request stream.
 *
 * Not about CPU: a broker that opens windows on demand is a way to *flood the
 * screen*, and fifty Finder windows are an excellent place to hide the one
 * action you'd have objected to. `allow()` returns false once the window is
 * full. Pure (the clock is injected) so the behaviour is testable.
 */
export class RateLimiter {
  private hits: number[] = [];
  constructor(
    private readonly max = 12,
    private readonly windowMs = 60_000,
  ) {}

  allow(now: number): boolean {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(now);
    return true;
  }
}
