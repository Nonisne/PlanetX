import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fixture(context) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'planetx 启停测试 '));
  const children = [];
  for (const filename of ['package.json', 'start.mjs', 'stop.mjs', 'server.mjs', 'server', 'public', 'scripts', '一键启动.command', '一键关闭.command']) {
    const source = path.join(project, filename);
    if (fs.existsSync(source)) fs.cpSync(source, path.join(directory, filename), { recursive: true });
  }
  context.after(async () => {
    if (fs.existsSync(path.join(directory, 'stop.mjs'))) {
      const cleanup = spawn(process.execPath, [path.join(directory, 'stop.mjs')], { stdio: 'ignore' });
      await exited(cleanup).catch(() => {});
    }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    await Promise.all(children.map((child) => exited(child).catch(() => {})));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, children };
}

function launch(target, filename, port, args = []) {
  const child = spawn(process.execPath, [path.join(target.directory, filename), ...args], {
    cwd: os.tmpdir(),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.output = '';
  child.stdout.on('data', (chunk) => { child.output += chunk; });
  child.stderr.on('data', (chunk) => { child.output += chunk; });
  target.children.push(child);
  return child;
}

async function exited(child) {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`process did not exit: ${child.output}`)), 6000);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function ready(child, port) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) assert.fail(`server exited before ready: ${child.output}`);
    if (child.output.includes('✓ 已启动')) {
      const response = await fetch(`http://127.0.0.1:${port}/api/modes`);
      assert.equal(response.status, 200);
      return;
    }
    await delay(25);
  }
  assert.fail(`server never became ready: ${child.output}`);
}

test('macOS and Windows provide executable one-click entrypoints without broad process killing', () => {
  for (const filename of ['一键启动.command', '一键关闭.command', 'start-server.cmd', 'stop-server.cmd', 'stop.mjs']) {
    assert.ok(fs.existsSync(path.join(project, filename)), `${filename} must exist`);
  }
  for (const filename of ['一键启动.command', '一键关闭.command']) {
    if (process.platform !== 'win32') assert.notEqual(fs.statSync(path.join(project, filename)).mode & 0o111, 0);
    if (process.platform === 'darwin') {
      const checked = spawnSync('/bin/zsh', ['-n', path.join(project, filename)], { encoding: 'utf8' });
      assert.equal(checked.status, 0, checked.stderr);
    }
  }
  for (const filename of ['start-server.cmd', 'stop-server.cmd']) {
    const source = fs.readFileSync(path.join(project, filename), 'utf8');
    assert.equal(/[^\x00-\x7f]/.test(source), false);
    assert.equal(/taskkill|killall|pkill/i.test(source), false);
  }
});

test('concurrent start clicks leave exactly one service and do not discard its identity', async (context) => {
  const target = fixture(context);
  const port = await freePort();
  const contenders = [launch(target, 'start.mjs', port, ['--no-open']), launch(target, 'start.mjs', port, ['--no-open'])];
  for (let attempt = 0; attempt < 120; attempt++) {
    if (contenders.some((child) => child.exitCode === 0) && contenders.some((child) => child.output.includes('✓ 已启动'))) break;
    await delay(25);
  }
  const active = contenders.filter((child) => child.exitCode === null);
  assert.equal(active.length, 1, contenders.map((child) => child.output).join('\n'));
  assert.equal(contenders.find((child) => child !== active[0]).exitCode, 0);
  const record = JSON.parse(fs.readFileSync(path.join(target.directory, '.planetx', `${port}.json`), 'utf8'));
  assert.equal(record.pid, active[0].pid);
  const stopped = launch(target, 'stop.mjs', port);
  assert.equal(await exited(stopped), 0, stopped.output);
  assert.equal(await exited(active[0]), 0);
});

test('invalid PORT values fail clearly without creating a service record', async (context) => {
  const target = fixture(context);
  for (const port of ['abc', 0, -1, 65536, 123.5]) {
    const child = launch(target, 'start.mjs', port, ['--no-open']);
    assert.equal(await exited(child), 1, child.output);
    assert.match(child.output, /PORT.*1.*65535/);
  }
  assert.equal(fs.existsSync(path.join(target.directory, '.planetx')), false);
});

