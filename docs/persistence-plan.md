# 房间持久化与标注跟随身份 · 落地方案

面向 README「后续路线」第 1、2 项：把内存房间落盘，并把手写星图标注从浏览器迁到随 `roomId + playerId + token` 身份可换设备恢复。本文是实施计划，不实现功能。

## 目标与边界

**目标**

1. **房间持久化**：进程重启后，未过期的联机房间（含单人内置、教学、观战席）可从磁盘恢复；玩家用已有 `roomId + token` 重连后继续对局与 SSE 推送。
2. **标注跟随身份**：星图手写标注（及与之绑定的初始线索同步元数据、教学待确认标注）以服务端为权威，换设备 / 清浏览器本地存储后仍可按身份取回。

**边界（本方案内）**

- 仍保持**零运行时依赖**；P0 用项目内 JSON 文件，不引入数据库或 ORM。
- 不改变玩法、脱敏规则、`PRIVATE_KEYS`、谜题生成与教学脚本语义。
- 不解决异地公网部署、多进程共享房间、跨机器房间迁移。
- 离线记录模式（`planetx.save.v3` + `planetx.notes.v1`）继续只走浏览器；本方案只管**有 `state.remote` 的联机房间**。
- `.planetx/` 仍只服务启停控制（端口 / 令牌），**不**与对局存档混用。

## 现状

### 房间（内存）

- `server.mjs`：`export const rooms = new Map()`；创建 / 加入写入 Map；`GET .../view`、`POST .../action`、`GET .../stream`（SSE）均从 Map 取房。
- `cleanupRooms()`：无 SSE 监听且 `createdAt` 早于 12 小时的房间从 Map 删除；入口进程上约每 30 分钟跑一次。
- `public/src/room.js`：`createRoom` 产出权威状态，主要包括：
  - 身份与配置：`id`、`createdAt`、`modeId`、`playMode`、`initialClueCount`、`hostId`、`phase`
  - 对局：`session`（共用时间轨 / 日志 / 天窗等）、`players`（含 `token`）、`playerTopics`、`topicNames`、`conferenceNames` / `conferenceRules`、`setup`、`research`、`conference`、`endgame`
  - 内置 / 教学：`puzzle`（答案仅服务端）、`tutorialState` / `tutorialView`（教学）
  - 运行时：`listeners`（`Set`，SSE 连接，**不可序列化**）、`revision`（由 `server.mjs` 维护）
- 身份重连：客户端 `public/src/online.js` 的 `saveRoom` 把 `{ roomId, playerId, token }` 写入 **sessionStorage**（`planetx.room.v1`），并清除旧版 localStorage 同键；刷新同标签可重连，**换标签 = 新玩家**。令牌也可放 body / query / `x-room-token`。
- 重启后：Map 清空 → 404「房间不存在或已过期」；浏览器里的身份与本地标注无法恢复房间或 `puzzle`。

### 标注（本机）

- `public/ui/app.js`：`notes` 形如 `{ "sector:code": "yes"|"no" }`（空 / 清除则删键）。
- 联机键：`notesKey = planetx.notes.${roomId}.${playerId}`；另有旁路键：
  - `${notesKey}.initial-clues`：初始线索自动「不存在」标注的 `signature` / `owned`
  - `${notesKey}.tutorial-mark`：教学标记已接受但视图尚未追上时的待应用草稿
- `persist()` 在联机时只写上述 localStorage；**不**随房间 API 上传。
- 换设备、清站点数据、或只用 session 身份在另一浏览器重连时，标注丢失（房间若仍在内存则可进房，但星图空白）。

## 总体思路（为何两项一起做）

1. **同一身份模型**：房间恢复依赖 `token`；标注若继续只绑 localStorage，则「房间能恢复、推理笔记不能」会在重启 / 换机场景反复踩坑。两项共用 `roomId + playerId + token` 鉴权更一致。
2. **同一落盘骨架**：房间快照与按玩家标注都是「可 JSON 化的权威状态 + 内存热缓存」。一套 `data/` 读写、原子写、启动加载、删除清理即可复用，避免两次改 `server.mjs` 生命周期。
3. **同一测试切面**：`tests/server.test.js` / `tests/client.test.js` / `tests/app-state.test.js` 已覆盖身份、revision、初始线索与教学标记；持久化与标注 API 可挂在同一启停与内存分派路径上验收。
4. **仍可分阶段交付**：P0 可先房间落盘、标注 API 只读空对象；P1 再把标注写服务端并做本地缓存回退——但设计与目录约定一次定稿，避免二次迁移。

