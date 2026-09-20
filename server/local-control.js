import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const project = fs.realpathSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
const directory = path.join(project, '.planetx');
const app = 'planet-x-local-service-v1';
const validPort = (port) => Number.isInteger(port) && port > 0 && port <= 65535;
const filenameFor = (port) => path.join(directory, `${port}.json`);

function readRecord(port) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(filenameFor(port), 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new Error(`端口 ${port} 的启动记录无法读取，未操作任何服务。`);
  }
  if (record.app !== app || record.project !== project || record.port !== port || !validPort(record.controlPort) || !/^[a-f0-9]{64}$/.test(record.token)) {
    throw new Error(`端口 ${port} 的启动身份无法核验，未操作任何服务。`);
  }
  return record;
}

function removeRecord(record) {
  if (readRecord(record.port)?.token === record.token) fs.unlinkSync(filenameFor(record.port));
}

function requestControl(record, action) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1', port: record.controlPort, path: `/${action}`,
      method: action === 'stop' ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${record.token}`, connection: 'close' },
      agent: false, timeout: 1500,
    }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
        if (body.length > 8192) response.destroy(new Error('控制响应超出大小限制'));
      });
      response.on('error', reject);
      response.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (response.statusCode !== 200 || result.app !== app || result.project !== project || result.port !== record.port || result.pid !== record.pid) {
            throw new Error('服务身份不匹配，未关闭任何其他进程。');
          }
          resolve(result);
        } catch (error) { reject(error); }
      });
    });
    request.on('timeout', () => request.destroy(new Error('本地服务响应超时，请检查原启动窗口；未强制结束进程。')));
    request.on('error', reject);
    request.end();
  });
}

export async function runningService(port) {
  const record = readRecord(port);
  if (!record) return null;
  try {
    return await requestControl(record, 'status');
  } catch (error) {
    if (error.code === 'ECONNREFUSED') return null;
    throw error;
  }
}

export async function registerService({ port, host, onStop }) {
  const token = randomBytes(32).toString('hex');
  const identity = { app, project, port, host, pid: process.pid };
  const expected = Buffer.from(`Bearer ${token}`);
  let stopping = false;
  const control = http.createServer((request, response) => {
    const supplied = Buffer.from(request.headers.authorization || '');
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    if (request.headers.origin || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      response.writeHead(403).end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    if (request.method === 'GET' && request.url === '/status') {
      response.end(JSON.stringify({ ...identity, stopping }));
      return;
    }
    if (request.method === 'POST' && request.url === '/stop') {
      const firstRequest = !stopping;
      stopping = true;
      response.end(JSON.stringify({ ...identity, stopping }), () => {
        if (firstRequest) onStop();
      });
      return;
    }
    response.writeHead(404).end(JSON.stringify({ error: 'not found' }));
  });
  control.requestTimeout = 3000;
  control.headersTimeout = 3000;
  await new Promise((resolve, reject) => {
    control.once('error', reject);
    control.listen(0, '127.0.0.1', resolve);
  });
  const record = { ...identity, controlPort: control.address().port, token };
  const temporary = path.join(directory, `${port}-${token}.tmp`);
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filenameFor(port));
  } catch (error) {
    control.close();
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    throw error;
  }
  return {
    async close() {
      await new Promise((resolve) => {
        control.close(resolve);
        control.closeAllConnections?.();
      });
      removeRecord(record);
    },
  };
}

export async function stopServices() {
  let filenames;
  try { filenames = fs.readdirSync(directory).filter((filename) => /^\d+\.json$/.test(filename)); }
  catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const results = [];
  for (const filename of filenames) {
    const port = Number(path.basename(filename, '.json'));
    try {
      const record = readRecord(port);
      if (!record) continue;
      try { await requestControl(record, 'status'); }
      catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
        removeRecord(record);
        results.push({ port, stopped: false });
        continue;
      }
      await requestControl(record, 'stop');
      let stopped = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        await delay(50);
        if (readRecord(port)?.token !== record.token) { stopped = true; break; }
      }
      if (!stopped) throw new Error('停止请求已发送，但尚未确认完成；请检查原启动窗口。');
      results.push({ port, stopped: true });
    } catch (error) { results.push({ port, error: error.message }); }
  }
  return results;
}