test('macOS entrypoints resolve Node with Finder PATH, open only a ready page, and stop from another directory', { skip: process.platform !== 'darwin' }, async (context) => {
  const target = fixture(context);
  const port = await freePort();
  const mockBin = path.join(target.directory, 'mock-bin');
  const openedFile = path.join(target.directory, 'opened.json');
  fs.mkdirSync(mockBin);
  fs.writeFileSync(path.join(mockBin, 'open'), `#!${process.execPath}\nimport('node:fs').then(async (fs) => { const response = await fetch(process.argv[2]); await response.text(); fs.writeFileSync(process.env.PLANETX_TEST_OPEN_FILE, JSON.stringify({ url: process.argv[2], status: response.status })); });\n`, { mode: 0o755 });
  const environment = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1',
    PATH: `${mockBin}:/usr/bin:/bin:/usr/sbin:/sbin`, PLANETX_TEST_OPEN_FILE: openedFile,
  };
  const runEntry = (filename) => {
    const child = spawn('/bin/zsh', [path.join(target.directory, filename)], { cwd: os.tmpdir(), env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.output = '';
    child.stdout.on('data', (chunk) => { child.output += chunk; });
    child.stderr.on('data', (chunk) => { child.output += chunk; });
    target.children.push(child);
    return child;
  };
  const started = runEntry('一键启动.command');
  await ready(started, port);
  // Under full-suite load, spawn(open) + fetch + write can exceed the old 2s window.
  for (let attempt = 0; attempt < 200 && !fs.existsSync(openedFile); attempt++) await delay(25);
  assert.ok(fs.existsSync(openedFile), `browser stand-in did not write ${openedFile} within 5s\n${started.output}`);
  assert.deepEqual(JSON.parse(fs.readFileSync(openedFile, 'utf8')), { url: `http://127.0.0.1:${port}/`, status: 200 });
  const stopped = runEntry('一键关闭.command');
  assert.equal(await exited(stopped), 0, stopped.output);
  assert.equal(await exited(started), 0, started.output);
});

test('repeat startup reuses the same project server and preserves a live room', async (context) => {
  const target = fixture(context);
  const port = await freePort();
  const original = launch(target, 'start.mjs', port, ['--no-open']);
  await ready(original, port);
  const created = await fetch(`http://127.0.0.1:${port}/api/rooms`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: '测试玩家', playMode: 'builtin' }),
  }).then((response) => response.json());
  assert.ok(created.token);
  const repeated = launch(target, 'start.mjs', port, ['--no-open']);
  assert.equal(await exited(repeated), 0, repeated.output);
  assert.match(repeated.output, /已经运行|已在运行/);
  assert.equal(original.exitCode, null);
  const view = await fetch(`http://127.0.0.1:${port}/api/rooms/${created.roomId}/view?token=${created.token}`);
  assert.equal(view.status, 200);
  const controller = new AbortController();
  context.after(() => controller.abort());
  const stream = await fetch(`http://127.0.0.1:${port}/api/rooms/${created.roomId}/stream?token=${created.token}`, { signal: controller.signal });
  const reader = stream.body.getReader();
  assert.equal((await reader.read()).done, false);
  const stopped = launch(target, 'stop.mjs', port);
  assert.equal(await exited(stopped), 0, stopped.output);
  assert.equal(await exited(original), 0, original.output);
  while (!(await reader.read()).done) {}
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/modes`));
  const repeatedStop = launch(target, 'stop.mjs', port);
  assert.equal(await exited(repeatedStop), 0, repeatedStop.output);
  assert.match(repeatedStop.output, /未运行|没有.*运行/);
});

test('stop finds custom-port services without needing the original PORT environment', async (context) => {
  const target = fixture(context);
  const ports = [await freePort(), await freePort()];
  const servers = ports.map((port) => launch(target, 'start.mjs', port, ['--no-open']));
  await Promise.all(servers.map((child, index) => ready(child, ports[index])));
  const stopped = launch(target, 'stop.mjs', 5173);
  assert.equal(await exited(stopped), 0, stopped.output);
  for (const child of servers) assert.equal(await exited(child), 0, child.output);
  for (const port of ports) await assert.rejects(fetch(`http://127.0.0.1:${port}/api/modes`));
});

