import path from 'node:path';
import { spawn } from 'node:child_process';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export const PROJECT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const DEFAULT_TIMEOUT_MS = 300000;
export const DEFAULT_MAX_TURNS = 30;
export const MAX_TIMEOUT_MS = 2147483647;
const BASE_TOOLS = ['Read', 'Grep', 'Glob'];
const DISALLOWED_TOOLS = ['Bash', 'Write', 'Edit', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Agent'];
const SECRET_FILES = ['.env*', '*.pem', '*.key'];
const STDERR_TAIL = 2048;

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

export function projectsDir(env = process.env) {
  return env.BRIDGE_PROJECTS_DIR ? path.resolve(env.BRIDGE_PROJECTS_DIR) : path.join(moduleDir, 'projects');
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

export async function listProjects(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const projects = [];
  for (const entry of entries) {
    if (!PROJECT_NAME_RE.test(entry.name)) continue;
    const file = path.join(dir, entry.name, 'project.json');
    if (!(await exists(file))) continue;
    let description;
    try {
      description = String((await readJson(file)).description ?? '');
    } catch {
      description = '(invalid project.json)';
    }
    projects.push({ name: entry.name, description });
  }
  return projects.sort((a, b) => a.name.localeCompare(b.name));
}

export function validateProjectName(name) {
  if (typeof name !== 'string' || !PROJECT_NAME_RE.test(name)) {
    throw new Error(`Invalid project name: ${JSON.stringify(name)} (expected ${PROJECT_NAME_RE.source})`);
  }
}

function positiveInt(value, field) {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value <= 0) throw new Error(`project.json: ${field} must be a positive integer`);
  return value;
}

export function resolveDbTools(config, mcpConfig) {
  if (Array.isArray(config.allowedTools) && config.allowedTools.length > 0) return config.allowedTools.map(String);
  return Object.keys(mcpConfig.mcpServers ?? {}).map((server) => `mcp__${server}__*`);
}

export async function loadProject(dir, name) {
  validateProjectName(name);
  if (!(await exists(path.join(dir, name, 'project.json')))) throw new Error(`Unknown project "${name}"`);
  const projectDir = await realpath(path.join(dir, name));
  const config = await readJson(path.join(projectDir, 'project.json'));
  if (typeof config.repo !== 'string' || config.repo === '') throw new Error('project.json: repo is required');
  const repo = path.resolve(projectDir, config.repo);
  if (!(await exists(repo))) throw new Error(`project.json: repo directory not found: ${repo}`);
  const connectPath = path.join(projectDir, 'connect.sh');
  if (!(await exists(connectPath))) throw new Error(`Project "${name}" has no connect.sh`);
  if (!(await exists(path.join(projectDir, 'CLAUDE.md')))) throw new Error(`Project "${name}" has no CLAUDE.md`);
  const mcpConfig = await readJson(path.join(projectDir, 'mcp.json'));
  return {
    name,
    description: String(config.description ?? ''),
    dir: projectDir,
    repo,
    connectPath,
    maxTurns: positiveInt(config.maxTurns, 'maxTurns') ?? DEFAULT_MAX_TURNS,
    timeoutMs: positiveInt(config.timeoutMs, 'timeoutMs'),
    dbTools: resolveDbTools(config, mcpConfig),
  };
}

export function resolveTimeout(project, env = process.env) {
  const fromEnv = Number(env.BRIDGE_TIMEOUT_MS);
  const timeout = project.timeoutMs || (Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_TIMEOUT_MS);
  return Math.min(timeout, MAX_TIMEOUT_MS);
}

export function buildClaudeArgs({ claudeBin, question, addonDir, repo, dbTools, maxTurns }) {
  const prompt = question.startsWith('-') ? `Question: ${question}` : question;
  const tools = [...BASE_TOOLS, ...dbTools].join(',');
  const secretDenies = [repo, addonDir].flatMap((dir) => SECRET_FILES.map((file) => `Read(/${dir}/**/${file})`));
  return [
    claudeBin, '-p', prompt, '--output-format', 'json',
    '--mcp-config', path.join(addonDir, 'mcp.json'), '--strict-mcp-config',
    '--append-system-prompt-file', path.join(addonDir, 'CLAUDE.md'),
    '--add-dir', repo,
    '--allowedTools', tools,
    '--disallowedTools', [...DISALLOWED_TOOLS, ...secretDenies].join(','),
    '--permission-mode', 'dontAsk',
    '--restricted',
    '--tools', tools,
    '--no-session-persistence',
    '--max-turns', String(maxTurns),
  ];
}

export function parseClaudeOutput(stdout) {
  const lines = stdout.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && parsed.type === 'result') return parsed;
    } catch {}
  }
  return null;
}

