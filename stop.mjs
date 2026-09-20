import { stopServices } from './server/local-control.js';

console.log('\n  X行星之谜 · 一键关闭');
console.log('  仅关闭当前项目启动器登记的服务，不结束其他 Node 进程。');
console.log('  注意：关闭后内存中的房间会消失，下次需要重新开局。\n');

try {
  const results = await stopServices();
  if (!results.length) console.log('  当前项目的一键服务未运行，无需关闭。');
  for (const result of results) {
    if (result.error) {
      console.error(`  ✗ 端口 ${result.port}：${result.error}`);
      process.exitCode = 1;
    } else if (result.stopped) console.log(`  ✓ 已关闭端口 ${result.port} 的服务。`);
    else console.log(`  端口 ${result.port} 的服务已未运行，已清理失效启动记录。`);
  }
  console.log('\n  未登记的旧服务或直接运行 server.mjs 的服务，请到原终端按 Ctrl+C 关闭。\n');
} catch (error) {
  console.error(`  ✗ 无法读取当前项目的服务记录：${error.message}`);
  process.exitCode = 1;
}
