import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  projectsDir, listProjects, validateProjectName, loadProject, resolveDbTools,
  buildClaudeArgs, parseClaudeOutput, interpretResult, redact, resolveTimeout,
} from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const fixtures = path.join(here, 'fixtures', 'projects');
const fixtureRepo = path.join(here, 'fixtures', 'repo');

test('projectsDir uses BRIDGE_PROJECTS_DIR when set', () => {
  assert.equal(projectsDir({ BRIDGE_PROJECTS_DIR: '/some/where' }), '/some/where');
});

test('projectsDir defaults to <repo>/projects regardless of cwd', () => {
  const cwd = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.equal(projectsDir({}), path.join(repoRoot, 'projects'));
  } finally {
    process.chdir(cwd);
  }
});

test('listProjects returns only valid addon folders with project.json', async () => {
  assert.deepEqual(await listProjects(fixtures), [
    { name: 'custom', description: 'Custom settings' },
    { name: 'demo', description: 'Demo project' },
  ]);
});

test('listProjects returns [] when the directory is missing', async () => {
  assert.deepEqual(await listProjects(path.join(tmpdir(), 'does-not-exist-bridge')), []);
});

test('listProjects follows symlinked addon folders, like loadProject', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-symlink-'));
  symlinkSync(path.join(fixtures, 'demo'), path.join(dir, 'linked'));
  assert.deepEqual(await listProjects(dir), [{ name: 'linked', description: 'Demo project' }]);
  assert.equal((await loadProject(dir, 'linked')).repo, fixtureRepo);
});

test('listProjects still lists a project whose project.json is malformed', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-list-'));
  mkdirSync(path.join(dir, 'broken'));
  writeFileSync(path.join(dir, 'broken', 'project.json'), '{ nope');
  assert.deepEqual(await listProjects(dir), [{ name: 'broken', description: '(invalid project.json)' }]);
});

test('validateProjectName accepts lowercase names', () => {
  for (const name of ['demo', 'a', 'my-proj_2', '0x', 'a'.repeat(64)]) {
    assert.doesNotThrow(() => validateProjectName(name), name);
  }
});

test('validateProjectName rejects traversal, paths, templates, hidden and empty names', () => {
  for (const name of ['..', 'a/b', '/etc', '_example', '.x', '', 'Demo', 'a'.repeat(65), 'a b', undefined, 42]) {
    assert.throws(() => validateProjectName(name), /Invalid project name/, String(name));
  }
});

test('loadProject rejects an invalid name before touching the filesystem', async () => {
  await assert.rejects(loadProject(fixtures, '../fixtures'), /Invalid project name/);
});

test('loadProject rejects a project that does not exist', async () => {
  await assert.rejects(loadProject(fixtures, 'nojson'), /Unknown project "nojson"/);
  await assert.rejects(loadProject(fixtures, 'missing'), /Unknown project "missing"/);
});

test('loadProject resolves paths, defaults and the database tool allowlist', async () => {
  const p = await loadProject(fixtures, 'demo');
  assert.equal(p.name, 'demo');
  assert.equal(p.dir, path.join(fixtures, 'demo'));
  assert.equal(p.repo, fixtureRepo);
  assert.equal(p.connectPath, path.join(fixtures, 'demo', 'connect.sh'));
  assert.equal(p.maxTurns, 30);
  assert.equal(p.timeoutMs, undefined);
  assert.deepEqual(p.dbTools, ['mcp__db__*', 'mcp__warehouse__*']);
});

test('loadProject honours maxTurns, timeoutMs and allowedTools from project.json', async () => {
  const p = await loadProject(fixtures, 'custom');
  assert.equal(p.maxTurns, 5);
  assert.equal(p.timeoutMs, 1234);
  assert.deepEqual(p.dbTools, ['mcp__db__execute_sql', 'mcp__db__list_objects']);
});

