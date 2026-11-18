import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, '..', 'server.mjs');
const fixtures = path.join(here, 'fixtures', 'projects');
const fakeClaude = path.join(here, 'fixtures', 'fake-claude');
const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-server-'));

after(() => {
  for (const file of readdirSync(tmp).filter((f) => f.endsWith('-pid'))) {
    try { process.kill(Number(readFileSync(path.join(tmp, file), 'utf8')), 'SIGKILL'); } catch {}
  }
});

const env = (extra = {}) => ({
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
  HOME: process.env.HOME,
  BRIDGE_PROJECTS_DIR: fixtures,
  BRIDGE_CLAUDE_BIN: fakeClaude,
  ...extra,
});

async function connect(extra) {
  const client = new Client({ name: 'bridge-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: env(extra), stderr: 'pipe' });
  await client.connect(transport);
  client.serverPid = transport.pid;
  return client;
}

const text = (result) => result.content.map((c) => c.text).join('');
const ask = (client, project, question) => client.callTool({ name: 'ask', arguments: { project, question } });

function cli(args, extra) {
  return new Promise((resolve) => {
    execFile(process.execPath, [serverPath, ...args], { env: env(extra), cwd: tmp }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

async function waitFor(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

test('MCP server exposes list_projects and ask with a bounded question', { timeout: 20000 }, async () => {
  const client = await connect();
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['ask', 'list_projects']);
    const schema = tools.find((t) => t.name === 'ask').inputSchema;
    assert.deepEqual([...schema.required].sort(), ['project', 'question']);
    assert.equal(schema.properties.question.minLength, 1);
    assert.equal(schema.properties.question.maxLength, 4000);
    const list = await client.callTool({ name: 'list_projects', arguments: {} });
    assert.deepEqual(JSON.parse(text(list)), [
      { name: 'custom', description: 'Custom settings' },
      { name: 'demo', description: 'Demo project' },
    ]);
  } finally {
    await client.close();
  }
});

test('MCP ask returns the analyst answer', { timeout: 20000 }, async () => {
  const client = await connect();
  try {
    const result = await ask(client, 'demo', 'How many users?');
    assert.equal(result.isError, undefined, text(result));
    const report = JSON.parse(text(result));
    assert.deepEqual(report.argv.slice(0, 2), ['-p', 'How many users?']);
    assert.equal(report.cwd, path.join(fixtures, 'demo'));
  } finally {
    await client.close();
  }
});

test('MCP ask rejects invalid input before running anything', { timeout: 20000 }, async () => {
  const pidfile = path.join(tmp, 'invalid-pid');
  const client = await connect({ FAKE_CLAUDE_PIDFILE: pidfile });
  try {
    for (const [project, question, pattern] of [
      ['../demo', 'q', /Invalid project name/],
      ['_template', 'q', /Invalid project name/],
      ['missing', 'q', /Unknown project "missing"/],
      ['demo', '', /question/i],
      ['demo', 'x'.repeat(4001), /question/i],
    ]) {
      const result = await ask(client, project, question);
      assert.equal(result.isError, true, `${project} / ${question.length}`);
      assert.match(text(result), pattern);
    }
    assert.equal(existsSync(pidfile), false, 'claude was never started');
  } finally {
    await client.close();
  }
});

test('MCP ask returns failures as redacted tool errors', { timeout: 20000 }, async () => {
  const client = await connect();
  try {
    const result = await ask(client, 'demo', 'FAIL');
    assert.equal(result.isError, true);
    assert.match(text(result), /code 3/);
    assert.doesNotMatch(text(result), /s3cret|pa55/);
  } finally {
    await client.close();
  }
});

test('MCP ask runs one question at a time per project, projects in parallel', { timeout: 20000 }, async () => {
  const sameLog = path.join(tmp, 'same.log');
  const client = await connect({ FAKE_CLAUDE_LOG: sameLog });
  try {
    await Promise.all([ask(client, 'demo', 'SLOW 1'), ask(client, 'demo', 'SLOW 2')]);
    assert.deepEqual(readFileSync(sameLog, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end']);
  } finally {
    await client.close();
  }
  const mixedLog = path.join(tmp, 'mixed.log');
  const client2 = await connect({ FAKE_CLAUDE_LOG: mixedLog });
  try {
    await Promise.all([ask(client2, 'demo', 'SLOW 1'), ask(client2, 'custom', 'SLOW 2')]);
    assert.deepEqual(readFileSync(mixedLog, 'utf8').trim().split('\n'), ['start', 'start', 'end', 'end']);
  } finally {
    await client2.close();
  }
});

test('closing the MCP client stops in-flight asks and lets connect.sh clean up', { timeout: 20000 }, async () => {
  const marker = path.join(tmp, 'shutdown-marker');
  const pidfile = path.join(tmp, 'shutdown-pid');
  const client = await connect({ FIXTURE_MARKER: marker, FAKE_CLAUDE_PIDFILE: pidfile });
  const pending = ask(client, 'demo', 'HANG').catch((err) => err);
  assert.ok(await waitFor(() => existsSync(pidfile)), 'ask started');
  const started = Date.now();
  await client.close();
  assert.ok(Date.now() - started < 1800, 'server exited on stdin end, before the client had to signal it');
  await pending;
  assert.ok(await waitFor(() => existsSync(marker)), 'connect.sh trap ran');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'cleaned');
  const pid = Number(readFileSync(pidfile, 'utf8'));
  assert.ok(await waitFor(() => { try { process.kill(pid, 0); return false; } catch { return true; } }), 'fake claude is gone');
});

test('SIGTERM to the server stops in-flight asks and lets connect.sh clean up', { timeout: 20000 }, async () => {
  const marker = path.join(tmp, 'sigterm-marker');
  const pidfile = path.join(tmp, 'sigterm-pid');
  const client = await connect({ FIXTURE_MARKER: marker, FAKE_CLAUDE_PIDFILE: pidfile });
  const pending = ask(client, 'demo', 'HANG').catch((err) => err);
  assert.ok(await waitFor(() => existsSync(pidfile)), 'ask started');
  process.kill(client.serverPid, 'SIGTERM');
  assert.ok(await waitFor(() => existsSync(marker)), 'connect.sh trap ran');
  assert.equal(readFileSync(marker, 'utf8').trim(), 'cleaned');
  await pending;
  await client.close();
});

test('CLI list prints the projects as JSON', { timeout: 20000 }, async () => {
  const r = await cli(['list']);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout).map((p) => p.name), ['custom', 'demo']);
});

test('CLI ask prints the answer, or the error with exit code 1', { timeout: 20000 }, async () => {
  const okRun = await cli(['ask', 'demo', 'How many users?']);
  assert.equal(okRun.code, 0, okRun.stderr);
  assert.deepEqual(JSON.parse(okRun.stdout).argv.slice(0, 2), ['-p', 'How many users?']);
  const failRun = await cli(['ask', 'demo', 'FAIL']);
  assert.equal(failRun.code, 1);
  assert.match(failRun.stderr, /code 3/);
  assert.doesNotMatch(failRun.stderr + failRun.stdout, /s3cret/);
  const pidfile = path.join(tmp, 'cli-invalid-pid');
  const badName = await cli(['ask', '../demo', 'q'], { FAKE_CLAUDE_PIDFILE: pidfile });
  assert.equal(badName.code, 1);
  assert.match(badName.stderr, /Invalid project name/);
  assert.equal(existsSync(pidfile), false);
});

test('CLI rejects unknown commands and missing arguments with usage', { timeout: 20000 }, async () => {
  for (const args of [['bogus'], ['ask', 'demo'], ['list', 'extra']]) {
    const r = await cli(args);
    assert.equal(r.code, 2, args.join(' '));
    assert.match(r.stderr, /Usage/);
  }
});
