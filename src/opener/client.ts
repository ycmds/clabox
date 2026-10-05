// The in-box side of the opener broker: `clabox reveal <dir>` /
// `clabox open <file>` connect to the socket and send one line.
//
// This is what the agent runs. It deliberately knows nothing about policy —
// the broker decides, the client only reports the answer — so there is no
// version of this file that can talk the broker into more than it allows.

import net from 'node:net';
import path from 'node:path';
import { expandHome, openerSocketPath } from '../utils/config.js';
import type { OpenAction } from './protocol.js';

/** What the broker answered. */
export interface OpenReply {
  ok: boolean;
  /** `ok`, `denied: <reason>`, or a local failure (no broker running). */
  message: string;
}

/**
 * Ask the broker to reveal/open a path. Resolves rather than throws: for the
 * agent this is a convenience, and a missing broker must not look like a crash.
 *
 * The path is made absolute here (against the CWD, `~` expanded) because the
 * protocol only accepts absolute paths — the broker has no idea what the box's
 * working directory is.
 */
export function sendOpenRequest(
  action: OpenAction,
  target: string,
  { socket = openerSocketPath(), timeoutMs = 4000 }: { socket?: string; timeoutMs?: number } = {},
): Promise<OpenReply> {
  const abs = path.resolve(expandHome(target));
  return new Promise((resolve) => {
    const done = (reply: OpenReply) => {
      conn.destroy();
      resolve(reply);
    };
    const conn = net.createConnection(socket);
    conn.setTimeout(timeoutMs);
    conn.on('connect', () => conn.write(`${action} ${abs}\n`));
    conn.on('data', (chunk) => {
      const message = chunk.toString('utf8').trim();
      done({ ok: message.startsWith('ok'), message });
    });
    conn.on('timeout', () => done({ ok: false, message: 'opener: no answer from the broker' }));
    conn.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      // The three failures a user actually hits, each with a different fix —
      // and the raw `connect EPERM /…/opener-501.sock` tells you none of them.
      let message: string;
      if (code === 'ENOENT' || code === 'ECONNREFUSED') {
        // No socket, or nothing listening on it: the broker isn't running.
        message = `opener: no broker running — start one outside the sandbox with \`clabox opener --detach\``;
      } else if (code === 'EPERM' || code === 'EACCES') {
        // The socket exists but this box may not reach it. Almost always a box
        // that was launched before the grant existed: a Seatbelt profile is
        // applied at exec and never re-read, so the fix is a new box, not a
        // config change. (The other possibility is `opener: { enabled: false }`.)
        message = `opener: this box may not reach the broker (${code}) — reopen the box so it picks up the socket grant, or check it isn't \`opener: { enabled: false }\``;
      } else {
        message = `opener: ${(e as Error).message}`;
      }
      done({ ok: false, message });
    });
  });
}