test('loadProject fails when the repo directory does not exist', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-load-'));
  mkdirSync(path.join(dir, 'p'));
  writeFileSync(path.join(dir, 'p', 'project.json'), JSON.stringify({ description: 'x', repo: '/no/such/repo/dir' }));
  writeFileSync(path.join(dir, 'p', 'mcp.json'), '{"mcpServers":{}}');
  writeFileSync(path.join(dir, 'p', 'connect.sh'), '');
  writeFileSync(path.join(dir, 'p', 'CLAUDE.md'), '');
  await assert.rejects(loadProject(dir, 'p'), /repo/);
});

test('loadProject requires the analyst CLAUDE.md', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bridge-claudemd-'));
  mkdirSync(path.join(dir, 'p'));
  writeFileSync(path.join(dir, 'p', 'project.json'), JSON.stringify({ description: 'x', repo: fixtureRepo }));
  writeFileSync(path.join(dir, 'p', 'mcp.json'), '{"mcpServers":{}}');
  writeFileSync(path.join(dir, 'p', 'connect.sh'), '');
  await assert.rejects(loadProject(dir, 'p'), /CLAUDE\.md/);
});

test('resolveDbTools defaults to one wildcard per MCP server', () => {
  assert.deepEqual(resolveDbTools({}, { mcpServers: { db: {}, other: {} } }), ['mcp__db__*', 'mcp__other__*']);
  assert.deepEqual(resolveDbTools({ allowedTools: ['mcp__db__q'] }, { mcpServers: { db: {} } }), ['mcp__db__q']);
});

test('buildClaudeArgs produces the exact argv with the prompt right after -p', () => {
  assert.deepEqual(buildClaudeArgs({
    claudeBin: '/bin/claude', question: 'How many users?', addonDir: '/a',
    repo: '/r', dbTools: ['mcp__db__*', 'mcp__wh__*'], maxTurns: 30,
  }), [
    '/bin/claude', '-p', 'How many users?', '--output-format', 'json',
    '--mcp-config', '/a/mcp.json', '--strict-mcp-config',
    '--append-system-prompt-file', '/a/CLAUDE.md',
    '--add-dir', '/r',
    '--allowedTools', 'Read,Grep,Glob,mcp__db__*,mcp__wh__*',
    '--disallowedTools', 'Bash,Write,Edit,NotebookEdit,WebFetch,WebSearch,Agent,'
      + 'Read(//r/**/.env*),Read(//r/**/*.pem),Read(//r/**/*.key),'
      + 'Read(//a/**/.env*),Read(//a/**/*.pem),Read(//a/**/*.key)',
    '--permission-mode', 'dontAsk',
    '--restricted',
    '--tools', 'Read,Grep,Glob,mcp__db__*,mcp__wh__*',
    '--no-session-persistence',
    '--max-turns', '30',
  ]);
});

test('buildClaudeArgs neutralises a question that looks like a flag', () => {
  const args = buildClaudeArgs({
    claudeBin: 'claude', question: '--dangerously-skip-permissions', addonDir: '/a', repo: '/r', dbTools: [], maxTurns: 1,
  });
  assert.equal(args[2], 'Question: --dangerously-skip-permissions');
});

test('parseClaudeOutput takes the last result line and ignores noise', () => {
  const stdout = [
    'warming up',
    '{"type":"result","subtype":"success","is_error":false,"result":"first"}',
    '{"type":"system","subtype":"init"}',
    'more noise {not json',
    '{"type":"result","subtype":"success","is_error":false,"result":"second"}',
    '',
  ].join('\n');
  assert.equal(parseClaudeOutput(stdout).result, 'second');
  assert.equal(parseClaudeOutput('no json here\n{"type":"system"}\n'), null);
  assert.equal(parseClaudeOutput(''), null);
});

test('redact masks postgres connection URLs', () => {
  assert.equal(
    redact('a postgres://u:p@h/db b postgresql://x:y@z:5432/w?sslmode=require c'),
    'a postgres://[REDACTED] b postgres://[REDACTED] c',
  );
});

const ok = '{"type":"result","subtype":"success","is_error":false,"result":"42 users"}';

test('interpretResult returns the result text on success', () => {
  assert.deepEqual(interpretResult({ code: 0, stdout: `noise\n${ok}\n`, stderr: '' }), { ok: true, text: '42 users' });
});

