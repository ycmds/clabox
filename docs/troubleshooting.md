# Troubleshooting

Findings from real debugging sessions, kept so the next investigation starts
where the last one stopped. Each entry records what was *measured*, not what was
guessed.

## "Not logged in · Run /login" inside a box

**Symptom.** A box starts with `⏵⏵ … Not logged in · Run /login` and the header
reads `API Usage Billing` instead of the plan name (`Claude Max`), while the same
account is logged in fine outside the sandbox.

**Status: SOLVED 2026-09-06 — it was `ulimit -u`.** Fixed in
`src/sandbox/run.ts#resolveUlimit`. The 2026-08-21 pass below couldn't reproduce
it because the trigger is the *machine's* process count drifting over the cap,
not anything about claude or the keychain.

### Root cause

`RLIMIT_NPROC` on macOS counts processes **per uid, machine-wide** — not per
session, not per sandbox. A desktop login sits around 1000–1100 processes
(`ps -u "$USER" | wc -l`, `kern.maxprocperuid` is 5333), so the launcher's
`sh -c 'ulimit -u 1024; exec sandbox-exec …'` didn't cap the box, it left it with
**negative** headroom: every `fork` inside failed with `EAGAIN` from the first
second. Claude reads its OAuth token by spawning `security`, that spawn failed,
and the empty read renders exactly as `Not logged in` + `API Usage Billing`.

That also explains the 10-out-of-11 flakiness measured in August: the process
count was oscillating around 1024.

Bisect that pinned it (each step run by hand):

| Command | Result |
|---|---|
| `sandbox-exec -f <profile> env CLAUDE_CONFIG_DIR=… claude -p 'say OK'` | `OK` |
| … + every `config.env` var and every `claudeArgs`/extras flag | `OK` |
| `sh -c 'ulimit -u 1024; exec sandbox-exec …'` (as clabox launched it) | **`Not logged in`** |
| `sh -c 'ulimit -u 4096; exec sandbox-exec …'` | `OK` |

**The fix.** `config.ulimitProcs` is now *headroom*: the launcher sets
`ulimit -u <processes already running for this uid + ulimitProcs>`, clamped to
`kern.maxprocperuid`, and sets no cap at all when the count can't be read. The
fork-bomb guard keeps its intended meaning ("the box may add N processes") and
stops depending on how many Slack/Chrome helpers happen to be up.
`clabox info` now prints the effective number:

```
ulimitProcs     1024 (headroom) → ulimit -u 2101, 1077 procs running
```

If a box ever shows `Not logged in` again, check that row **first**, and
`ps -u "$USER" | wc -l` next. The elimination trail below stays valid for the
cases the ulimit doesn't explain.

### What the header actually means

`API Usage Billing` is the *fallback* label: claude prints the plan name when an
OAuth credential is present and this string when it isn't. So
`API Usage Billing` + `Not logged in` is one fact, not two — the OAuth read came
back empty.

### Where the login lives

- **Not a file** — on macOS the credential is a keychain generic-password item.
- The service name is **derived from `CLAUDE_CONFIG_DIR`**:
  `Claude Code-credentials` when the var is unset, and
  `Claude Code-credentials-<sha256(configDir)[0:8]>` when it is set. A box with
  `configDir: '~/.claude_axiomus'` therefore reads
  `Claude Code-credentials-3a51c0b7`, a *different* keychain item from the one an
  unsandboxed `claude` uses. Logging in on one does not log in the other.
- Read is a `security find-generic-password -a "$USER" -w -s "<service>"`
  subprocess (5 s timeout, in-memory cache, `[keychain] read failed; serving
  stale cache` on failure). Write is `printf 'add-generic-password …' | security -i`.
- The OAuth refresh lock is `<configDir>/.oauth_refresh.lock` (plus a legacy
  `<configDir>.lock` whose failure is swallowed), so it lands inside the
  config-dir grant.

### Verified working under the sandbox

Measured against a generated profile with `sandbox-exec -f <profile> …`:

| Check | Result |
|---|---|
| `security find-generic-password … -w`, 20 runs | 20/20 exit 0 |
| `security -i` write + read-back of a probe item | ok |
| Box launched via PTY (`ax`, `def`, `ax-mg`, `is-mg`), 11 runs incl. 3 in parallel | 10× `Claude Max`, 1× `Not logged in` |

The keychain code is **byte-identical across 2.1.233 / 2.1.234 / 2.1.238** (same
`security` argv, same service-name derivation, same lock paths), so "the update
broke auth" does not hold at the mechanism level.