## 存储设计（路径、格式、密钥、隐私）

### 路径

建议与 `.planetx/` 并列、专管对局数据（名称可微调，原则是**不进静态 `public/`、默认 gitignore**）：

```text
data/                          # 或 PLANETX_DATA_DIR 覆盖
  rooms/
    <ROOMID>.json              # 单房间权威快照（含 puzzle、tokens）
  notes/
    <ROOMID>/
      <PLAYERID>.json          # 该座位的标注包
```

- 环境变量：`PLANETX_DATA_DIR`（绝对或相对项目根）；缺省 `path.join(projectRoot, 'data')`。
- `.gitignore` 增加 `/data/`（或所选目录名）。**不要**把对局快照写进 `.planetx/`（该目录语义是本机控制面）。
- 测试：用临时目录（`os.tmpdir()` + 用例前缀），经同一环境变量注入，避免污染开发机 `data/`。

### 房间文件格式（草案）

```json
{
  "version": 1,
  "savedAt": 0,
  "room": { /* 可 JSON 化的房间字段，见下节 */ }
}
```

- `version`：便于日后字段迁移；P0 只认 `1`，未知版本跳过并打日志。
- 文件名大写房间码，与 API `parts[2].toUpperCase()` 一致。

### 标注文件格式（草案）

```json
{
  "version": 1,
  "updatedAt": 0,
  "notes": { "0:2": "yes", "3:1": "no" },
  "initialClueSync": { "signature": "[...]", "owned": ["..."] },
  "pendingTutorialMark": null
}
```

- 值域与前端一致：`notes` 仅 `"yes"` / `"no"`；`pendingTutorialMark` 结构对齐现有教学草稿字段（`stepId`、`revision`、`sector`、`code`、`markState`）。
- 观战者：默认可有空标注文件或不建文件；P0 允许观战读写自己的键（与今天本机行为一致），不把标注广播给他人。

### 密钥与隐私

- **磁盘上的房间文件含 `players[].token` 与 `puzzle`**：与内存同等敏感。依赖本机目录权限；README 明确「勿分享 `data/`、勿把数据目录映射到公网静态服务」。
- API 层不变：视图仍经 `viewFor` 脱敏；标注接口**必须** `playerByToken`，且只返回 / 写入**本人** `playerId` 对应文件。
- 教学 Bot：现有规则已禁止 Bot token 访问 view / stream / action；标注 API 同样拒绝非 `tutorialState.humanId`。
- 不把标注塞进 SSE `view` 广播（避免每人推送膨胀、也避免误进他人快照）；用独立 HTTP 读写，或仅在本人 `view` 可选附带（P1 再议，默认独立更清晰）。

### 原子写

复用零依赖做法：写 `*.json.tmp` → `fs.rename` 覆盖目标；读失败则保留内存旧值并记警告，避免半截 JSON 拖垮启动。

## 房间持久化（读写时机、快照内容、恢复、清理、SSE 重连）

### 模块划分（建议新建，薄封装）

| 模块 | 职责 |
| --- | --- |
| `server/persist.js`（新） | 数据目录解析、原子读写、房间/标注路径、启动扫描加载、删除文件 |
| `server.mjs` | 在 create / join / 成功 action / 需要 bump `revision` 处调用 `scheduleSave(room)`；启动时 `loadAllRooms(rooms)`；`cleanupRooms` 同步删文件 |
| `public/src/room.js` | 可选导出 `serializeRoom(room)` / `hydrateRoom(plain)`（纯函数，便于单测）；**不**引入 `fs` |
| `start.mjs` / README | 说明数据目录、重启可恢复、清理策略；无需新依赖 |

逻辑仍以 `room.js` 为权威；`server.mjs` 继续做 HTTP/SSE 壳。

### 快照内容

**写入**

- 包含：`id`、`createdAt`、`modeId`、`playMode`、`initialClueCount`、`puzzle`、`session`、`players`（含 token / spectator / bot / host 标记）、`playerTopics`、`topicNames`、`conferenceNames`、`conferenceRules`、`phase`、`research`、`conference`、`setup`、`hostId`、`endgame`、`revision`、`tutorialState`、`tutorialView`（若有）。
- **排除**：`listeners`（启动后 `new Set()`）。
- `session` 侧：确认无裸 `Set`/`Map`/`function`（`researched` 等由 `viewFor` 现算，不落在 room 根上即可）。若未来往 room 挂运行时句柄，序列化白名单要显式维护。

