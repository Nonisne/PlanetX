# 时间轨与内置谜题 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking. 本项目不是 Git 仓库，不创建分支、不提交。

**Goal:** 将时间统一为圈／格与时间单位，并在开始前选择保留的记录模式或标准棋盘内置谜题模式。

**Architecture:** 数值时钟与现有存档保持原义，显示按棋盘格数换算。内置谜题由独立服务端模块生成，房间模型持有隐藏答案并自动计算查询、评审和定位，所有 HTTP/SSE 仅返回按玩家过滤的视图。单人内置模式也使用房间服务，复用多人时间轨和终局规则。

**Tech Stack:** 原生 JavaScript ES modules、DOM/SVG、Node HTTP/SSE、node:test；不增加依赖。

---

## 已确认范围

- 记录模式保持离线记录、联机同步、手动填写官方 app 结果、12/18 扇区与旧存档。
- 内置模式第一版支持标准 12 扇区，1–6 人；开局前明确提示需要本地服务。专家棋盘仍可在记录模式使用。
- 内置谜题使用原创约束与线索，不抓取或复制官方题库，不接入未验证的官方接口。
- 地球仍跟随全桌可见窗口中线，不跟随个人时钟。
- 内置答案不进入 session、客户端保存、开局视图、房间摘要或行动响应；未来会议线索不提前公开。
- 内置模式禁止手动结果、手动拨窗、撤销查询、篡改会议或线索；查询得到的结果自动写入私有历史。
- 正确定位后完成其他玩家最后机会，自动揭晓并按既有规则结算；单人直接揭晓。
- 不擅自重启现有服务或清空房间。

## Task 1: 时间单位（独立文件集）

Files: `public/src/rules.js`, `public/src/console.js`, `public/ui/board.js`, `public/ui/history.js`, `public/ui/notesheet.js`, `public/ui/endgame.js`, `tests/rules.test.js`, `tests/console.test.js`, `tests/history-ui.test.js`, `tests/endgame-ui.test.js`。

- [x] 写换圈边界测试：`timeParts(12, MODES.standard)` 为 `{lap:2,step:1}`，`timeParts(17, MODES.expert)` 为 `{lap:1,step:18}`，`timeParts(18, MODES.expert)` 为 `{lap:2,step:1}`。
- [x] 运行 `node tests/rules.test.js` 确认旧历法失败。
- [x] 实现 `timeLabel(units,mode)`、`timeShort(units,mode)`、`durationLabel(units)`，所有调用传棋盘模式。耗时文字为 `N 个时间单位`。`consoleSummary` 增加 units/laps/durationLabel，旧字段仅作兼容不展示。
- [x] 修订上述文件现有测试，验证相同数值时钟、成本、天窗和旧记录不变。

## Task 2: 原创标准谜题引擎（独立文件集）

Files: create `server/puzzles.js`, `tests/puzzles.test.js`。

- [x] 首先测试标准数量、彗星质数、成组小行星、气体云紧邻真正空域、矮行星不邻 X；X 的查询伪装为空域。
- [x] 实现 `createPuzzle({modeId='standard', random=Math.random})`，返回 `{objects,topics,conferences}`；objects 为12个类型字符串，topics 为 A–F 的 `{name,clue}`，conferences 为 `{10:线索字符串}`。不支持专家时明确报错。
- [x] 实现 `initialCluesFor(puzzle,{count=4,random=Math.random})` 返回不重复、真实的 `{sector,objectType}` 排除线索（sector 从0开始，不能把伪装为空域的 X 错误排除）。
- [x] 测试每条线索与答案一致，完整线索能唯一确定谜底，连续生成有变化且运行时间可接受；不把固定题库或答案放到 public。
- [x] 运行 `node tests/puzzles.test.js` 并记录证据。

## Task 3: 服务端权威房间

Files: `public/src/room.js`, `server.mjs`, `public/src/online.js`, create `tests/builtin-room.test.js`, update `tests/server.test.js`。

- [x] 添加 `playMode: 'record' | 'builtin'`（默认 record），创建内置房间时注入 puzzle。题目只保存在私有 room 字段。
- [x] 编写失败测试：单人内置开局、准备确认、两玩家私有线索与历史、篡改结果无效、不泄露完整题目／未查询线索。
- [x] 在动作分发边界计算 count/apparent/research text/correct；复用已有引擎校验范围、轮次与费用。
- [x] 到达会议时自动记录已触发线索；研究轨到评审位时按扇区顺序自动评审和罚时；终局自动以真实 objects 揭晓。
- [x] 拒绝内置手动 review/nudge/undo/reveal/set-info，保持记录模式原有入口。
- [x] 运行新模型测试与 `node tests/room.test.js`、HTTP/SSE 测试，覆盖最后机会、重连和越权请求。

## Task 4: 模式选择与闭环界面

Files: `public/ui/app.js`, `public/ui/panels.js`, `public/styles.css`, `tests/client.test.js`, `tests/ui.smoke.test.js`。

- [x] 开局弹窗与创建房间提供记录／内置选择；选择内置时明确标准棋盘与服务依赖，不悄悄降级专家模式。
- [x] 单人内置建立私有房间并自动进入准备；多人由房主开始。初始私有线索由服务端分发，玩家只确认准备。
- [x] 内置行动卡移除手填 count/apparent/research text/locate correct；保留查询选择、结果反馈、研究与终局。
- [x] 对内置隐藏记录专用校准／撤销／共享信息修改入口；房间与状态栏显示当前模式。
- [x] 补齐所有 UI 的圈／格／时间单位文案，保留离线记录存档和私有笔记隔离。
- [x] 客户端与 UI 测试覆盖模式创建参数、离线存档恢复、服务不可用错误与两模式不同动作表单。

## Task 5: 验证与交付

Files: `tests/all.test.js`, `README.md`, `docs/builtin-puzzles-2026-09-20.md`, `audit/evidence/*`。

- [x] 将新测试加入总入口，运行 `node tests/all.test.js`，要求全部通过。
- [x] 独立端口启动 QA 服务；通过浏览器完成单人新局、查询、研究、会议、错误／正确定位、得分与刷新重连。
- [x] 检查桌面与窄屏布局，回归记录模式／18扇区换圈／地球位置。
- [x] 定向评审服务端答案与私有信息边界；修复确认问题并重跑相关测试。
- [x] 更新当前 README 与交付说明，明确进程重启会清空内存房间，须现有对局结束后再重启旧服务以加载新后端。

## 验收记录

- 2026-09-20：`PUZZLE_EXHAUSTIVE=1 node tests/all.test.js`，12 文件、267 项通过，0 失败、0 跳过；穷举 4,446 张合法标准盘。
- 用户追加的“空域”术语已统一到运行时标签、提示、记录和新生成线索；不改写用户保存的手填原文或历史审计证据。
- 集成复查确认并修复身份误清除、跨房间 pending 干扰、迟到快照回退及论文容量耗尽卡局，定向复查 11 项通过，未发现新增阻塞问题。
- 单人闭环、双人隐私与阶段、刷新恢复、18 格换圈、320／390px 窄屏均已实际浏览器验证。临时标签页已关闭，视口已恢复，独立 5192 QA 服务已停止。
- 详细口径与证据索引：`docs/builtin-puzzles-2026-09-20.md`。

## 执行约束

备份：`/private/tmp/planetx-before-builtin-20260920.tgz`。各任务文件写入范围互斥；房间与应用主链由主执行者负责，时间显示和谜题引擎可并行。仅使用 apply_patch 编辑源文件。不改历史审计结论，不引入机器人、官方题库、账号或在线部署。
