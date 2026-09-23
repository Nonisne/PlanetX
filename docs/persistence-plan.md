# 手动存档 · 落地方案（简版）

替代原「自动落盘 + 标注上云」设想：做成**用户主动存档 / 读档**，零依赖、无数据库。

## 可以这样吗？

可以，而且比自动持久化更贴合本项目：

| 场景 | 做法 |
| --- | --- |
| 单机记录台 | 存档 = 本机对局 + 手写标注；加载后直接恢复 |
| 联机 / 内置房间 | 存档 = 整房快照 + 各座位身份（含 token）+ 当前玩家标注；加载时若房间不在服务上则先恢复房间，再**选择自己的座位**进入 |

存档写入浏览器本地「存档库」；可选导出／导入 JSON 以便换设备。

## 存档内容（库内条目 / 导出的 JSON）

```json
{
  "version": 1,
  "kind": "console" | "online",
  "savedAt": "ISO-8601",
  "console": { "...单机 session 字段" },
  "notes": { "sector:code": "yes|no" },
  "room": { "...可序列化房间，不含 listeners" },
  "notesByPlayer": { "<playerId>": { "...标注" } }
}
```

- `kind: "console"`：只用 `console` + `notes`。
- `kind: "online"`：用 `room` + `notesByPlayer`；`room.players[].token` 在库里，**勿把导出的文件发到公开群**（内含谜底与令牌）。

## 交互

1. 对局中点 **存档** → 写入本机存档库（浏览器 localStorage）。
2. 点 **加载存档** → 打开「我的存档」列表（不再默认弹系统文件选择器）。
3. 列表内可 **加载**、**删除**（需确认）、**导出** JSON；也可 **从文件导入**。
4. 单机存档：立即恢复记录台。
5. 联机存档：
   - `POST /api/rooms/restore`：房间不在内存则写入；已在则沿用（不覆盖正在进行的对局）。
   - 弹出 **选择身份**：列出存档中的座位名称。
   - 选定后用该座位的 `token` 进入房间，并恢复该座位的标注。

## 实现要点

- `public/src/room.js`：`serializeRoom` / `hydrateRoom`（去掉 `listeners`，恢复时 `new Set()`）。
- `server.mjs`：`POST /api/rooms/restore`。
- `public/src/archive.js`：打包／解析／存档库增删查；`online.js`：`restoreArchivedRoom`。
- `public/ui/app.js` + `panels.js`：存档按钮、「我的存档」弹窗、选座弹窗。

## 明确不做

- 不自动定时写盘、不引入数据库。
- 不做账号系统；身份只在存档条目里。
- 不在加载时静默覆盖服务器上**已存在且进行中**的同码房间。