### Reproducing the diagnosis next time

1. Launch the box with `--debug` and read `<configDir>/debug/latest`.
2. Inside the box, check the keychain directly:

   ```sh
   security find-generic-password -a "$USER" \
     -s "Claude Code-credentials-$(printf %s "$CLAUDE_CONFIG_DIR" | shasum -a 256 | cut -c1-8)" \
     -w >/dev/null; echo $?
   ```

   Non-zero ⇒ the keychain read is the problem. Zero ⇒ look at the network/backend.
3. `claude doctor` runs its own keychain probe (`Claude Code-doctor-probe`).

### Rolling back the CLI

Old versions stay on disk, and `~/.local/bin/claude` is just a symlink:

```sh
ln -sfn ~/.local/share/claude/versions/2.1.234 ~/.local/bin/claude
```

Boxes already set `DISABLE_AUTOUPDATER=1`; an unsandboxed run will still update
the symlink back.

## EPERM noise in a box's debug log

Running a box with `--debug` surfaces these — the first two were real profile
gaps and are now fixed in `src/sandbox/profile.ts` ("Claude runtime state &
caches"):

| Path | Verdict |
|---|---|
| `~/.local/state/claude/locks/<version>.lock.tmp.*` | **was read-only** → now RW. Claude takes a version lock at startup; the RO grant produced `NON-FATAL: Lock acquisition failed`. |
| `~/Library/Caches/claude-cli-nodejs/**` | **was ungranted** → now RW. Per-MCP-server log batches were dropped. |
| `posix_spawn 'ps'` | Expected but **not harmless** — `/bin/ps` is setgid `kmem` and Seatbelt refuses to exec it (no `process-exec` grant can help). Tools that only *read* the process table are fine (`process-info*` covers them), but anything that shells out to `ps` breaks — see the Remote Control section below. |
| `~/Library/Application Support/*/NativeMessagingHosts/*.json` | Expected. Claude-in-Chrome tries to install its native-messaging manifest into every browser profile. Harmless in a box. |
| `~/.claude/**` | **Deliberate.** Only `configDir` is granted. If `CLAUDE_CONFIG_DIR` ever fails to reach `claude`, it falls back to `~/.claude` and hits this deny — which looks exactly like "not logged in". Check `echo $CLAUDE_CONFIG_DIR` inside the box first. |

## Remote Control (`/rc`) and remote sessions in a box

**Symptom.** Remote Control looks dead for boxes: sessions started from the
Claude app die immediately, `claude daemon stop` says it can't stop the running
daemon, and a new daemon refuses to take over.

**Status: SOLVED 2026-09-07 — the daemon was being born inside a box.** Fixed by
adding `clabox daemon` (`src/daemon/daemon.ts`), which starts it *outside* the
sandbox.

### What actually works in a box (measured, claude 2.1.263, `def`-style profile)

Everything session-related is fine — the bug is narrower than "resume/rc is
broken":

| Check | Result |
|---|---|
| `clabox … -c` / `-r` / `--resume <id>` reaching claude | ✅ passed through verbatim |
| `claude --continue -p '…'` | ✅ answers |
| `--resume` picker and the `/resume` slash command, incl. picking a session | ✅ list renders, session resumes |
| `/rc` inside a box | ✅ `/rc active` + a `https://claude.ai/code/session_…` link |
| `/tmp/cc-socks/<pid>.sock` (the per-session messaging socket) | ✅ bound; `connect()` from outside succeeds |
| `<configDir>/sessions/<pid>.json` (`bridgeSessionId`, `messagingSocketPath`) | ✅ written |
| `claude daemon run` **inside** the sandbox | ❌ `own process start-time probe failed twice — writing a procStart-less lock; kill paths will refuse to signal this daemon` |
| the same **outside** | ✅ clean start, no warning |
| `/bin/ps` inside the sandbox | ❌ `Operation not permitted` (exit 126) |

### Root cause

The Remote Control supervisor is a **singleton per Claude config dir** — its
socket is `/tmp/cc-daemon-<uid>/<hash(configDir)>/control.sock` (e.g.
`3a51c0b7` for `~/.claude_axiomus`) — and claude starts it **on demand**, so
whoever asks first owns it. Born inside a box it is crippled twice:

1. **It can't exec `/bin/ps`.** The daemon reads its own start time by shelling
   out to `ps`, which is setgid `kmem`; Seatbelt refuses setgid execs regardless
   of the `process-exec` grant. It falls back to a **procStart-less lock**, and
   from then on "kill paths will refuse to signal this daemon" — `claude daemon
   stop` won't stop it, and an on-demand daemon "never displaces a running one".
   A stuck, useless singleton.
2. **The sandbox is inherited and can't be dropped.** Every worker the daemon
   spawns for a remote session stays inside *that* box's profile, so a session
   for any other project can't even read its own directory and dies:
   `bg settled … (crashed): exit 1 before init`.

The user-side log showed exactly this on 2026-08-30 14:34: the `procStart-less
lock` warning followed by three `(crashed): exit 1 before init` workers and an
`idle_exit`.

### The fix

`clabox -b <box> daemon` (see `src/daemon/daemon.ts`) spawns `claude daemon …`
with the box's `configDir` + `config.env` but **no `sandbox-exec` and no
`ulimit`**. Start it once per Claude profile, before/independently of the boxes,
and every box's `/rc` reuses the healthy daemon instead of spawning a sandboxed
one:

```sh
clabox -b ax daemon --detach     # background; log → <configDir>/daemon.log
clabox -b ax daemon status
clabox -b ax daemon stop --any   # `stop` alone refuses to stop a transient daemon
```

Note a foreground/explicit daemon (`origin=foreground`) stays up; only the
on-demand (`origin=transient`) one exits with `idle 5s with no clients`.

### Recovering a stuck sandboxed daemon

`claude daemon stop` can't signal it (no `procStart` in the lock), so kill it by
pid and clear the socket dir:

```sh
pgrep -fl 'claude daemon'        # pid also in <configDir>/daemon/roster.json
kill -9 <pid>
rm -rf /tmp/cc-daemon-501/<hash>  # hash = the dir name under /tmp/cc-daemon-<uid>
```

## `/rc` (and other flag-gated features) missing inside a box

**Symptom.** In a box, `/rc` is not in the slash-command menu and typing it gives
`Unknown command: /rc. Did you mean /im?`, while the same account in a plain
terminal has it.

**Status: SOLVED 2026-09-07 — it was the privacy env vars in the box's own
`env`, not the sandbox.** Nothing in clabox's profile is involved.

### Measured (claude 2.1.263, box `ax-mg`, same `configDir`, same cwd)

| Run | `/remote-control (rc)` |
|---|---|
| no sandbox, only `CLAUDE_CONFIG_DIR` | ✅ present |
| **sandbox**, only `CLAUDE_CONFIG_DIR` | ✅ present — the sandbox is innocent |
| no sandbox + `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` | ❌ gone |
| no sandbox + `DISABLE_TELEMETRY=1` | ❌ gone |
| full box minus `DISABLE_TELEMETRY` | ✅ present, connects |
| `DISABLE_TELEMETRY=1` in the shell + `clabox -b ax-mg -e DISABLE_TELEMETRY` | ✅ present |

### Root cause

Those vars turn **feature-flag fetching** off, and the command is registered as
`isEnabled: <gate>, isHidden: !<gate>()` behind the `tengu_ccr_bridge` flag — no
flags, code default `false`, command hidden (hence "Unknown command" rather than
an error). In the binary:

```js
function I(){ if (CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) return "essential-traffic";
              if (DISABLE_TELEMETRY) return "no-telemetry";
              if (Ie(DO_NOT_TRACK))  return "no-telemetry";
              return "default" }
```

Anthropic documents this as intentional — [Features that need feature-flag
fetching](https://code.claude.com/docs/en/env-vars#features-that-need-feature-flag-fetching)
lists Remote Control, auto mode by default, cross-machine session messaging,
`claude import` / `/import`, `/skill-doctor`, the advisor tool, artifact
comments, the v2 MCP runtime and more. Upstream reports:
[#76748](https://github.com/anthropics/claude-code/issues/76748) (exactly this,
closed as stale) and [#73320](https://github.com/anthropics/claude-code/issues/73320)
(same coupling breaks TUI mouse clicks; confirmed by a maintainer).

### Traps

- **Any one** of the four vars is enough, from any source — the box `env`, the
  login shell, `settings.json`'s `env` block. Clearing one while another remains
  looks like "the fix didn't work" (this is what happened here: after removing
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `DISABLE_TELEMETRY` still hid it).
- `DISABLE_TELEMETRY` / `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` count **any
  non-empty value**: `=0` and `=false` still opt out. Only unsetting works.
  (`DO_NOT_TRACK` is parsed as a normal boolean.)
- There is no "telemetry off + flags on" combination. The reverse exists
  (`DISABLE_GROWTHBOOK` kills flags but leaves telemetry on).
  `DISABLE_ERROR_REPORTING` is independent and safe.
- A quick check without launching a TUI: the same vars also make the session
  start in `⏸ manual mode` instead of `⏵⏵ auto mode` on Pro/Max/Team.

### Fix

Drop the vars from the box's `env` (in `_presets.mjs`), or unset them per launch
from the CLI:

```sh
clabox -b ax-mg --rc                  # unsets all four blockers (FLAG_FETCH_BLOCKERS)
clabox -b ax-mg -e DISABLE_TELEMETRY  # or one by hand; a bare key = `env -u KEY`
```

`--rc` clears the whole set on purpose — a subset leaves `/rc` hidden and looks
like the fix failed. This is also why `config.env` accepts `null` values: the box
inherits the shell env, so a var can only be neutralized by unsetting it.

## A box escapes its own sandbox via a background task

**Symptom.** A session started with `clabox -b def` (a narrow profile) can read
and write things the profile denies — `~/Library/Logs/DiagnosticReports`,
`~/Desktop`, anything. The very same session refused those paths minutes
earlier, with no restart in between and no config change.

### What was measured

In the escaped session, `ls ~/Library/Logs/DiagnosticReports` succeeded and
`touch ~/Desktop/.wtest` succeeded, while `~/.ssh/id_*` was still unreadable —
i.e. it looked like the `root` box (`readWrite: ['/']`), not `def`. But the box
was `def`. Two facts settled it:

```sh
# 1. the PID had changed (77164 → 80888): a different process
echo "$CLAUDE_PID"

# 2. no sandbox-exec anywhere in the ancestry
#    87097 zsh
#      ← 80888 claude --session-id <id> --fork-session --resume
#          ← 80821 ClaudeCode.app --bg-pty-host /tmp/cc-daemon-501/<hash>/pty/<id>.sock
#              ← 39937 /Users/<me>/.local/bin/claude daemon run   (PPID 1 = launchd)
ps -eo pid,ppid,command | grep -c sandbox-exec   # → 0
```

### Root cause

A Seatbelt profile is applied at `exec` and inherited by children; it can never
be widened or dropped on a live process. So a box cannot escape *itself* — but
it can get **another process** to do the work.

Claude Code has exactly that door. A background task (and the on-exit handoff)
is not forked from the session: it is started by the **Remote Control daemon**,
which `clabox … daemon` deliberately runs **outside** the sandbox (see the
[`daemon`](guideline.md#daemondaemonts-pure-builders--io-rundaemon--remote-control-unsandboxed)
section — inside a box the daemon is crippled, so unsandboxed is the *correct*
design for the daemon itself). The daemon then re-attaches the session with
`--fork-session --resume <same-session-id>`. The conversation context comes back
in full; the profile does not, because the new process was never `exec`'d under
`sandbox-exec`.

The trigger is mundane — anything that detaches and re-attaches a session.
Tabbing away from the session and back (◀/▶) is enough.

In other words: **Seatbelt binds to a process, a Claude session binds to a
transcript file.** Whenever the session outlives the process, the sandbox is
left behind.

### The fix

`buildEnvArgs` (`sandbox/run.ts`) forces `SANDBOX_ESCAPE_GUARDS`
(`utils/config.ts`) onto every sandboxed launch:

```
CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1
```

which keeps the session running in the process that holds the profile. (The name
comes from claude's own binary, which carries an internal
`backgroundTasksDisabled` / `unsandboxedCommandsDisabled` pair — the same idea,
from the other side.)

The opt-out is a **config flag**, not an env entry:

```js
allowBackgroundTasks: true   // I want bg tasks, and I accept running unsandboxed
```

(or `CLABOX_ALLOW_BACKGROUND_TASKS=1`). That it is a flag is load-bearing, not
stylistic: `env` takes its `-u` flags *ahead* of the `KEY=VALUE` list, so an
`env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: null }` would emit
`env -u KEY … KEY=1` and leave the var **set**. Only skipping the guard
altogether can turn it off — hence the flag. An explicit
`env: { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '0' }` does still win, since the
guard is emitted before `config.env` and the last assignment wins.

### Checking a live session

```sh
echo "$CLAUDE_PID"
ps -eo pid,ppid,command | grep sandbox-exec | grep -v grep
```

No `sandbox-exec` in the ancestry ⇒ no profile, whatever the box says. A
long-lived `claude daemon run` under launchd (`PPID 1`) is the thing that will
re-host a detached session unsandboxed; `claude daemon stop --any` removes it,
at the cost of `/rc`.

---

## Garbled welcome banner in Ghostty (`^[P>|ghostt…` over the logo)

Symptom, on launching a box in an ordinary Ghostty tab (with **or** without
`--rc`, so the tab decoration is not involved):

```
^[P>|ghosttClaude1Code[v2.1.26352c  ▐▛███▛█
▝▜██████▀  Opus 5 (1M context) with xhigh effort · Claude Max
  ▝▝ ▝▝    ~/Library/Mobile Documents/iCloud~md~obsidian/Documents/xx-lifemanager
```

### Root cause

That noise is **the terminal's own replies, echoed as input** — not output from
clabox or claude:

- `^[P>|ghostty …^[\` is the XTVERSION answer (DCS `> |`), i.e. the reply to
  `CSI > 0 q`;
- the `…52c` tail is a DA1 answer (`CSI ? … c`);
- `ESC` printed as `^[` is the `ECHOCTL` rendering the **line discipline** uses
  when it echoes control characters — terminals never draw it that way
  themselves.

Claude sends both as it boots (in the 2.1.263 bundle: `_f(">0q")` matched by
`type==="xtversion"`, `_f("c")` as the flush sentinel, plus an OSC 11 query for
light/dark detection — `sk().osc11Responsive`) and reads the answers back off
stdin. They are *input*: if they arrive while the tty is still in canonical mode
with `ECHO` on — the window before claude's early input capture
(`process.stdin.setRawMode(true)`, wrapped in a silent `try/catch`) has raw mode
up — the kernel prints them instead of claude consuming them. Inside a box the
window is wider, because every startup read goes through Seatbelt. Ghostty shows
it first simply because it answers in microseconds; a slower terminal tends to
reply once claude is already in raw mode, and Terminal.app doesn't answer
XTVERSION at all.

### The fix

`sandbox/tty.ts#suppressEcho` — the launcher owns the terminal until the
handoff, so it snapshots the termios (`stty -g`), drops `echo`, and restores the
snapshot in a `finally` around `spawnSync`. Since libuv snapshots the tty state
on claude's **first** `setRawMode`, claude's own raw-mode toggles then restore
*that* echo-less state rather than a noisy one, which covers the later gaps too
(early capture → Ink mount). Every `stty` failure degrades to a no-op guard, and
`CLABOX_TTY_GUARD=0` opts out.

Not fixed by this (and not clabox's to fix): the probe answers are still not
consumed, so claude's terminal/theme detection can fall back to its defaults —
visible in a debug log as `systemTheme: OSC 11 query (via=…) got no response`.

---

## Ghostty shows the Secure Input padlock on every box launch

Ghostty's title bar grows a padlock and the tooltip says *"Secure Input is
active… enabled automatically whenever Ghostty detects a password prompt in the
terminal"*. Nothing is asking for a password.

### Root cause

macOS Secure Input (`EnableSecureEventInput`) stops **every** application from
reading keyboard events — including legitimate accessibility software, per
Ghostty's own documentation. Ghostty turns it on by itself when
`macos-auto-secure-input` (default **true**) decides a password is being typed;
the detection is a termios heuristic (`tcgetattr` on the pty — the binary
carries both `tcgetattr` and `passwordInput`), and the signature it looks for is
**ECHO off while ICANON is still on** — exactly what `read -s` and `sudo` leave
behind.

That is precisely what the first version of the launch echo guard
(`sandbox/tty.ts`) did: a bare `stty -echo` before handing the terminal to
claude. Every box launch therefore looked like a password prompt, and the
padlock latched on.

### The fix

`MUTE_ARGS = ['-echo', '-icanon']` — clear canonical mode too, so the handoff
window looks like the TUI it actually is rather than a password prompt. ISIG is
left alone, so Ctrl+C still works in it. If a padlock is stuck from an older
build, it clears when the terminal's termios is restored (close the tab, or run
`stty sane`).

Escape hatches, in order of bluntness: `CLABOX_TTY_GUARD=0` (drop the guard, get
the garbled banner back), `macos-secure-input-indication = false` (hide the
padlock but keep the behaviour — not recommended), `macos-auto-secure-input =
false` (turn the whole detection off).
