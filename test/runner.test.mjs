import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { cpSync, chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { loadProject, runAsk, terminateAll, createSerializer, startProgress } from '../lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures', 'projects');
const fakeClaude = path.join(here, 'fixtures', 'fake-claude');
const tmp = mkdtempSync(path.join(tmpdir(), 'bridge-runner-'));
const demo = await loadProject(fixtures, 'demo');

after(() => {
  for (const file of readdirSync(tmp).filter((f) => f.endsWith('-pid'))) {
    try { process.kill(Number(readFileSync(path.join(tmp, file), 'utf8')), 'SIGKILL'); } catch {}
  }
});

const envWith = (extra = {}) => ({
  ...process.env,
  PATH: `${path.dirname(process.execPath)}:${process.env.PATH}`,
  BRIDGE_CLAUDE_BIN: fakeClaude,
  ...extra,
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await delay(25);
  }
  return check();
}

test('runAsk runs claude through connect.sh in the addon dir and returns the result text', { timeout: 15000 }, async () => {
  const r = await runAsk(demo, 'How many users?', { env: envWith() });
  assert.equal(r.ok, true, r.message);
  const report = JSON.parse(r.text);
  assert.equal(report.cwd, path.join(fixtures, 'demo'));
  assert.equal(report.databaseUri, 'fixture-uri');
  assert.deepEqual(report.argv.slice(0, 2), ['-p', 'How many users?']);
  assert.equal(report.argv[report.argv.indexOf('--mcp-config') + 1], path.join(fixtures, 'demo', 'mcp.json'));
  assert.equal(report.argv[report.argv.indexOf('--add-dir') + 1], path.join(here, 'fixtures', 'repo'));
});

test('runAsk returns a redacted error on non-zero exit', { timeout: 15000 }, async () => {
  const r = await runAsk(demo, 'FAIL now', { env: envWith() });
  assert.equal(r.ok, false);
  assert.match(r.message, /code 3/);
  assert.match(r.message, /could not connect to postgres:\/\/\[REDACTED\]/);
  assert.doesNotMatch(r.message, /s3cret|pa55/);
});

test('runAsk caps a huge timeout instead of letting setTimeout overflow to 1 ms', { timeout: 15000 }, async () => {
  const r = await runAsk(demo, 'SLOW', { env: envWith(), timeoutMs: 10 ** 12 });
  assert.equal(r.ok, true, r.message);
});

test('runAsk appends WARNING lines that connect.sh prints while cleaning up', { timeout: 15000 }, async () => {
  const r = await runAsk(demo, 'SLOW', { env: envWith({ FIXTURE_WARN: '1' }) });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.text, 'slow done\n\nBridge warnings:\nWARNING: could not close tunnel to [IP]');
});

test('runAsk does not start a run whose signal is already aborted', { timeout: 15000 }, async () => {
  const pidfile = path.join(tmp, 'preabort-pid');
  const r = await runAsk(demo, 'hello', { env: envWith({ FAKE_CLAUDE_PIDFILE: pidfile }), signal: AbortSignal.abort() });
  assert.equal(r.ok, false);
  assert.match(r.message, /cancelled/i);
  assert.equal(existsSync(pidfile), false);
});

test('runAsk stops the process group when its signal aborts and lets connect.sh clean up', { timeout: 15000 }, async () => {
  const marker = path.join(tmp, 'abort-marker');
  const pidfile = path.join(tmp, 'abort-pid');
  const controller = new AbortController();
  const pending = runAsk(demo, 'HANG', {
    env: envWith({ FIXTURE_MARKER: marker, FAKE_CLAUDE_PIDFILE: pidfile }), signal: controller.signal, timeoutMs: 60000, graceMs: 5000,
  });
  assert.ok(await waitFor(() => existsSync(pidfile)), 'run started');
  controller.abort();
  const r = await pending;
  assert.match(r.message, /cancelled by the client/i);
  assert.equal(readFileSync(marker, 'utf8').trim(), 'cleaned');
});

test('a queued run cancelled before its turn never starts', { timeout: 15000 }, async () => {
  const serialize = createSerializer();
  const pidfile = path.join(tmp, 'queue-first-pid');
  const log = path.join(tmp, 'queue-second.log');
  const first = new AbortController();
  const second = new AbortController();
  const a = serialize('demo', () => runAsk(demo, 'HANG', { env: envWith({ FAKE_CLAUDE_PIDFILE: pidfile }), signal: first.signal, graceMs: 5000 }));
  const b = serialize('demo', () => runAsk(demo, 'SLOW', { env: envWith({ FAKE_CLAUDE_LOG: log }), signal: second.signal }));
  assert.ok(await waitFor(() => existsSync(pidfile)), 'first run started');
  second.abort();
  first.abort();
  const [ra, rb] = await Promise.all([a, b]);
  assert.match(ra.message, /cancelled/i);
  assert.match(rb.message, /cancelled/i);
  assert.equal(existsSync(log), false, 'second run never started');
});

test('runAsk reports is_error results and unparsable output', { timeout: 15000 }, async () => {
  assert.match((await runAsk(demo, 'MAXTURNS', { env: envWith() })).message, /error_max_turns/);
  assert.match((await runAsk(demo, 'GARBAGE', { env: envWith() })).message, /parse/i);
});

