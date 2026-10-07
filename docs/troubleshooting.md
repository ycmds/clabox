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

## Seeing and killing processes in a box

**Symptom.** The agent starts `npm run dev`, then can neither find it nor stop
it: `kill` says `Operation not permitted`, `ps` and `top` say `operation not
permitted: /bin/ps`, `pgrep`/`pkill` say `sysmon request failed with error:
sysmond service not found` → `Cannot get process list`, and even a plain `cmd &`
warns `nice(5) failed: operation not permitted`. Servers pile up until the box
exits.

**Status: SOLVED 2026-09-18.** Three unrelated causes, so fixing one alone looks
like nothing changed.

### 1. `signal` was never granted

`(deny default)` covers `kill(2)` like everything else, and the profile had no
`signal` rule — so every process the agent spawned was immortal. The fix is a
grant that is scoped rather than global (`src/sandbox/profile.ts`, "process
control"):

```lisp
(allow signal
  (target self)
  (target children)
  (target same-sandbox)
)
(allow process-info-setcontrol
  (target self)
)
```

The `target` filter is the whole point. `children` covers what the process
spawned directly; `same-sandbox` covers the rest of the tree, because the
profile is inherited across `fork`/`exec` and **cannot be dropped** — so a
grandchild (`npm` → `node` → `frpc`), even one reparented to launchd, is still
inside *this* box, while everything outside it stays unreachable. `(target
others)` is what a global grant would look like, and it is never emitted.

The filter is undocumented by Apple, so the boundary is pinned by a functional
test rather than by trust: `tests/profile.test.ts` starts a `sleep` **outside**
any sandbox and asserts a box cannot signal it. Chromium's renderer profile and
Apple's own `application.sb` / `securityd.sb` / `WindowServer.sb` use the same
idiom.

`process-info-setcontrol` is `setpriority(2)` — zsh job control nices its
background jobs, which is where the `nice(5) failed` line came from.

### 2. `ps` and `top` can't be exec'd at all — and no rule can fix it

Both are setuid **root** (`-rwsr-xr-x root wheel`), and Seatbelt refuses to exec
any setuid/setgid binary. The denial is `forbidden-exec-sugid` and it is
enforced regardless of how wide `process-exec` is. Apple was asked directly for
a profile directive to exec a suid binary de-privileged; the answer was no.

So clabox *removes* privilege instead of granting any (`src/sandbox/proctools.ts`):
a plain copy of `/bin/ps` has no setuid bit and is installed into
`<claboxHome>/bin/ps`, which the box's PATH points at first. `ps` only needs
root for processes owned by **other** users — `KERN_PROCARGS2` and most of
`proc_pidinfo()` are gated by `PRIV_GLOBAL_PROC_INFO`, same-uid lookups are not
— so the copy still shows everything the agent started, and nothing belonging to
root or another user. Strictly less visibility than before, and **no new rule in
the profile**: `<claboxHome>` already carries the post-deny read + `process-exec`
carve-out.

One catch worth remembering: the copy is **SIGKILLed on launch (exit 137)**
until it is re-signed. `/bin/ps` carries the restricted entitlement
`com.apple.system-task-ports.read`, honored only for Apple platform binaries; a
copy isn't one, so AMFI kills it. `codesign -f -s -` drops Apple's signature
along with the entitlement and the copy runs. That is why the install stages
into `<name>.new` and renames only after signing — a box must never exec a
still-Apple-signed copy.

`clabox info` reports the state (`procTools   ps: ready`); `clabox run`
reinstalls the copy whenever macOS replaces `/bin/ps`.

### 3. `pgrep`/`pkill` are deliberately left broken

They are not setuid, so they *would* work — they link `libsysmon.dylib` and need
`(allow mach-lookup (global-name "com.apple.sysmond"))`. That rule is **not**
emitted: it is the one fix here that opens a new channel out of the box (a mach
service), and the de-privileged `ps` already answers the same question without
opening anything. Use `ps` + `kill`, or add the rule to a box's own profile if
you want `pkill` badly enough.

## EPERM noise in a box's debug log

Running a box with `--debug` surfaces these — the first two were real profile
gaps and are now fixed in `src/sandbox/profile.ts` ("Claude runtime state &
caches"):

| Path | Verdict |
|---|---|
| `~/.local/state/claude/locks/<version>.lock.tmp.*` | **was read-only** → now RW. Claude takes a version lock at startup; the RO grant produced `NON-FATAL: Lock acquisition failed`. |
| `~/Library/Caches/claude-cli-nodejs/**` | **was ungranted** → now RW. Per-MCP-server log batches were dropped. |
| `posix_spawn 'ps'` | Expected but **not harmless** — `/bin/ps` is setuid **root** and Seatbelt refuses to exec any setuid/setgid binary (no `process-exec` grant can help). Tools that only *read* the process table are fine (`process-info*` covers them); for everything else the box's PATH now points at a de-privileged copy — see [Seeing and killing processes in a box](#seeing-and-killing-processes-in-a-box). |
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
   out to `ps`, which is setuid **root**; Seatbelt refuses to exec any
   setuid/setgid binary regardless of the `process-exec` grant. It falls back to a **procStart-less lock**, and
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

## A cloned app is invisible to window managers (`pid = -1`)

**Symptom.** Rectangle (or any window manager) refuses to move the windows of a
box's `.app` while every other app on the machine works. Secondary symptoms from
the same root cause: AppleScript can't target the app, Dock integration behaves
oddly, and TCC prompts arrive under an identity that isn't the bundle's.

**What it looks like.** `NSWorkspace.runningApplications` lists the app with
`processIdentifier == -1`, even though the process is alive and `isTerminated`
is false:

```
pid=-1   policy=0  term=0  launched=1  bid=com.ghostty.custom.is.mg
   exec=/Users/me/.config/clabox/apps/XX Lifemanager.app/Contents/MacOS/ghostty.real
```

A window manager walks `frontmostApplication → .processIdentifier →
AXUIElementCreateApplication(pid) → AXWindows`. Handed `-1` it builds an AX
element for a process that doesn't exist, gets an empty window list, and does
nothing — no error, no log.

**Not the cause.** Two plausible readings are both wrong, and checking them is
cheap:

- *"The launcher spawns and exits, so the process is orphaned."* It isn't:
  `lsappinfo` reports `originalPid=37425` and `ps` reports pid `37425` — one
  process, image replaced in place. The launcher already used `execv`.
- *"`ppid = 1` means it was reparented after its parent died."* Every GUI app
  has `ppid 1`; Finder does too. LaunchServices starts them via launchd.

**The cause.** LaunchServices keys its record on the **running executable
path**. A bundle whose `CFBundleExecutable` is a wrapper that re-execs
`ghostty.real` changes that path out from under LS the moment it starts — and
`execv` preserving the pid doesn't help. LS responds by filing the launch data
under `originalExecutablePath`/`originalPid` and **clearing the `pid` field**,
which is exactly what `NSRunningApplication.processIdentifier` reads.

`lsappinfo` shows the difference directly — a healthy app has a `pid = <n>`
line, the wrapped clone has none:

```console
$ lsappinfo info com.apple.finder
    executable path="/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder"
    pid = 662 token=[sess=100020 pid=662 …]

$ lsappinfo info com.ghostty.custom.is.mg
    executable path=".../XX Lifemanager.app/Contents/MacOS/ghostty.real"
 token=[sess=100020 pid=37425 …]                      ← no `pid = …` line
    originalExecutablePath=".../Contents/MacOS/ghostty" originalPid=37425
```

The wrapper hurts signing identity too: the binary that ends up running is
signed standalone (`Identifier=ghostty`, `Info.plist=not bound`) rather than as
the bundle's sealed main executable, so TCC sees something other than the app.

**The fix (already in `init`).** Keep the donor's binary as the bundle's one and
only executable and deliver the config out of band: `Info.plist` carries
`LSEnvironment = {XDG_CONFIG_HOME: <baseDir>/ghostty-home/<box>}`, and that
directory holds `ghostty/config` with a single `config-file = <baseDir>/ghostty/<box>.config`.
macOS exports `LSEnvironment` for every LaunchServices start (Dock, Finder,
`open`, Raycast), which is how app boxes are launched. A/B on the same donor and
the same signing identity, differing only in the wrapper:

```
com.ghostty.custom.claboxprobe   pid=50952   ← no wrapper
com.ghostty.custom.is.mg         pid=-1      ← wrapper
```

**Don't reintroduce a wrapper binary.** If `Contents/MacOS/ghostty.real` exists
in a built bundle, this bug is back. After upgrading, re-run `clabox init` and
restart the apps — a rebuild is required, a restart alone changes nothing,
because the pid is lost at every launch.

**Two caveats.**

- Ghostty also reads `~/Library/Application Support/com.mitchellh.ghostty/config`,
  whose path is hard-coded to the *upstream* bundle id (a clone cannot get its
  own) and which takes priority over the XDG path when non-empty. A user config
  there would shadow the generated one, so `init` warns about it; keep your
  personal Ghostty config at `~/.config/ghostty/config` instead.
- `XDG_CONFIG_HOME` is inherited by everything the terminal spawns, and plenty
  of tools key off it (`gh` reads `$XDG_CONFIG_HOME/gh/hosts.yml`). The
  generated `command` therefore unsets it again before the box starts — but
  only when the value is still ours (`[ "$XDG_CONFIG_HOME" = <ours> ] && unset
  …`), since `zsh -lic` has already re-exported a user's own value from the
  login profile by that point.

## Every app box asks for Accessibility on each launch

**Symptom.** Launching a box's `.app` pops "«<App>» would like to control this
Mac and access your data" (Privacy & Security → Accessibility). Denying doesn't
stick: the prompt returns at the next launch, for every app box.

**The cause.** Not the sandbox and not the clone — Ghostty asks. A `keybind =
global:…` (e.g. `global:cmd+backquote=toggle_quick_terminal`) needs a **global
event tap**, and a tap needs Accessibility; the binary's own strings spell it
out (`No accessibility permission detected, prompting...`, `creating global
event tap failed despite Accessibility permission`). Since the generated app
config pulls in `appBuilder.baseGhosttyConfig` via `config-file`, a global
keybind living there is inherited by *every* clone, so each one prompts.

**The fix.** Keep `global:` keybinds out of the shared base config — move them
to your personal Ghostty config (`~/.config/ghostty/config`), which only the
real Ghostty reads. Per box instead: `app: { ghostty: { keybind:
'cmd+backquote=unbind' } }` — `unbind` is a real Ghostty action and
`app.ghostty` is emitted after the base `config-file`, so it wins. (`app.ghostty`
is a `Record<string, string>`, so that's one keybind per box.)

**Don't just grant Accessibility.** The prompt goes away, but then every clone
*and* the real Ghostty compete for the same global hotkey — whichever installs
the tap first wins it.

---

## A box can `stat` — and open a socket in — a directory it cannot read

**Symptom.** Inside a box, the 1Password agent socket is reachable while its
directory is not:

```
$ ls   "~/Library/Group Containers/2BUA8C4S2C.com.1password/"
ls: …: Operation not permitted
$ stat -f '%Sp %z' "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
srw-------  0            # answers
```

Two independent holes, often mistaken for one. Fixing the first does **not**
close the second.

### 1. `stat` was granted globally (fixed)

The profile's introspection block carried a bare, unfiltered

```lisp
(allow file-read-metadata)
```

added so `ps`/`lsof`-style tools could stat what they enumerate. In SBPL,
`file-read-metadata` and `file-read-data` are **separate operations**: every deny
tier in the profile denies `file-read*`/`file-write*`, which hides *contents* and
*listings*, but the unfiltered metadata grant kept existence, size, mode and
mtime readable for every path on the disk. A box could therefore walk a denied
tree by full path — confirming which files exist and how big they are — while
`cat` and `ls` both failed. Directory *listing* needs `file-read-data` on the
directory, which is why `ls` was denied and a full-path `stat` was not.

**Fix.** `stat` became the narrowest of three path-scoped classes
(`stat` ⊂ `read` ⊂ `write`, see `PathRules`): implied by any read/write grant
(`file-read*` already covers metadata), re-openable per path via `paths.stat` /
`--stat`, and granted automatically on the **ancestors** of granted paths — as
`literal` entries, emitted as the last file rule in the profile (it has to
outlive the hard deny: the carve-out for `~/.config/clabox` sits after a hard
deny of `~/.config`, so a lookup of the box's own `--mcp-config` needs metadata
on the intervening directory). `~/.ssh` is stat-able, `~/.ssh/id_ed25519` is not.

When adding an allow rule to `buildProfile`, build its matcher with the local
`sp()`/`lit()` wrappers — that's what records the path for the ancestors pass.
A rule using bare `subpath`/`literal` still works; it just leaves its ancestors
unstat-able, which surfaces later as an `EPERM` partway down a path rather than
at the leaf.

### 2. `connect()` to a Unix socket is network, not file I/O (fixed)

Reading the socket *file* fails (`head agent.sock` → `Operation not supported on
socket`), but `connect(2)` to it does not go through `file-read*` at all. In
Seatbelt an AF_UNIX connect is authorized as **`network-outbound` with a path
filter** — the idiom is visible in Apple's own profiles under
`/System/Library/Sandbox/Profiles`:

```lisp
(allow network-outbound (remote tcp) (local tcp) (literal "/private/var/run/mDNSResponder"))
(allow network-outbound (literal "/private/var/run/lockdown.sock"))
```

clabox emits `(allow network*)` — **no filter** — whenever `config.network` is
true, so TCP, UDP and a connect to *any* Unix socket at *any* path are one and
the same grant. No amount of file hardening touches it: the `denyHome` tier, the
hard secret deny and `denyGlobs` are all file rules.

What that buys an agent in a box: 1Password's `agent.sock` is its **SSH agent**,
so the private key never leaves 1Password but the box can ask it to sign — i.e.
authenticate as you (`git push`, `ssh` to prod) for as long as the agent keeps
agreeing. Same class of reachability for `/var/run/docker.sock` (root on the host,
outside every box), `op` CLI sockets, `gpg-agent`, and anything else that listens
on a Unix socket.

**Fix.** Networking is now split by address family, and unix sockets are opt-in:

```lisp
(allow network-outbound (remote ip))      ; IP out, as before
(allow network-inbound  (local ip))
(allow network-bind     (local ip))
(allow network-outbound                  ; + only what the box names
  (literal "/private/var/run/mDNSResponder") (subpath "/private/var/run/mDNSResponder")
  (literal "/private/tmp/cc-daemon-501")    (subpath "/private/tmp/cc-daemon-501"))
```

A box opens one with `paths: { '/var/run/docker.sock': 'c' }`, `paths.socket: [...]`
or `--socket <path>`; each entry is emitted as both `literal` and `subpath`, so it
does not matter whether the path is a socket file or a directory of them. A
`paths.deny` entry now also removes socket connect (the soft tier emits a matching
`deny network-outbound`), and socket grants are emitted even with
`network: false` — local IPC is not internet access.

Two paths stay allowlisted by default, because removing them breaks things that
read as unrelated failures:

- `/private/var/run/mDNSResponder` — the system resolver. Without it name
  resolution fails inside the box, which looks like "claude can't reach the API".
- `/private/tmp/cc-daemon-<uid>` — claude's daemon dir. Remote Control (`/rc`)
  speaks to the singleton `claude daemon` over `control.sock` there, and the
  `--bg-pty-host` sockets live beside it. This is **not** the background-task
  escape hatch: that one is closed in the environment by `SANDBOX_ESCAPE_GUARDS`,
  because the escape is the unsandboxed daemon re-launching the session, not the
  socket it is asked over.

Verified with a functional test that binds a unix socket *outside* the sandbox in
`/tmp` (a directory the box has full read-write on, so the only thing in the way
is the network rule), then connects to it from inside a box twice: denied with the
default profile, connected once the path carries `'c'`. Plus a TCP test against a
local listener, so the IP half is kept honest.

## A box could read `~/.local/share/<app>` and no config said so

**Symptom.** You ask a box to check its own reach and it reports access to
something nobody granted it:

```
~/.local/share/<app>/<app>.db   331 MB, -rw-r--r--   reads fine
sqlite3 … 'SELECT COUNT(*)'     117 742 rows         works
ls ~/.local/share/<app>/                             lists
```

Nothing in the box config mentions that path. Grepping the generated profile for
the app's name finds nothing either — which is what makes it hard to attribute.

**Cause.** `profile.ts#detectPackagePaths()`, now removed. It probed the
filesystem for package managers and granted each hit as a whole tree:

```ts
const local = path.join(HOME, '.local');
if (fs.existsSync(local)) paths.push(local);   // → (subpath "~/.local"), rights `rme`
```

`~/.local` exists on every machine (claude's native installer lives there), so
the probe always fired. XDG splits that directory — `bin`/`lib` are tools,
`share`/`state` are **application data** — and the grant made no such
distinction. In the profile it appears only as the parent:

```
;; ---------- package managers + Xcode / Command Line Tools (autodetected)
(allow file-read* file-map-executable process-exec
  (subpath "/Users/<you>/.local")      ← everything under here
```

No write (`rme` carries no `file-write*`), so the data could be read, enumerated
and copied, not modified.

**Fix.** The probing is gone; the locations are base-policy data in
`policy/base.ts` ("package managers & user-installed toolchains"). A rule for an
absent path matches nothing, so listing every usual location costs nothing and
the `existsSync` bought nothing. `~/.local` is now granted per toolchain root:
`bin`, `lib`, and `share/{claude,mise,uv,pipx,pnpm,rustup}`.

**The part to not get wrong when editing that list:** `~/.local/bin` holds only
symlinks, and Seatbelt matches the **resolved** path — so granting `bin` alone
authorizes nothing:

```
$ ls -l ~/.local/bin/claude
… claude -> /Users/<you>/.local/share/claude/versions/2.1.289
```

Each target root needs its own entry, and `~/.local/share/claude` is load-bearing:
without it the box cannot exec the very binary clabox launches. Same shape for
`uv` tools (`~/.local/share/uv/tools/<x>/bin/<x>`) and `cursor-agent`.

**Adding one back** — a tool that lives under `~/.local/share` and isn't in the
default list:

```js
paths: { '~/.local/share/cursor-agent': 'rme' }
```

and the inverse, which was impossible while the parent was granted wholesale:

```js
paths: { '~/.local/share/<app>': 'd' }
```

Pinned by `tests/profile.test.ts` → *"~/.local is granted per toolchain, not as a
tree"*, which asserts `(subpath "<HOME>/.local")` is absent from the default
profile.

## No `git`, no `python3`, and `curl` claims the box has no network

Three separate EPERMs that each present as a broken *tool* rather than as a
sandbox denial, so each one gets blamed on the wrong thing. All three were the
profile; all three are fixed in `BASE_PATH_GROUPS`.

### 1. `xcode-select: unable to read data link at '/var/select/developer_dir'`

```
$ git --version
xcode-select: error: unable to read data link at '/var/select/developer_dir', expected symbolic link (Operation not permitted)
xcode-select: error: No developer tools were found and no install could be requested
$ python3 -c 'print(1)'      # same, before CPython starts
```

`/usr/bin/{git,python3,clang,swift}` are shims: they resolve the *selected*
toolchain through the link `xcode-select` maintains, then exec it. The profile
granted the destination (`/Library/Developer/CommandLineTools`,
`/Applications/Xcode.app`) but never the link, and a shim reads the link **first** —
so the whole Apple toolchain was dead in every box, which reads as "developer
tools are not installed" and tempts you into `xcode-select --install`.

Apple also **moved** the link: `/var/db/xcode_select_link` through macOS 15,
`/var/select/developer_dir` on 26+. `resolvedDeveloperDirs()` only knew the old
path, so on a current mac it silently resolved to nothing — the function appeared
to work (it returns `[]` best-effort) while contributing no grant at all.

**Fix:** `XCODE_SELECT_LINKS` reads both locations, and both are granted.
`/var/select` is granted as a tree, not just the one link — it's the system's
alias dir, and `/var/select/sh` is read by **every** `/bin/sh` startup:

```
$ /bin/sh -c 'exit 0'
Error opening /private/var/select/sh: Operation not permitted
```

which otherwise appears, unexplained, in the middle of any command that uses a
shell (including `bun test` output).

### 2. `curl` rejects all HTTPS — and it is *not* the network rule

```
$ curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/
000
$ curl -v https://registry.npmjs.org/ 2>&1 | grep certificate
* error setting certificate verify locations:  CAfile: /etc/ssl/cert.pem CApath: none
```

`http_code 000` with `network: true` looks like the box has no outbound access.
It has:

```
$ node -e 'fetch("https://registry.npmjs.org/").then(r=>console.log(r.status))'
200
$ curl -s -o /dev/null -w '%{http_code}\n' --cacert /private/etc/ssl/cert.pem https://registry.npmjs.org/
200
```

The denial is a *file* one, on a symlink. Seatbelt matches the resolved path, so
`/private/etc` being granted is what authorizes the read — but walking
`/etc/ssl/cert.pem` also **reads the `/etc` link**, and nothing granted it: the
stat-ancestors pass only climbs *above* granted paths, and no grant lives under
`/etc`. Hence:

```
$ head -c 1 /etc/ssl/cert.pem           # Operation not permitted
$ head -c 1 /private/etc/ssl/cert.pem   # fine
```

**Fix:** `'/etc': 'sl'` — `file-read-metadata` on the link only (`literal`, never
`subpath`), contents still coming from `/private/etc`. `/tmp` + `/private/tmp`
were already granted as such a pair; any symlinked system root needs both forms.

### 3. npm blames `sudo chown` for a sandbox denial

```
$ npm view some-package version
npm error code EPERM
npm error syscall mkdir
npm error path /Users/<you>/.npm/_cacache/tmp
npm error Your cache folder contains root-owned files, due to a bug in previous
npm error versions of npm which has since been addressed.
npm error To permanently fix this problem, please run:
npm error   sudo chown -R 501:20 "/Users/<you>/.npm"
```

The cache was simply not granted. npm answers *any* EPERM under `~/.npm` with
that message, so the box looks like a corrupted npm install, and the suggested
`chown` fixes nothing (the files are already yours — run `ls -ld ~/.npm` outside
the box to confirm).

**Fix:** `'~/.npm': 'rw'` in the base policy — npm `mkdir`s `_cacache/tmp` on
every command, so read-only would not be enough. No credentials live there;
registry tokens are in `~/.npmrc`, which stays ungranted. Workaround without
rebuilding: `npm --cache "$TMPDIR/npm" …`, since `$TMPDIR` is already RW.

### Telling these apart next time

The pattern across all three: **a tool reports a cause from its own domain**
(no developer tools / no network / corrupted cache) **for what is a path
denial.** Check the profile before believing the tool:

```
grep -n '<path>' "$TMPDIR"/clabox-<project>-*.sb   # is it granted at all?
ls -ld <path>                                      # EPERM in-box, fine outside → profile
```

An `Operation not permitted` on a path you can read from a normal shell is always
the sandbox, never a file-permission problem — `sudo` is never the fix.

---

## A box starts a process outside itself with `open` (and `--trust` / inline profiles)

Three findings from a security review of the live `def` box, all of the same
shape: **the box writes something, and a process outside the box runs it.**
Fixed; recorded here because the shape recurs and the fixes have visible
side effects.

### 1. `open` was a clean escape — now off by default (`config.allowOpen`)

The profile used to end with `(allow process-fork)\n(allow lsopen)`, plus
`mach-lookup` on `launchservicesd` / `coreservicesd` / `lsd.*` ("needed by
`/usr/bin/open`"). Those two halves compose:

```sh
# in-box baseline: $HOME root is read-only ('rl' — the dir, not its contents)
touch ~/probe                      # → Operation not permitted

APP=/tmp/Esc.app; mkdir -p "$APP/Contents/MacOS"
# …minimal Info.plist with CFBundleExecutable=run…
printf '#!/bin/sh\necho "uid=$(id -u) ppid=$PPID" > /tmp/launched.txt\n' \
  > "$APP/Contents/MacOS/run"
printf 'echo escaped > "$HOME/ESCAPE.txt"\n' >> "$APP/Contents/MacOS/run"
chmod +x "$APP/Contents/MacOS/run"
open -W "$APP"
# /tmp/launched.txt → uid=501 ppid=1   (launchd, no profile)
# $HOME/ESCAPE.txt  → created, and the box then cannot even unlink it (EPERM)
```

`open` forks nothing in-box: it hands the bundle to LaunchServices, which runs
outside every sandbox and starts the target under launchd. The box supplies the
bundle (`/tmp`, `$TMPDIR` and the project are all writable), so the pair is
arbitrary code execution as the user — needing **no** running daemon, unlike the
background-task escape. The profile had already refused `appleevent-send` on
exactly this reasoning; `lsopen` was the same door.

Now both the operation and the Launch Services mach services are emitted only
for `config.allowOpen: true` (env `CLABOX_ALLOW_OPEN=1`), and they move
together — the gate is checked by the receiving service, so leaving its ports
reachable would be half a fix. `com.apple.lsd.mapdb` stays granted: it is the
read-only type/UTI database many frameworks consult and it starts nothing.

**What you'll notice in a box:** `open` fails, `open`-based helpers (an `o()`
alias, `xdg-open` shims) fail, and in-box `/login` can't pop a browser — log in
from an unsandboxed shell, or set `allowOpen: true` for that box and treat it as
unsandboxed. `clabox info` lists whatever a box opted into in its `escapes` row.

### 2. The profile file lived where the box could rewrite it

`$TMPDIR/clabox-<dir>-<hash>.sb` — fully determined by the project path, and
`$TMPDIR` is granted read-write to every box, so the file holding a box's own
policy was writable by that box:

```sh
f="$TMPDIR/clabox-$(basename "$PWD")-*.sb"; test -w $f && echo writable  # → writable
printf '(version 1)(allow default)\n' > "$TMPDIR/clabox-PROBE.sb"        # accepted
ln -s /tmp/victim "$TMPDIR/clabox-LINK.sb"; printf x > "$TMPDIR/clabox-LINK.sb"
cat /tmp/victim                                                          # → x
```

Two uses: overwrite the file with `(allow default)` after the launcher writes it
but before `sandbox-exec -f` reads it (the launcher does several more fork/execs
in between — extras, proctools, `ps`, `sysctl`, `stty` — and nothing reaps a
process the box left running), so the *next* launch of that box is unsandboxed;
or plant a symlink and let the launcher's `writeFileSync` (no `O_EXCL`, no
`O_NOFOLLOW`) truncate the target.

The launch now passes the profile **inline** (`sandbox-exec -p <text>`): ~8 KB
against a 1 MB `ARG_MAX`, and no file to race. `clabox generate` still writes a
copy — under `~/.config/clabox/profiles/` (read-only in-box), `0600`, via an
`O_EXCL` stage + `rename`.

**Side effect to know:** the profile text is now visible in `ps` output for the
`sandbox-exec` process (paths only, no secrets), and the old `$TMPDIR` path is
gone — scripts that grepped it should use `clabox generate` or
`clabox profile`. `CLABOX_DEBUG=1` prints `Profile: inline (<n> bytes)`.

### 3. `clabox.config.mjs` in a repo was loaded as code

`findConfigFile` probes the CWD, so a bare `clabox` in a project picks up
`./clabox.config.mjs` — a file the agent can write — and `loadConfig`
`import()`s it *before* any profile exists. Same door via `-b ./boxes/vibe.mjs`
and via `clabox init --dir <repo>`, which imports **every** config under
`<repo>/configs` (`--no-apps` only skips the app build, not the import: cloning
and init'ing an untrusted repo was RCE).

Now a config outside `~/.config/clabox` must be recorded first, and the record
is keyed by content:

```bash
clabox trust ./clabox.config.mjs    # record it
clabox trust --list                 # ⚠️ marks records whose file changed since
clabox --trust -b ./boxes/vibe.mjs  # accept for one run, without recording
clabox init --dir ./repo --trust    # init imports every config → same gate
```

A second check runs after the merge: if the config file sits inside a tree the
*resulting* box can write (project dir, `configDir`, `$TMPDIR`, any `write`
grant), it's refused even when trusted — the agent could otherwise widen its own
`paths` for the next run. This is what fires for the **clabox-home-symlinked-
into-a-repo** layout: nominally the config is in the read-only home, physically
it's in the project, and Seatbelt matches the resolved path. Either move the
configs out of the writable tree or pass `--trust` deliberately.

The profile also write-denies `clabox.config.*`, `.git/config`, `.git/hooks` and
`.envrc` inside the project (`paths.denyWriteGlobs`), so the plant fails first.
If you need `git worktree add` / `git submodule add` / `git remote add` in a box
— all of which write `.git/config` — give that box its own `denyWriteGlobs`.

---

## A profile fix doesn't help: two traps before you debug anything else

Both of these look identical from inside a box — the grant is in the code, the
profile compiles, the access is still `Operation not permitted` — and they cost
hours each because the natural next step (re-reading the rule) is the wrong one.

### Trap 1: the running box carries the profile it was *launched* with

Seatbelt is applied at `exec` and never re-read, so editing the config or
upgrading clabox changes **nothing** for a box that is already open — including
the box you're typing in. The agent inside sees the old policy and reports the
old symptom, which reads exactly like "the fix doesn't work".

Check what the live box actually has, rather than what the code says:

```sh
# Is the path granted for THIS process at all? (EPERM here, fine in a normal
# shell ⇒ the profile, never file permissions — `sudo` is never the fix.)
ls -ld /var/select

# What the CURRENT code would generate (run it OUTSIDE a box — the clabox home
# is read-only in-box on purpose, and `generate` says so):
clabox generate && grep -n 'var/select' "$(clabox profile)"
```

Pre-`-p` boxes left their profile in `$TMPDIR/clabox-<dir>-<hash>.sb`, so for
one of those you can read the exact text it was launched with:
`grep -c var/select "$TMPDIR"/clabox-*.sb`. Current boxes get the profile
**inline** (`sandbox-exec -p`), and since `sandbox-exec` `exec`s its target the
text isn't visible in `ps` either — the live box's policy is only observable by
probing it, as above. Fix, then **open a new box**.

### Trap 2: a grant under `/etc`, `/tmp` or `/var` must be spelled RESOLVED

macOS ships those three as symlinks into `/private`, and Seatbelt matches a rule
against the **resolved** vnode path. So `'/private/var/db/timezone': 'r'` is what
lets a tool open `/var/db/timezone` — and a rule written `'/var/db/...'` matches
nothing whatsoever. The profile compiles, `sandbox-exec` accepts it, and the
access is denied.

The `literal` pattern that makes `/etc` work does **not** generalize:

```js
'/private/etc': 'rm',   // authorizes the contents (resolved form)
'/etc': 'sl',           // + the link itself: /etc IS the symlink, so this is that path
'/private/var/select': 'r',  // authorizes /var/select/** — the load-bearing half
'/var/select': 'r',          // harmless, and correct on a host where /var is real
```

A path *below* a symlinked root is a different vnode, so it needs the
`/private/...` rule; only the roots themselves can be granted as themselves.

This has bitten the project twice. First `/etc/ssl/cert.pem`: the system `curl`
could not open its default CAfile and failed **all** HTTPS with `http_code 000`,
which reads as "the box has no network" (while `node`'s `fetch` worked fine).
Then `/var/select/developer_dir`: the first attempt at that fix granted
`/var/select` plus a `literal /var/db/xcode_select_link`, i.e. authorized
nothing, so every toolchain shim kept dying with

```
xcode-select: error: unable to read data link at '/var/select/developer_dir',
expected symbolic link (Operation not permitted)
```

— no `git` and no `python3` in any box, which is the exact symptom the fix was
written for. `clabox` now carries the invariant as data (`PRIVATE_SYMLINK_ROOTS`,
`resolvedTwin()`) and a unit test asserts that **every** base-policy path under a
symlinked root has its `/private` twin, so the next one can't ship silently.

When a grant doesn't take, check the spelling before the rule.

---

## `clabox` dies with a bare parser error (`Error: Unexpected token '['`)

That is **your config file**, not clabox. A config is user JavaScript that
`loadConfig` `import()`s, so a syntax error in it surfaces as whatever the
module loader says — and the message used to carry no filename at all, which
reads as "clabox is broken" rather than "line N of this file is". It now names
the file:

```
Error: clabox: config '/path/to/clabox.config.mjs' has a syntax error: Unexpected }
Error: clabox: config '/path/to/boxes/vibe.mjs' failed to load: boom      # it threw at top level
```

To find *which* file is loaded when you didn't pass `-b`, the lookup order is:
`--config <path>` → `$CLABOX_CONFIG` → `./clabox.config.mjs` → `./clabox.config.js`
→ `~/.config/clabox/config.mjs`. The quickest confirmation is `clabox info`,
whose `configFile` row prints the resolved path (and its trust state) — and
which fails with the same error when the config is the problem, since `info`
loads it too. To check a file on its own:

```sh
node -e 'import("./clabox.config.mjs").catch(e => console.error(e))'
```

Note the two runtimes word it differently: Node raises a real `SyntaxError`,
Bun a `BuildMessage` from its own realm — `PARSE_ERROR_NAMES` in
`utils/config.ts` matches on `name` for that reason, since `instanceof
SyntaxError` is false under Bun and would mislabel a syntax error as a load
failure.

### If `clabox` is a symlink to a checkout, it runs `lib/`, not `src/`

`npm i -g` / `bun link` from a working tree leaves `clabox` pointing at
`<repo>/lib/cli.js`, so the CLI you type runs the **built** output — editing
`src/` changes nothing until `bun run build`. Check with `clabox info`:
`claboxBin` is the entry being executed and `claboxRoot` the package it resolved
to. A stale `lib/` is the other half of "I fixed it and nothing changed" (the
first half being a running box carrying its launch-time profile, above).

---

## "I can't open the current directory in Finder from a box"

Correct, and deliberate — `open` is a sandbox escape (`lsopen`, see the SEC-1
section above), and it takes no filters: "reveal this folder" and "launch the
`.app` the agent just wrote into /tmp" are the same operation to Seatbelt. The
symptom is LaunchServices refusing:

```
_LSOpenURLsWithCompletionHandler() failed with error -54 for the file /Users/me/…
```

Three ways out, cheapest first.

### 1. A `file://` link — zero config, zero new attack surface

```sh
printf 'file://%s\n' "$PWD"
```

Ghostty makes it clickable; cmd+click opens it. The terminal is already outside
the sandbox, so nothing in the profile has to change and the agent cannot act
on its own — you click. `pwd | pbcopy` plus Cmd+Shift+G in Finder works the same
way (the pasteboard mach services are granted).

### 2. The opener broker — `clabox opener`

For "the agent should be able to show me things", the brokered version keeps the
escape closed. Start one broker outside the sandbox — it serves every box:

```sh
clabox opener --detach                        # roots=$HOME, app picked per file type
clabox opener --root ~/vault --editor Zed --detach
```

The app is routed by type: code → the best installed editor, `.md` outside a
vault → a markdown reader (Typora/MacDown/Marked 2) before the editor, `.md` in
an Obsidian vault → Obsidian, images/PDFs → Preview, folders → Finder. Two
earlier defaults are worth knowing about because they look like bugs: the type's
registered handler opens `.md` in **Xcode** on a stock Mac (which then wants to
install system components), and `open -t` opens it in **TextEdit**. Both were
replaced by the routing table; `--editor` pins one app for everything.

and in any box:

```sh
clabox reveal .                   # Finder, via `open -R`
clabox open ./notes/today.md      # your editor
```

#### `operation not permitted: clabox` — the box can't exec clabox itself

Not a broker problem: the shell never got as far as the socket. The installed
`clabox` is a **symlink**, Seatbelt authorizes an exec against the
symlink-**resolved** path, and a dev install resolves into the source repo:

```
/opt/homebrew/bin/clabox → ../lib/node_modules/clabox/lib/cli.js
                         → /Users/me/projects/clabox/lib/cli.js   ← the path that must be granted
```

That path belongs to one box — clabox's own, via its project RW grant — so every
*other* box is denied. A global `npm i -g clabox` resolves under
`/opt/homebrew/lib/node_modules/`, which the package-manager autodetect already
grants, which is why this only shows up on a dev machine. Note the error names
the *caller*, so inside a shell helper it reads like a broken alias:

```
_cb_open:10: operation not permitted: clabox
```

This is **not** fixed in the profile compiler, on purpose: a machine-specific
install path is policy, and policy belongs in a config the user reviews.

**The better answer is not to exec clabox in the box at all.** The opener's wire
format is one line — `<action> <absolute path>` — the socket grant is already
there, and `nc` lives in `/usr/bin`, which every box can read and exec. So the
generated helpers (`<claboxHome>/opener/claude-aliases.sh`) talk to the socket
directly and need no grant beyond the one `opener.enabled` gives them:

```sh
printf '%s %s\n' reveal "$PWD" | nc -U ~/.config/clabox/opener/opener-$(id -u).sock
```

If you do want `clabox` itself runnable in a box, grant it narrowly in your own
preset — the built output and its deps, never the whole repo (a working tree
holds `.git`, scratch files and possibly other boxes' configs):

```js
paths: {
  '~/projects/clabox/lib': 're',           // read + exec the CLI itself
  '~/projects/clabox/node_modules': 'r',   // its deps (yargs, @lsk4/log)
  '~/projects/clabox/package.json': 'rl',  // node needs the "type": "module"; this file only
}
```

Two traps apply as usual: rebuild (`bun run build`) if `clabox` points at a
checkout's `lib/`, and **reopen the box** — a profile is applied at `exec` and
never re-read, so a running box keeps the one it launched with.

No per-box setup: every box may reach the broker, and the socket only exists
while one is running. A box opts out with `opener: { enabled: false }`.

What makes it not-an-escape: the request is `<action> <absolute path>` and
nothing else — no flags (one `-a`/`--args` and the agent is choosing what runs
again), a closed action vocabulary, the application comes from the config, and
`reveal` compiles to `open -R`, which per `man open` "reveals the file(s) in the
Finder **instead of opening them**". Each path is then realpath'd (a symlink
inside a root is how an in-root path aims at `/Applications`), must land inside
`roots`, must not be a bundle, and for `edit` must match the extension
allowlist. Refusals, the rate limit (12/min) and every allowed request land in
`~/.config/clabox/opener/opener.log` (socket and pid file sit in that same dir).

Expect these answers:

```
denied: path escapes the allowed roots     # also what a missing path returns
denied: inside an app bundle               # the .app payload
denied: file type not allowed              # `edit` of a .command/.scpt/…
denied: rate limited
opener: no broker on …/opener-<uid>.sock   # broker not running, or box lacks the grant
```

One thing that looks like a bug and isn't: the broker **must** be started
outside a box. Binding a unix socket needs `network-bind`, which no box has, so
in-box it fails with `cannot listen on … EPERM` and says where it belongs.
(Connecting is a different operation — that's what boxes are granted.)

### 3. `allowOpen: true` on that one box

Honest about what it is: the full escape, scoped to a box you'd be willing to
run unsandboxed. `clabox info` lists it in the `escapes` row.

**Residual risk worth knowing for (2) and (3):** an editor can execute what it
opens — Obsidian runs vault plugins and `dataviewjs`, VS Code has tasks. The
broker doesn't create that exposure (the agent already writes those files, and
you already open them by hand) but it does let the agent pick the moment, which
is why `opener.editor` defaults to null and reveal-only is the safest useful
setting.
