// Profile materialization + launching `claude` under sandbox-exec.

import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Config, expandHome, HOME } from '../utils/config.js';
import { boxSlug, buildBoxExtras, type ExtraFile } from './extras.js';
import { buildProfile, detectPackagePaths } from './profile.js';

const TMPDIR = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');

/** Deterministic per-project profile path under TMPDIR. */
export function profilePath(projectDir: string = process.cwd()): string {
  const hash = crypto.createHash('sha256').update(projectDir).digest('hex').slice(0, 8);
  return path.join(TMPDIR, `clabox-${path.basename(projectDir)}-${hash}.sb`);
}

/**
 * Effective project dir: `config.cwd` (with `~` expanded, resolved to an
 * absolute path so SBPL `subpath` rules stay valid) if set, else the shell CWD.
 */
export function resolveProjectDir(config: Config): string {
  return config.cwd ? path.resolve(expandHome(config.cwd)) : process.cwd();
}

/** Resolve a binary via the shell's `command -v`; null if not on PATH. */
export function which(bin: string): string | null {
  try {
    return (
      execFileSync('command', ['-v', bin], { shell: '/bin/sh', encoding: 'utf8' }).trim() || null
    );
  } catch {
    return null;
  }
}

function requireSandboxExec(): void {
  if (!which('sandbox-exec')) {
    throw new Error('sandbox-exec not found. This tool requires macOS with sandbox-exec.');
  }
}

function resolveClaudeBin(config: Config): string {
  const candidate = config.claudeBin || which('claude') || path.join(HOME, '.local/bin/claude');
  if (!candidate || !fs.existsSync(candidate)) {
    throw new Error(`claude not found at '${candidate}'`);
  }
  return candidate;
}

/** Generate the profile file for the current project, return its path. */
export function generateProfile(
  config: Config,
  projectDir: string = resolveProjectDir(config),
): string {
  requireSandboxExec();
  const file = profilePath(projectDir);
  const text = buildProfile(config, { projectDir, detectedPaths: detectPackagePaths() });
  fs.writeFileSync(file, text);
  return file;
}

/** Build the `env KEY=VALUE …` argument list forced onto the sandboxed claude. */
export function buildEnvArgs(config: Config): string[] {
  const sshDir = expandHome(config.bot.sshDir);
  const botKey = path.join(sshDir, 'id_ed25519');
  const botCfg = path.join(sshDir, 'config');
  const args = [
    `PATH=${path.join(HOME, '.local/bin')}:${process.env.PATH || ''}`,
    `CLAUDE_CONFIG_DIR=${expandHome(config.configDir)}`,
    `GIT_AUTHOR_NAME=${config.bot.name}`,
    `GIT_AUTHOR_EMAIL=${config.bot.email}`,
    `GIT_COMMITTER_NAME=${config.bot.name}`,
    `GIT_COMMITTER_EMAIL=${config.bot.email}`,
    'GIT_CONFIG_COUNT=2',
    'GIT_CONFIG_KEY_0=commit.gpgsign',
    'GIT_CONFIG_VALUE_0=false',
    'GIT_CONFIG_KEY_1=tag.gpgsign',
    'GIT_CONFIG_VALUE_1=false',
  ];
  // Pin git ssh to the bot key only when it actually exists, so the sandbox
  // stays usable without a dedicated bot key configured.
  if (fs.existsSync(botKey)) {
    args.push(
      `GIT_SSH_COMMAND=ssh -F ${botCfg} -i ${botKey} -o IdentitiesOnly=yes -o IdentityAgent=none`,
    );
  }
  // User-declared extras go last so they win over the built-in vars above
  // (duplicate keys: `env` keeps the last assignment).
  for (const [key, value] of Object.entries(config.env ?? {})) {
    args.push(`${key}=${value}`);
  }
  return args;
}

/**
 * Write the per-box extra files (mkdir -p their dirs) `0600`. They live under
 * configDir and can carry secrets (e.g. an MCP auth token in a URL/header), so
 * they're kept out of argv (vs. an inline `--mcp-config '<json>'`) AND off the
 * world-readable bit on disk. Returns the paths.
 */
export function writeExtraFiles(files: ExtraFile[]): string[] {
  for (const f of files) {
    fs.mkdirSync(path.dirname(f.path), { recursive: true });
    fs.writeFileSync(f.path, f.content, { mode: 0o600 });
    fs.chmodSync(f.path, 0o600); // enforce even if the file pre-existed
  }
  return files.map((f) => f.path);
}

/** Options accepted by {@link runClaude}. */
export interface RunOptions {
  configFile?: string | null;
}

/** Generate the profile and exec claude under sandbox-exec. Returns exit code. */
export function runClaude(
  config: Config,
  claudeArgs: string[],
  { configFile }: RunOptions = {},
): number {
  const projectDir = resolveProjectDir(config);
  const claudeBin = resolveClaudeBin(config);
  const profileFile = generateProfile(config, projectDir);

  // Compile the box's declarative mcp / systemPrompt into claude args, and
  // materialize the files they reference (under configDir, which is sandbox-RW).
  const extras = buildBoxExtras(config, boxSlug(configFile, projectDir));
  const extraFiles = writeExtraFiles(extras.files);

  if (process.env.CLABOX_DEBUG) {
    console.error(`→ Running Claude Code sandboxed in:  ${projectDir}`);
    console.error(`→ Profile: ${profileFile}`);
    console.error(`→ Config:  ${expandHome(config.configDir)}`);
    if (configFile) console.error(`→ Config file: ${configFile}`);
    for (const f of extraFiles) console.error(`→ MCP:     ${f}`);
  }

  // Terminal title = cwd (with ~ for $HOME), matching the bash version.
  const title = projectDir.startsWith(HOME) ? `~${projectDir.slice(HOME.length)}` : projectDir;
  process.stdout.write(`\x1b]0;${title}\x07`);

  const envArgs = buildEnvArgs(config);
  const defaultArgs = Array.isArray(config.claudeArgs) ? config.claudeArgs : [];
  const inner = [
    'sandbox-exec',
    '-f',
    profileFile,
    'env',
    ...envArgs,
    claudeBin,
    ...defaultArgs,
    ...extras.claudeArgs,
    ...claudeArgs,
  ];

  // `ulimit` is a shell builtin; run the whole thing under sh so we can set it.
  // `exec "$@"` keeps argv intact without re-quoting (args start after $0=sh).
  const ulimit = config.ulimitProcs > 0 ? `ulimit -u ${config.ulimitProcs} 2>/dev/null; ` : '';
  const res = spawnSync('/bin/sh', ['-c', `${ulimit}exec "$@"`, 'sh', ...inner], {
    cwd: projectDir,
    stdio: 'inherit',
  });
  if (res.error) throw res.error;
  if (res.signal) return 1;
  return res.status ?? 0;
}
