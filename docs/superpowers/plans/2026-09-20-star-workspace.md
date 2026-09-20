# 星图工作台与行动历史表 Implementation Plan

> **For agentic workers:** Use executing-plans to implement the approved design in this session. Steps use checkbox syntax for tracking.

**Goal:** 将已确认的星图优先布局应用到正式记录台，并让历史表每列对应一名玩家、每行对应一次实际记录。

**Architecture:** 保留原生 DOM/SVG、现有行动 API 与服务器脱敏。新增专用历史表和折叠面板组件；表格直接读取已脱敏的 `game.log`，不使用按玩家凑轮的 `game.rounds`，不改存档和规则引擎。

**Tech Stack:** JavaScript ES modules、CSS Grid、Node 内置测试、浏览器验收；无新依赖。

**Approved design:** 深色主题不变；左侧推理线索与可折叠参考，中间大星图及图下标注，右侧当前行动；顶部精简状态；底部通栏行动历史与积分详情。窄屏星图优先，历史表独立横向滚动。

**Workspace:** 当前目录不是 Git 仓库；直接修改，不初始化 Git、不建分支、不提交。修改前备份：`/private/tmp/planetx-before-layout-20260920.tgz`。

## File responsibilities

- `public/ui/history.js`：按记录顺序生成历史行；玩家列、公共事件、私有结果、明细展开。
- `public/ui/disclosure.js`：原生 details 面板，使用 UI 状态保留展开状态，不触发整页重绘。
- `public/ui/app.js`：调整三栏与底部区域组合，保留历史表滚动位置。
- `public/ui/panels.js`：紧凑状态栏、图下工具、线索优先、历史表入口、折叠积分。
- `public/ui/notesheet.js`：课题与论文折叠显示，待处理评审继续清晰可见。
- `public/styles.css`：桌面、中屏、窄屏布局与可访问的表格样式。
- `tests/history-ui.test.js`、`tests/ui.smoke.test.js`、`tests/all.test.js`：历史与布局回归。
- `README.md`：说明新的操作顺序、表格含义及隐私边界。

## Task 1: History regression tests

- [x] 通过 `renderLogPanel` 的真实输出验证：三次行动（包括同一人连动）产生三行，而不是拼成一轮。
- [x] 验证依照日志追加顺序，不按各自棋子的月份排序；玩家列顺序不随查看者变化；离线仅顺序列和“我”列。
- [x] 验证私有勘测数量、扫描天体、研究文本及定位答案不进入其他人的单元格或隐藏属性；公开理论可见。
- [x] 验证会议与评审罚时是独立公共事件，跨度覆盖所有玩家；最新行、历史耗时、空状态及未知作者不丢失。
- [x] 运行 `node tests/history-ui.test.js`，记录旧实现的预期失败。

核心断言：

```js
assert.equal(actionRows.length, game.log.length);
assert.deepEqual(actionRows.map(row => row.attributes['data-history-id']), ['11', '13', '14']);
assert.equal(JSON.stringify(panel).includes('他人的秘密线索'), false);
```

## Task 2: History and disclosure implementation

- [x] 创建 `renderDisclosure({ state, api, id, title, meta, open, className }, ...children)`；toggle 只调用 `setUiQuiet`，避免重绘导致输入和滚动跳动。
- [x] 创建 `renderActionHistory({ state, api })`，按 `game.log.map(...)` 建行。仅自己的记录、已公开的理论及终局定位可含结果明细；不读取 `entry.private` 或 `entry.payload`。
- [x] 单元格概览为行动、范围和真实记录耗时，details 展示结果及记录时棋子时间；公共事件不伪装成玩家的一次普通行动。
- [x] 将 `renderLogPanel` 接到新表格，保留旧 `actionRounds` 数据接口以兼容既有调用，不改变业务规则。
- [x] 运行 `node tests/history-ui.test.js`，直到全部通过。

## Task 3: Workspace layout

- [x] 更新 UI smoke 测试：history/score 是三栏外的底部区域，课题和理论归入信息栏；规则默认折叠；图例位于星图下方。
- [x] 运行 `node tests/ui.smoke.test.js` 确认新布局断言先失败。
- [x] 重排 app 组合；状态值保持可见，将校准/撤销及冗长说明放进可展开区域。
- [x] 星图卡片只保留一列，标注与图例在下；基于可用宽度和高度调整棋盘，不再用固定图例侧栏挤压它。
- [x] 已获初始/研究/会议线索保持可对照；基础规则、课题列表、论文详情、历史和积分按需展开。
- [x] 保持展开状态及历史表横纵滚动位置跨重绘稳定；新增日志不强制滚动到最新行，折叠操作不触发整页重绘。原整页渲染的输入焦点策略未作整体改造。
- [x] 使用 CSS 的三个布局层级：宽屏三栏、中屏星图+行动及通栏线索、窄屏单列星图优先。表格使用自身滚动区域，不让页面横向溢出。
- [x] 运行 `node tests/ui.smoke.test.js` 及 `node tests/endgame-ui.test.js`。

## Task 4: Final verification and documentation

- [x] 运行 `node tests/all.test.js`（HTTP/SSE 需要本机监听权限），所有用例通过。
- [x] 使用独立临时端口启动服务，不重启或修改用户已有房间。
- [x] 浏览器检查标准/专家棋盘，1280×720、1024×768、390px、320px 排版；标注弹层、输入和确认按钮不得溢出。
- [x] 建三人测试房间验收玩家列、私有明细和展开状态，另以单机连续操作验证逐条成行；核对控制台无新增错误。
- [x] 保存代表性截图及验证结果；更新 README 的旧“按回合凑行”说明。
- [x] 关闭测试页面与临时服务，保留用户原页面与对局。

## Completion

完整回归 10 个文件、194 项通过。代码复查发现的终局公开定位遮蔽、跨局结果展开复用均已用失败测试复现并修复。详情见 `docs/workspace-layout-report-2026-09-20.md`。

## Deliberate boundaries

- 不把累计棋子时间当成全桌的全局时间。
- 不新增虚构的评审时间点；已公开的评审结论在对应论文明细中标记，实际罚时记录单独作为公共事件展示。
- 不修改收费、行动顺序、评审、终局或房间权限。
- 不用预览示例数据替换真实状态；不将他人私有字段带入标题、DOM 属性或历史明细。
