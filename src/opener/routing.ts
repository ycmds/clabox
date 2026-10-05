// Which app opens what — the broker's routing table. Pure: the caller supplies
// what it found on the machine, this decides.
//
// Why routing exists at all: with no editor configured the broker used to fall
// back to `open <file>` (the type's registered handler) or `open -t` (the
// "default text editor"). Both were wrong on a real machine — the first opened
// a README in **Xcode** (which then demanded to install system components),
// the second in **TextEdit**. Neither is where anyone wants to read code, and
// "go configure it yourself" is a bad answer for a convenience feature.
//
// The security property is unchanged, and it is the only one that matters here:
// **the agent still cannot choose the application.** It sends a path; the app
// comes from this table plus what is actually installed. A request can at most
// steer which *branch* it lands in (by file extension), and every branch is an
// app the user already has for that kind of file.

import path from 'node:path';

/**
 * Code/text editors, best first. The list is "what people actually read code
 * in", and the first one installed wins — so a machine with Zed gets Zed, one
 * with only TextEdit still gets TextEdit (via the `-t` fallback, not from here).
 */
export const CODE_EDITORS = [
  'Zed',
  'Cursor',
  'Visual Studio Code',
  'Sublime Text',
  'Nova',
  'BBEdit',
  'TextMate',
  'IntelliJ IDEA',
  'WebStorm',
];

/** Markdown inside an Obsidian vault belongs in Obsidian, not in an editor. */
export const VAULT_APPS = ['Obsidian'];

/**
 * Markdown *outside* a vault: a rendered reader beats a code editor, because
 * `open`ing a doc is a request to **read** it (the agent edits markdown through
 * the file tools, never through an app). Falls through to {@link CODE_EDITORS}
 * when none of these is installed, so a machine without one is unchanged.
 */
export const MARKDOWN_APPS = ['Typora', 'MacDown', 'Marked 2'];

/**
 * Extensions treated as markdown by {@link routeTarget} — the two that
 * `DEFAULT_EDIT_EXTENSIONS` accepts, so no branch here is unreachable.
 */
export const MARKDOWN_EXTENSIONS = ['.md', '.markdown'];

/** Images and PDFs: Preview ships with macOS, so this one is always available. */
export const VIEWER_APPS = ['Preview'];

/** Extensions routed to {@link VIEWER_APPS}. */
export const VIEWABLE_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.heic',
  '.tiff',
  '.bmp',
  '.pdf',
];

/** What {@link routeTarget} needs to know about the world. */
export interface RouteContext {
  /** App names found on this machine (see `opener/apps.ts`). */
  installed: string[];
  /** The target sits inside an Obsidian vault (a `.obsidian` dir above it). */
  inVault?: boolean;
  /** An explicit `--editor` / `opener.editor`: wins over everything here. */
  editor?: string | null;
}

/** First candidate that is installed, else null. */
function firstInstalled(candidates: string[], installed: string[]): string | null {
  return candidates.find((app) => installed.includes(app)) ?? null;
}

/**
 * The app for a path, or null to fall back to `open -t` (system text editor).
 *
 * Directories never reach here — they're `reveal`ed in Finder, which cannot
 * execute what it shows.
 */
export function routeTarget(target: string, ctx: RouteContext): string | null {
  if (ctx.editor) return ctx.editor; // explicit beats clever
  const ext = path.extname(target).toLowerCase();

  if (VIEWABLE_EXTENSIONS.includes(ext)) return firstInstalled(VIEWER_APPS, ctx.installed);
  if (MARKDOWN_EXTENSIONS.includes(ext)) {
    // In a vault a note is not a file: an editor loses the links, the graph and
    // the plugins the user keeps it in Obsidian for. Outside one, it's a
    // document to read — so a markdown reader, and only then the code editor.
    const mdApp = ctx.inVault
      ? firstInstalled(VAULT_APPS, ctx.installed)
      : firstInstalled(MARKDOWN_APPS, ctx.installed);
    if (mdApp) return mdApp;
  }
  return firstInstalled(CODE_EDITORS, ctx.installed);
}

/**
 * How the choice is described back to the caller — `ok: Zed`, so "it opened
 * somewhere random" is always answerable.
 */
export function describeApp(app: string | null): string {
  return app ?? 'the system text editor (no editor app found)';
}