**恢复**

1. 启动（`isMain` 或 `createServer` 首次就绪钩子）：扫描 `rooms/*.json` → hydrate → `rooms.set(id, room)`，`room.listeners = new Set()`。
2. 校验最低字段（`id`、`players`、`session`、`phase`）；失败则跳过该文件并告警，不阻断服务启动。
3. 不自动重连 SSE：连接是进程内资源；客户端现有 EventSource `retry: 2000` 与 `openStream` 在服务恢复后会再连，服务端按 token 把 listener 加回即可——与「房间一直在内存、短暂断线」路径相同。
4. `revision`：恢复磁盘值；之后每次成功状态变更继续 `+1`，保证迟到快照仍可被客户端丢弃（`app.js` `applyRemoteView`）。

### 读写时机

- **同步写风险**：每个 action 同步 `writeFileSync` 可能拖慢联机手感。P0 建议：
  - `scheduleSave(room)`：按 `room.id` 合并（debounce ~50–200ms，或「脏标记 + 下一 tick」）；
  - 进程 `SIGINT` / `beforeExit` / `server.close` 时 **flush** 全部脏房间（与现有关闭时结束 SSE 同一处挂钩）。
- **必刷点**（可跳过 debounce）：创建房间、加入玩家、成功 `applyRoomAction` / `applyTutorialAction`、显式会改成员或 phase 的路径。
- **不写**：纯 SSE 连接增减、heartbeat ping。

### 清理

- 扩展现有 `cleanupRooms`：从 Map 删除时 **同时** `unlink` 对应 `rooms/<ID>.json` 与 `notes/<ID>/` 目录。
- 策略仍以「无监听 + `createdAt` 超 12h」为准（与今一致）；可选 P1：增加 `lastActivityAt`（每次成功 action 更新），避免「建房后挂机 12h 但曾有过对局」误杀——若做，快照字段一并持久化。
- 终局房间：不因 `phase === 'done'|'reveal'` 立即删盘；仍走同一 TTL，便于结算后回看；若产品要「结束后 N 小时删」，单独立项。

### SSE 与身份

- 重启后客户端 sessionStorage 仍持有 token → `fetchView` / `openStream` 命中已 hydrate 的房间即可，**无需**改 `saveRoom` 存储介质。
- 若房间文件已按 TTL 删除：保持现有 404 / 403 文案，客户端 `clearRoom` 逻辑不变。
- 多实例：`data/` 不做文件锁；文档写明「同一 `PLANETX_DATA_DIR` 只应跑一个 Node 进程」。

## 标注跟随身份（API、同步策略、与本地缓存关系、初始线索/教学标注）

### API（挂在现有房间鉴权之后）

均需有效 token；教学仅 human：

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| `GET` | `/api/rooms/:id/notes` | 返回该玩家标注包（无文件则空对象默认值） |
| `PUT` | `/api/rooms/:id/notes` | 整包替换或合并（见下）；校验 notes 键值形态 |

- 实现位置：`server.mjs` `handleApi` 中与 `view` / `action` 并列；读写走 `server/persist.js`。
- 客户端：`public/src/online.js` 增加 `fetchNotes` / `putNotes`；`public/ui/app.js` 的 `persist` / 进房 / `writeNote` 调用它们。

### 同步策略（推荐）

1. **进房 / 重连成功**（已有 `saveRoom` + 首屏 `view` 之后）：`GET notes` → 写入 `state.notes` 与 `initialClueSync` / `pendingTutorialMark` → 再跑现有 `syncInitialClues` / `syncTutorialMark`（服务端数据优先于陈旧本地）。
2. **本地更改**：先更新内存 + 写 localStorage 缓存（乐观 UI），再 `PUT`；失败 toast，保留本地脏数据，允许稍后重试（P0 可简化为失败提示 + 下次 persist 再试）。
3. **冲突**：P0 采用 **Last-Write-Wins**（整包 `updatedAt` / 服务端覆盖）。标注是单人私有推理，无多人编辑同一文件。不必做 OT。
4. **合并策略**：`PUT` body 为完整标注包；服务端校验后整文件替换，避免逐键协议复杂化。

### 与本地缓存关系

- localStorage 键名可保留，作为**离线缓存与弱网缓冲**，不再是唯一权威。
- 进房时：若 GET 成功，用服务端覆盖本地；若 GET 失败（旧服务无路由），保持仅本地（能力探测：404 则降级，与内置能力检查相同思路）。
- 清 notes / 换房：继续清本机对应键；服务端文件随房间 TTL 删除。

