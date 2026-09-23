# 手动存档 · 落地方案（简版）

替代原「自动落盘 + 标注上云」设想：做成**用户主动存档 / 读档**，零依赖、无数据库。

## 可以这样吗？

可以，而且比自动持久化更贴合本项目：

| 场景 | 做法 |
| --- | --- |
| 单机记录台 | 存档 = 本机对局 + 手写标注；加载后直接恢复 |
| 联机 / 内置房间 | 存档 = 整房快照 + 各座位身份（含 token）+ 当前玩家标注；加载时若房间不在服务上则先恢复房间，再**选择自己的座位**进入 |

「换设备」= 带上存档文件；选座位时用文件里的 token 认回身份，不必另建账号。

## 存档文件（下载的 JSON）

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
- `kind: "online"`：用 `room` + `notesByPlayer`；`room.players[].token` 在文件里，**勿把存档发到公开群**（内含谜底与令牌）。

## 交互

1. 对局中点 **存档** → 浏览器下载 `.json`。
2. 主界面（新对局 / 联机）点 **加载存档** → 选文件。
3. 单机存档：立即恢复记录台。
4. 联机存档：
   - `POST /api/rooms/restore`：房间不在内存则写入；已在则沿用（不覆盖正在进行的对局）。
   - 弹出 **选择身份**：列出存档中的座位名称。
   - 选定后用该座位的 `token` 进入房间，并恢复该座位的标注。

## 实现要点

- `public/src/room.js`：`serializeRoom` / `hydrateRoom`（去掉 `listeners`，恢复时 `new Set()`）。
- `server.mjs`：`POST /api/rooms/restore`。
- `public/src/archive.js`：打包 / 解析存档；`online.js`：`restoreRoom`。
- `public/ui/app.js` + `panels.js`：存档按钮、文件选择、选座弹窗。

## 明确不做

- 不自动定时写盘、不引入数据库。
- 不做账号系统；身份只在存档文件里。
- 不在加载时静默覆盖服务器上**已存在且进行中**的同码房间。