test('local shutdown requires the private token and never exposes control files through the game', async (context) => {
  const target = fixture(context);
  const port = await freePort();
  const child = launch(target, 'start.mjs', port, ['--no-open']);
  await ready(child, port);
  const filename = path.join(target.directory, '.planetx', `${port}.json`);
  assert.ok(fs.existsSync(filename));
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  assert.equal(record.port, port);
  assert.match(record.token, /^[a-f0-9]{64}$/);
  if (process.platform !== 'win32') assert.equal(fs.statSync(filename).mode & 0o777, 0o600);
  const publicResponse = await fetch(`http://127.0.0.1:${port}/.planetx/${port}.json`);
  assert.equal(publicResponse.status, 404);
  const rejected = await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { method: 'POST' });
  assert.equal(rejected.status, 403);
  const crossOrigin = await fetch(`http://127.0.0.1:${record.controlPort}/stop`, {
    method: 'POST', headers: { authorization: `Bearer ${record.token}`, origin: 'https://example.invalid' },
  });
  assert.equal(crossOrigin.status, 403);
  const wrongMethod = await fetch(`http://127.0.0.1:${record.controlPort}/stop`, { headers: { authorization: `Bearer ${record.token}` } });
  assert.equal(wrongMethod.status, 404);
  assert.equal(child.exitCode, null);
  assert.equal((await fetch(`http://127.0.0.1:${port}/api/modes`)).status, 200);
});

test('an occupied game port is reported without opening or shutting down the unrelated service', async (context) => {
  const target = fixture(context);
  const unrelated = http.createServer((request, response) => response.end('other-project'));
  await new Promise((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => unrelated.close(resolve)));
  const port = unrelated.address().port;
  const child = launch(target, 'start.mjs', port, ['--no-open']);
  assert.equal(await exited(child), 1, child.output);
  assert.match(child.output, /占用/);
  const stopped = launch(target, 'stop.mjs', port);
  assert.equal(await exited(stopped), 0, stopped.output);
  assert.equal(await fetch(`http://127.0.0.1:${port}/`).then((response) => response.text()), 'other-project');
});

test('stale records are harmless and malformed identities never trigger shutdown requests', async (context) => {
  const target = fixture(context);
  const port = await freePort();
  const child = launch(target, 'start.mjs', port, ['--no-open']);
  await ready(child, port);
  const filename = path.join(target.directory, '.planetx', `${port}.json`);
  assert.ok(fs.existsSync(filename));
  const record = JSON.parse(fs.readFileSync(filename, 'utf8'));
  child.kill('SIGTERM');
  assert.equal(await exited(child), 0);
  fs.writeFileSync(filename, JSON.stringify(record));
  const staleStop = launch(target, 'stop.mjs', port);
  assert.equal(await exited(staleStop), 0, staleStop.output);
  assert.equal(fs.existsSync(filename), false);
  let shutdownRequests = 0;
  const unrelated = http.createServer((request, response) => {
    if (request.method === 'POST') shutdownRequests++;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ app: 'unrelated-service' }));
  });
  await new Promise((resolve) => unrelated.listen(0, '127.0.0.1', resolve));
  context.after(() => new Promise((resolve) => unrelated.close(resolve)));
  fs.writeFileSync(filename, JSON.stringify({ ...record, controlPort: unrelated.address().port }));
  const refused = launch(target, 'stop.mjs', port);
  assert.equal(await exited(refused), 1, refused.output);
  assert.equal(shutdownRequests, 0);
  assert.equal(unrelated.listening, true);
});