export function redact(text) {
  return text.replace(/postgres(ql)?:\/\/\S+/g, 'postgres://[REDACTED]');
}

function redactLog(text) {
  return redact(text).replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[IP]');
}

function failure(reason, stderr) {
  const tail = redactLog(stderr ?? '').slice(-STDERR_TAIL).trim();
  return { ok: false, message: redact(tail ? `${reason}\n\nstderr (tail):\n${tail}` : reason) };
}

function withWarnings(text, stderr) {
  const warnings = stderr.split('\n').filter((line) => line.startsWith('WARNING')).map((line) => redactLog(line.trim()));
  return warnings.length ? `${text}\n\nBridge warnings:\n${warnings.join('\n')}` : text;
}

export function interpretResult({
  code, signal, stdout = '', stderr = '', timedOut = false, timeoutMs, stopped = false, cancelled = false,
}) {
  if (stopped) return failure('Stopped because the bridge is shutting down.', stderr);
  if (cancelled) return failure('Cancelled by the client; the run was stopped.', stderr);
  if (timedOut) return failure(`Timed out after ${timeoutMs} ms; the run was stopped.`, stderr);
  const parsed = parseClaudeOutput(stdout);
  if (code === 0 && parsed && !parsed.is_error && parsed.subtype === 'success' && typeof parsed.result === 'string') {
    return { ok: true, text: withWarnings(redact(parsed.result), stderr) };
  }
  let reason = code === 0 ? 'Claude finished without a successful result' : `Claude exited with ${signal ? `signal ${signal}` : `code ${code}`}`;
  if (parsed) {
    reason += ` (subtype: ${parsed.subtype}${parsed.result ? `; ${parsed.result}` : ''})`;
  } else if (code === 0) {
    reason = 'Could not parse Claude output (no JSON result line)';
  }
  return failure(reason, stderr);
}

function signalGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

function terminateGroup(pid, graceMs) {
  return new Promise((resolve) => {
    if (!signalGroup(pid, 'SIGTERM')) return resolve();
    const deadline = Date.now() + graceMs;
    const timer = setInterval(() => {
      if (!signalGroup(pid, 0)) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        signalGroup(pid, 'SIGKILL');
        clearInterval(timer);
        resolve();
      }
    }, 100);
  });
}

const activeRuns = new Set();

export function runAsk(project, question, options = {}) {
  const {
    env = process.env,
    claudeBin = env.BRIDGE_CLAUDE_BIN || 'claude',
    graceMs = 30000,
    signal,
  } = options;
  const timeoutMs = Math.min(options.timeoutMs ?? resolveTimeout(project, env), MAX_TIMEOUT_MS);
  if (signal?.aborted) return Promise.resolve(failure('Cancelled by the client before it started.', ''));
  const argv = buildClaudeArgs({
    claudeBin, question, addonDir: project.dir, repo: project.repo,
    dbTools: project.dbTools, maxTurns: project.maxTurns,
  });

  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let stopped = false;
    let cancelled = false;
    let settled = false;
    let termination;
    let drainTimer;

    const child = spawn(project.connectPath, argv, { cwd: project.dir, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const terminate = () => (termination ??= terminateGroup(child.pid, graceMs));
    const run = {
      stop() {
        if (!settled) stopped = true;
        return terminate();
      },
    };
    activeRuns.add(run);
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const onAbort = () => {
      if (!settled) cancelled = true;
      terminate();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drainTimer);
      signal?.removeEventListener('abort', onAbort);
      child.stdout.destroy();
      child.stderr.destroy();
      terminate().then(() => activeRuns.delete(run));
      resolve(result);
    };

    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr += chunk;
      if (stderr.length > 65536) stderr = stderr.slice(-32768);
    });
    child.on('error', (err) => settle(failure(`Could not start ${project.connectPath}: ${err.message}`, stderr)));
    child.on('exit', (code, exitSignal) => {
      drainTimer = setTimeout(() => settle(interpretResult({ code, signal: exitSignal, stdout, stderr, timedOut, timeoutMs, stopped, cancelled })), 1000);
    });
    child.on('close', (code, exitSignal) => settle(interpretResult({ code, signal: exitSignal, stdout, stderr, timedOut, timeoutMs, stopped, cancelled })));
  });
}

export function terminateAll() {
  return Promise.all([...activeRuns].map((run) => run.stop()));
}

export function createSerializer() {
  const tails = new Map();
  return (key, task) => {
    const result = (tails.get(key) ?? Promise.resolve()).then(task);
    const tail = result.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return result;
  };
}

export function startProgress(send, intervalMs = 15000) {
  let count = 0;
  const timer = setInterval(() => {
    count += 1;
    Promise.resolve().then(() => send(count)).catch(() => {});
  }, intervalMs);
  return () => clearInterval(timer);
}