test('runAsk reports a connect.sh that cannot be started', { timeout: 15000 }, async () => {
  const dir = mkdtempSync(path.join(tmp, 'noexec-'));
  cpSync(path.join(fixtures, 'demo'), path.join(dir, 'demo'), { recursive: true });
  chmodSync(path.join(dir, 'demo', 'connect.sh'), 0o644);
  const project = { ...demo, dir: path.join(dir, 'demo'), connectPath: path.join(dir, 'demo', 'connect.sh') };
  const r = await runAsk(project, 'hello', { env: envWith() });
  assert.equal(r.ok, false);
  assert.match(r.message, /connect\.sh/);
});

test('runAsk times out, SIGTERMs the process group and lets the connect.sh trap clean up', { timeout: 15000 }, async () => {
  const marker = path.join(tmp, 'timeout-marker');
  const pidfile = path.join(tmp, 'timeout-pid');
  const started = Date.now();
  const r = await runAsk(demo, 'HANG', {
    env: envWith({ FIXTURE_MARKER: marker, FAKE_CLAUDE_PIDFILE: pidfile }), timeoutMs: 300, graceMs: 5000,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /Timed out after 300 ms/);
  assert.equal(readFileSync(marker, 'utf8').trim(), 'cleaned');
  assert.ok(Date.now() - started < 4000, 'stopped well before the grace period');
  assert.ok(await waitFor(() => !isAlive(Number(readFileSync(pidfile, 'utf8')))), 'fake claude is gone');
});

test('runAsk SIGKILLs the group when it ignores SIGTERM past the grace period', { timeout: 15000 }, async () => {
  const pidfile = path.join(tmp, 'kill-pid');
  const started = Date.now();
  const r = await runAsk(demo, 'HANG', {
    env: envWith({ FIXTURE_IGNORE_TERM: '1', FAKE_CLAUDE_IGNORE_TERM: '1', FAKE_CLAUDE_PIDFILE: pidfile }),
    timeoutMs: 200, graceMs: 600,
  });
  const elapsed = Date.now() - started;
  assert.match(r.message, /Timed out after 200 ms/);
  assert.ok(elapsed >= 750 && elapsed < 4000, `elapsed ${elapsed}`);
  assert.ok(await waitFor(() => !isAlive(Number(readFileSync(pidfile, 'utf8')))), 'fake claude is gone');
});

test('runAsk stops leftover processes in the group after a normal exit', { timeout: 15000 }, async () => {
  const pidfile = path.join(tmp, 'straggler-pid');
  const started = Date.now();
  const r = await runAsk(demo, 'hello', { env: envWith({ FIXTURE_STRAGGLER_PIDFILE: pidfile }) });
  assert.equal(r.ok, true, r.message);
  assert.ok(Date.now() - started < 4000);
  assert.ok(await waitFor(() => !isAlive(Number(readFileSync(pidfile, 'utf8')))), 'straggler is gone');
});

test('runAsk does not hang when a process outside the group keeps the output pipes open', { timeout: 15000 }, async () => {
  const pidfile = path.join(tmp, 'escaped-pid');
  const started = Date.now();
  try {
    const r = await runAsk(demo, 'hello', { env: envWith({ FIXTURE_ESCAPED_PIDFILE: pidfile }) });
    assert.equal(r.ok, true, r.message);
    assert.ok(Date.now() - started < 4000, `elapsed ${Date.now() - started}`);
  } finally {
    if (existsSync(pidfile)) {
      try { process.kill(Number(readFileSync(pidfile, 'utf8'))); } catch {}
    }
  }
});

test('terminateAll stops in-flight runs and lets connect.sh clean up', { timeout: 15000 }, async () => {
  const marker = path.join(tmp, 'shutdown-marker');
  const pidfile = path.join(tmp, 'shutdown-pid');
  const pending = runAsk(demo, 'HANG', {
    env: envWith({ FIXTURE_MARKER: marker, FAKE_CLAUDE_PIDFILE: pidfile }), timeoutMs: 60000, graceMs: 5000,
  });
  assert.ok(await waitFor(() => existsSync(pidfile)), 'run started');
  await terminateAll();
  const r = await pending;
  assert.equal(r.ok, false);
  assert.match(r.message, /shutting down/);
  assert.equal(readFileSync(marker, 'utf8').trim(), 'cleaned');
});

test('createSerializer runs tasks with the same key one at a time and other keys in parallel', async () => {
  const serialize = createSerializer();
  const log = [];
  const task = (id, ms) => async () => {
    log.push(`start ${id}`);
    await delay(ms);
    log.push(`end ${id}`);
    return id;
  };
  const results = await Promise.all([serialize('a', task(1, 60)), serialize('a', task(2, 5)), serialize('b', task(3, 5))]);
  assert.deepEqual(results, [1, 2, 3]);
  assert.deepEqual(log.filter((l) => /[12]$/.test(l)), ['start 1', 'end 1', 'start 2', 'end 2']);
  assert.ok(log.indexOf('end 3') < log.indexOf('end 1'), 'key b is not blocked by key a');
});

test('createSerializer keeps going after a failed task', async () => {
  const serialize = createSerializer();
  await assert.rejects(serialize('a', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await serialize('a', async () => 'next'), 'next');
});

test('startProgress sends increasing progress values until stopped', async () => {
  const sent = [];
  const stop = startProgress(async (n) => { sent.push(n); }, 20);
  await delay(130);
  stop();
  const count = sent.length;
  await delay(80);
  assert.ok(count >= 3, `sent ${count}`);
  assert.equal(sent.length, count, 'nothing sent after stop');
  assert.deepEqual(sent, Array.from({ length: count }, (_, i) => i + 1));
});

test('startProgress survives a failing send', async () => {
  let calls = 0;
  const stop = startProgress(async () => { calls++; throw new Error('client gone'); }, 10);
  await delay(50);
  stop();
  assert.ok(calls >= 2);
});