test('interpretResult appends redacted WARNING lines from stderr to a successful answer', () => {
  const stderr = 'Opening server to 203.0.113.7/32\nWARNING: could not delete rule r1 for 203.0.113.7; remove it manually\n'
    + 'warning: lowercase is ignored\nWARNING: tunnel postgres://u:p@h/db left open\n';
  assert.deepEqual(interpretResult({ code: 0, stdout: ok, stderr }), {
    ok: true,
    text: '42 users\n\nBridge warnings:\nWARNING: could not delete rule r1 for [IP]; remove it manually\n'
      + 'WARNING: tunnel postgres://[REDACTED] left open',
  });
});

test('interpretResult redacts IPv4 addresses in the stderr tail', () => {
  const r = interpretResult({ code: 1, stdout: '', stderr: 'Opening server to 203.0.113.7/32 (rule jit-x)\n' });
  assert.match(r.message, /Opening server to \[IP\]\/32/);
  assert.doesNotMatch(r.message, /203\.0\.113\.7/);
});

test('interpretResult reports a non-zero exit with a redacted stderr tail', () => {
  const r = interpretResult({ code: 3, stdout: '', stderr: 'x'.repeat(5000) + '\nfailed postgresql://u:secret@h/db\n' });
  assert.equal(r.ok, false);
  assert.match(r.message, /code 3/);
  assert.match(r.message, /postgres:\/\/\[REDACTED\]/);
  assert.doesNotMatch(r.message, /secret/);
  assert.ok(r.message.length < 2300, `message length ${r.message.length}`);
});

test('interpretResult redacts a URL that straddles the stderr tail boundary', () => {
  const r = interpretResult({ code: 1, stdout: '', stderr: `postgresql://u:${'S'.repeat(40)}@h/db ${'y'.repeat(2030)}` });
  assert.doesNotMatch(r.message, /SSSS/);
});

test('interpretResult treats is_error / non-success subtype as failure even with exit 0', () => {
  const r = interpretResult({ code: 0, stdout: '{"type":"result","subtype":"error_max_turns","is_error":true}', stderr: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /error_max_turns/);
  const r2 = interpretResult({ code: 0, stdout: '{"type":"result","subtype":"success","is_error":true,"result":"API Error"}', stderr: '' });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /API Error/);
});

test('interpretResult reports unparsable output', () => {
  const r = interpretResult({ code: 0, stdout: 'hello', stderr: 'warn' });
  assert.equal(r.ok, false);
  assert.match(r.message, /parse/i);
  assert.match(r.message, /warn/);
});

test('interpretResult reports a timeout', () => {
  const r = interpretResult({ timedOut: true, timeoutMs: 1500, code: null, signal: 'SIGTERM', stdout: ok, stderr: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /timed out after 1500 ms/i);
});

test('interpretResult reports a run cancelled by the client', () => {
  const r = interpretResult({ cancelled: true, code: 143, stdout: '', stderr: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /cancelled by the client/i);
});

test('interpretResult reports a run stopped by shutdown', () => {
  const r = interpretResult({ stopped: true, code: 143, stdout: '', stderr: '' });
  assert.equal(r.ok, false);
  assert.match(r.message, /shutting down/);
});

test('resolveTimeout prefers project.json, then BRIDGE_TIMEOUT_MS, then 300000', () => {
  assert.equal(resolveTimeout({ timeoutMs: 1234 }, { BRIDGE_TIMEOUT_MS: '999' }), 1234);
  assert.equal(resolveTimeout({}, { BRIDGE_TIMEOUT_MS: '999' }), 999);
  assert.equal(resolveTimeout({}, {}), 300000);
  assert.equal(resolveTimeout({}, { BRIDGE_TIMEOUT_MS: 'abc' }), 300000);
});

test('resolveTimeout caps the timeout at the largest value setTimeout accepts', () => {
  assert.equal(resolveTimeout({ timeoutMs: 10 ** 12 }, {}), 2147483647);
  assert.equal(resolveTimeout({}, { BRIDGE_TIMEOUT_MS: '99999999999' }), 2147483647);
});