### 初始线索 / 教学标注

- **`initial-clues`**：迁入标注包的 `initialClueSync` 字段；`syncInitialClues` 读写改为「内存字段 + persist 上传」，逻辑（owned / signature / 重填撤自动排除）保持不变。
- **`tutorial-mark`**：迁入 `pendingTutorialMark`；`syncTutorialMark` 在 revision / stepId 条件满足时落笔记并清空待定，经同一 PUT 持久化。
- 两者仍是**该玩家私有**，不进公开 `view`，不进观战脱敏例外以外的任何广播。

## 分阶段落地（P0/P1/P2）

### P0 — 可重启续局（最小可用）

- [ ] `server/persist.js` + `data/` gitignore + `PLANETX_DATA_DIR`
- [ ] 房间 serialize / hydrate；启动加载；create/join/action 后落盘；cleanup 删文件；关闭 flush
- [ ] 标注：目录与文件格式就位；`GET/PUT .../notes` 可用；前端进房拉取 + persist 上传；localStorage 作缓存
- [ ] README「后续路线」1–2 与重启说明改为「默认可恢复（见 data 目录）」
- [ ] 测试：临时目录下重启 Map 等价恢复；token 重连 view/SSE；标注跨「新 App 状态」恢复

### P1 — 稳健与体验

- [ ] `lastActivityAt` 参与 TTL；脏写 debounce 调参；启动损坏文件隔离（`.bad` 后缀）
- [ ] 标注 PUT 失败重试队列；旧服务无 notes API 的明确降级文案
- [ ] 可选：本人 `view` 附带 `notesRevision`，减少进房额外 RTT（非必须）

### P2 — 明确不做或另开议题

- 数据库、多进程、备份加密、标注实时多人协作、离线记录云同步、把 `.planetx` 改成存档根

## 测试与验收

**自动化（延续零依赖 + `tests/server-dispatch.js` 内存分派）**

- 新建或扩展：`tests/persist.test.js`（serialize 往返、排除 listeners、损坏 JSON、原子写）。
- `tests/server.test.js`：写盘 → 清空 Map → 再 load → 同 token `view` / `action` / `stream`；cleanup 删除文件。
- `tests/app-state.test.js` / `tests/client.test.js`：notes GET/PUT；初始线索 owned 与教学 pending 经服务端往返；观战 / Bot 拒绝。
- 教学与内置：`tests/tutorial-server.test.js`、`tests/builtin-room.test.js` 抽检「落盘后 hydrate 仍能推进」。

**手工验收**

1. 建内置或记录房间 → 行动若干 → 标几个扇区 → Ctrl+C 停服 → 再 `node start.mjs` → 原标签刷新：房间阶段与标注都在。
2. 同房间码 + 另一浏览器仅有身份时（或复制 token 测试页）：标注可 GET 到（需先在该浏览器 saveRoom 或重新加入——**正式产品仍靠原标签 session 身份**；换设备需保留/迁移 token，P0 文档如实写清）。
3. 12h 空闲无监听清理后：API 404，磁盘无残留房间/标注目录。
4. 确认静态服务无法通过 HTTP 直接下载 `data/rooms/*.json`。

## 风险与不做的事

**风险**

- **密钥落盘**：机器被访问则房间码 + token + 谜底可读；接受「本机桌面工具」威胁模型，文档警告即可。
- **写放大 / 损坏**：高频 action + 不完整写；靠 debounce、原子 rename、损坏跳过缓解。
- **版本漂移**：新代码读旧快照或相反；`version` 字段 + 未知则拒载，避免半恢复。
- **换设备身份**：token 仍在 sessionStorage，换设备不会自动带身份——标注上云解决的是「有身份之后」的笔记，不是账号系统。若用户期望「只记房间码就能换机」，需另做会话导出，**本方案不做**。
- **测试并行**：共用默认 `data/` 会打架；测试必须注入独立目录。

**不做的事**

- 不引入 npm 依赖或外部 DB。
- 不把标注或 `puzzle` 打进公开 SSE 广播。
- 不改变双标签 = 双玩家的 sessionStorage 身份模型。
- 不自动迁移历史浏览器-only 标注到服务器以外的「无 token」场景。
- 不实现云同步账号、端到端加密、或跨主机房间复制。
- 本文档阶段**只新增计划**，不修改 `server.mjs` / `app.js` 行为；实现另开 PR。
