// Friendly launcher: `node start.mjs` (or double-click start-server.cmd).
//
//   node start.mjs           -> serves the console to this machine *and* the LAN,
//                               so a table can join from their own devices
//   node start.mjs local     -> this machine only
//   PORT=5180 node start.mjs -> a different port
//
// All the diagnostics live here rather than in the .cmd: cmd cannot print UTF-8 after
// switching its codepage, and Node can.
import { createServer, lanUrls } from './server.mjs';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { registerService, runningService } from './server/local-control.js';

const port = Number(process.env.PORT || 5173);
const localOnly = process.argv.includes('local') || process.env.HOST === '127.0.0.1';
const host = localOnly ? '127.0.0.1' : '0.0.0.0';
const shouldOpen = process.argv.includes('--open') && !process.argv.includes('--no-open');

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('  ✗ PORT 必须是 1 到 65535 之间的整数。');
  process.exit(1);
}

const line = '─'.repeat(54);
const out = (text = '') => process.stdout.write(`${text}\n`);

out();
out(`  X行星之谜 · 内置谜题与记录工作台`);
out(`  ${line}`);
out(`  本机打开：      http://127.0.0.1:${port}/`);
if (!localOnly) {
  const lan = lanUrls(port);
  if (lan.length) {
    out(`  同桌设备打开：  ${lan.map((u) => u).join('\n                  ')}`);
    out(`                  （需在同一个 Wi-Fi；把上面地址发给同桌的人）`);
  } else {
    out(`  ⚠ 没有找到局域网地址，其他设备暂时连不上（可用 local 参数只开本机）`);
  }
}
out();
out(`  单人解谜：点「新对局 → 内置谜题」，系统出题并自动结算。`);
out(`  联机玩法：一人点「联机 → 创建房间」拿到 6 位房间码，`);
out(`            其他人点「联机 → 加入房间」输入房间码。`);
out(`  ${line}`);
out(`  这个窗口就是服务器：关掉它 = 停止服务，房间会一起消失。`);
out(`  玩的过程中浏览器刷新没有影响，房间与身份都会保留。`);
out(`  一键关闭：双击「一键关闭.command」（Mac）或 stop-server.cmd（Windows）。`);
out(`  想改端口：${process.platform === 'win32' ? 'set PORT=5180' : 'PORT=5180 node start.mjs'}。`);
out(`  ${line}`);
out();

const server = createServer();
let registration;
let closing = false;

function openPage() {
  if (!shouldOpen) return;
  const url = `http://127.0.0.1:${port}/`;
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const browser = spawn(command, args, { stdio: 'ignore', windowsHide: true, env: process.env });
  browser.on('error', () => out(`  无法自动打开浏览器，请手动访问 ${url}`));
  browser.on('exit', (code) => { if (code) out(`  浏览器未能自动打开，请手动访问 ${url}`); });
  browser.unref();
}

async function bye() {
  if (closing) return;
  closing = true;
  out('\n  正在关闭服务；内存房间将在关闭后消失…');
  await new Promise((resolve) => server.close(resolve));
  try { await registration?.close(); }
  catch (error) { out(`  启动记录未能清理：${error.message}`); }
  out('  服务器已停止。下次启动需要重新开一个房间。');
  process.exit(0);
}

server.on('error', async (err) => {
  if (err && err.code === 'EADDRINUSE') {
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        const existing = await runningService(port);
        if (existing && !existing.stopping) {
          out(`  ✓ 当前项目已在运行，沿用端口 ${port}，不会重启或清空房间。`);
          openPage();
          return;
        }
        await delay(100);
      }
    } catch (error) { out(`  ${error.message}`); }
    out(`\n  ✗ 端口 ${port} 已被占用，且无法核验为当前项目启动器的服务。`);
    out('    不会结束占用进程。若是旧服务，请在原终端处理；或通过 PORT 更换端口。\n');
    process.exitCode = 1;
    return;
  }
  out(`  ✗ 启动失败：${err.message}`);
  process.exitCode = 1;
});

server.listen(port, host, async () => {
  try {
    registration = await registerService({ port, host, onStop: bye });
    out(`  ✓ 已启动，等待连接…（保持本窗口打开；按 Ctrl+C 或双击关闭脚本停止）`);
    out();
    openPage();
  } catch (error) {
    out(`  ✗ 无法登记一键关闭信息：${error.message}`);
    server.close(() => { process.exitCode = 1; });
  }
});

process.on('SIGINT', bye);
process.on('SIGTERM', bye);
process.on('SIGHUP', bye);
