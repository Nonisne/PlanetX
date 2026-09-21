# Rules and Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. Preserve existing uncommitted changes; do not commit or create branches.

**Goal:** 落实已确认的十二项改进、歧义盘面过滤和同扇区前后顺序修复。

**Architecture:** 纯规则核心负责合法选项、阶段和发牌；服务器只保留未公开谜题；界面消费按玩家脱敏的投影。谜题生成与展示可在不交叉修改文件的前提下并行，主线程负责核心、接口与集成。

**Tech Stack:** JavaScript ES modules、Node 原生 HTTP/SSE、DOM/SVG、`node:test`。

## Task 1: 关系会议与题库过滤（谜题工作单元）

Files: `server/puzzles.js`, `server/research.js`, `tests/puzzles.test.js`, `tests/research.test.js`。

- [x] 先新增失败测试：所有初始线索非平凡；会议为单个 X 相对关系；合法盘面仍 4446、可出题盘面为 4428；镜像歧义例永不出题。
- [x] 用现有关系谓词构建会议，完整观测等价组仍来自所有合法盘面。
- [x] 建立可区分答案索引，按其长度均匀取随机索引，不用重试偏置采样。
- [x] 执行 `PUZZLE_EXHAUSTIVE=1 node --test tests/puzzles.test.js tests/research.test.js`，确认独立文本解析与穷举检查通过。

```js
const candidates = allLegalBoards;
const eligible = candidates.filter((board) => distinguishingConferences(board).length > 0);
assert.equal(candidates.length, 4446);
assert.equal(eligible.length, 4428);
```

## Task 2: 核心规则、阶段、初始线索（主线程）

Files: `public/src/rules.js`, `public/src/phases.js`, `public/src/console.js`, `public/src/room.js`, `server.mjs`, core/API tests。

- [x] 先测进入 3 号扇区不触发、离开触发；会议 10、回绕 12、专家 7/16 与跨多事件同理。
- [x] 将事件经过循环的标记扇区改为前一位置。
- [x] 先测同耗时早到者行动／提交优先，保留已经正确的服务端比较器。
- [x] 添加彗星零基判断与合法理论投影；提交、声明容量和终局统一使用合法性约束。
- [x] 添加每人领取计数、隐私、幂等、锁定、准备前置检查；服务器每座位预生成 12 条，房间只发选择的前 N 条。
- [x] 修正标准／专家矮行星数量文案，不改变分值。
- [x] 运行 `node --test tests/rules.test.js tests/console.test.js tests/room.test.js tests/builtin-room.test.js tests/review-order.test.js tests/official-rules.test.js`。

```js
assert.deepEqual(crossedEvents(MODES.standard, 1, 2), []);
assert.deepEqual(crossedEvents(MODES.standard, 2, 3), [
  { kind: 'theory', id: 'theory:3', time: 3, sector: 3 },
]);
assert.equal(applyRoomAction(room, playerId, { kind: 'setup' }).ok, false);
assert.equal(applyRoomAction(room, playerId, { kind: 'claim-initial-clues', count: 8 }).ok, true);
assert.equal(viewFor(room, playerId).mySetup.clues.length, 8);
```

## Task 3: 规则驱动的界面（展示工作单元）

Files: `public/ui/board.js`, `public/ui/panels.js`, `public/ui/notesheet.js`, `public/ui/endgame.js`, `public/styles.css`, `tests/ui.smoke.test.js`, `tests/endgame-ui.test.js`。

- [x] 先添加 DOM/SVG 测试：非法彗星隐藏、勘测端点受限、多象限棋子按角度排序。
- [x] 移除棋子槽位按屏幕 x/y 的二次排序，保留顺时针角序；增加天体图标间距。
- [x] 添加初始数量选择与一次领取 UI，读取 `cluesClaimed`，调用 `claimInitialClues(count)`。
- [x] 论文选择读取 `game.theoryOptions`，移除已公开扇区，兼顾终局与后续阶段不同假说；改善表单内边距。
- [x] 左栏论文两列表格、每玩家两行积分表；普通行动删除等待和论文按钮，修正事件和前后顺序说明。
- [x] 运行 `node --test tests/ui.smoke.test.js tests/endgame-ui.test.js`，界面测试中的开局准备先领取，事件按离开触发。

```js
const options = game.theoryOptions || [];
const availableTypes = options.find((option) => option.sector === ui.theorySector)?.types || [];
const maxFinalPapers = Math.min(game.endgame.quota, options.length);
```

## Task 4: 客户端集成（主线程）

Files: `public/ui/app.js`, `public/src/online.js`（仅必要时）, `tests/client.test.js`, `tests/server.test.js`。

- [x] 为领取成功立即标图、刷新恢复、无他人标记、失败不标图添加失败测试。
- [x] 接入领取 handler；在权威本人视图落地后同步新领取的排除标记，保留其他标记。
- [x] 修正论文默认扇区／类型，星图点击彗星端点受限，最终论文同样使用合法选项。
- [x] 执行客户端与隔离 HTTP 接口测试，检查所有 setup 测试通过真实领取流程。

## Task 5: 验证与交付

Files: `README.md`, 本次报告与 `audit/evidence`。

- [x] 合并后先做需求检查，再做代码质量检查，修复发现的问题。
- [ ] `PUZZLE_EXHAUSTIVE=1 node tests/all.test.js` 全套通过；必要时为隔离监听请求权限，不改现有服务。
- [x] 用隔离服务通过浏览器 UI 检查桌面、390/320 窄屏、领取标图、提交顺序与布局。
- [x] 更新说明与测试证据，清理仅本次 QA 的服务／标签页，报告结果和未完成项。

全量通过项暂不勾选：最终 376 项中 375 通过，唯一失败为未修改的 macOS 启动器等待浏览器替身文件超时；该项独立复测通过但间歇失败未解决。本轮不扩大范围修改启动器，保留原始证据并在交付说明中披露。
