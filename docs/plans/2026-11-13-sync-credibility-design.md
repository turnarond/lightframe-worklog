# 同步可信度增强 设计文档

- 日期：2026-11-13
- 状态：已实现（2026-11-13，提交后见 git log）
- 关联：`docs/plans/2026-11-06-sync-code-design.md`（同步码方案）

## 1. 目标与范围

**本轮回做（保持 LWW、不动服务端协议/存储）：**
- 同步状态可见：在线 / 离线 / 同步中 / 已同步·时间 / 失败
- 手动「立即同步」按钮
- 待推送条数（离线时最有用）
- 纯客户端冲突提示：「X 已被另一台设备更新」

**明确不做：**
- 不引入版本向量 / 变更基线，不做真冲突解决（无 merge UI，仍是 LWW 覆盖）
- 不改服务端 `server-lite` 的存储、路由或协议
- 不做每条任务的「已同步/仅本地」标记（本期范围外）

## 2. 现状（已确认）

- `src/sync.js`：`syncNow()` = `pull()` 后 `push()`；`pushCursor` 记录「已成功推到服务端」的边界，`updatedAt > pushCursor` 即未确认本地改动；引擎**无**状态回调、`lastSyncAt`、`pending` 计数、`in-flight` 标志。
- `src/syncBridge.js`：暴露 `markDirty / setAuth / seedIfFirstSync / syncNow / onOnline`；**无**状态外推。
- `main.js#runSync`：`net.isOnline()` 检查 → `syncBridge.syncNow()` → `sendToMain('sync:status', {ok})`；**离线时静默 return**（UI 一直停在旧状态）；无 `sync:now` 入口。
- `src/renderer.js`：`state.lastSyncAt / syncError` 已存在；`syncStatusText / renderSyncArea / updateSyncIndicator` 已渲染；现存 `sync:status` 订阅（经 `onSyncStatus`）。

## 3. 设计

### 3.1 状态模型与 IPC

扩展现有 `sync:status` 载荷（main → renderer）：

```js
{ state: 'configuring' | 'offline' | 'syncing' | 'synced' | 'error',
  error?: string,
  lastSyncAt?: number,   // 仅 synced 时带
  pending?: number }     // 仅 pending>0 或 offline 时关注
```

`main.runSync` 改为状态机：
1. 无 `syncCode/serverUrl` → 不发（UI 显示「未配置同步」）。
2. `!net.isOnline()` → `sendToMain('sync:status', {state:'offline'})` 并返回（**不再静默**）。
3. `sendToMain('sync:status', {state:'syncing'})`。
4. `await syncBridge.syncNow()`。
5. 成功 → `{state:'synced', lastSyncAt: Date.now()}`；失败 → `{state:'error', error}`。
6. 引擎 `onError` 回调 → `sendToMain('sync:status', {state:'error', error})`。

`lastSyncAt` 持久化到 `syncmeta.json`（`syncMetaStore`），重启后保留，避免「已启用，等待首次同步」反复出现。

### 3.2 手动同步按钮

- 新增 IPC `sync:now` → `syncBridge.syncNow()`。
- 设置页同步区加「立即同步」按钮，`state==='syncing'` 时 disabled。
- 点击：`apiCall('sync:now')` 触发同步（复用 `runSync` 的状态机，或直连 `syncBridge.syncNow()` 后发状态）。
- 本期最小实现：仅设置页按钮；挂件 `w-sync` 仅作状态指示（不改交互）。

### 3.3 待推送条数

- `SyncEngine` 加 `pendingCount()`：三类 `dirtyDiff(rows, pushCursor).length` 之和。
- `syncBridge` 透传；状态载荷带 `pending`。
- UI 在 `offline` 或 `pending>0` 时显示「待推送 N 条」。

### 3.4 冲突检测（纯客户端）

`SyncEngine` 加 `onConflict(cb)` 回调（构造 `opts.onConflict`，默认 noop）。`pull()` 改造：

- 进入每类循环时快照未确认本地改动：`const pre = dirtyDiff(local, meta[type].pushCursor)`。
- `merged = applyPull(local, remoteRows)` 后，对每个 `pre` 行按 `rowKey` 在 `merged` 中查找：
  - 不存在（被删/软删）→ 冲突（删除冲突）；
  - 存在但**关键字段**与 `pre` 不同（服务端较新覆盖）→ 冲突。
- 关键字段浅比较：任务 `title/details/priority/done/deletedAt`；日志 `progress`；偏好 `value`。避免无关字段（如 `updatedAt` 本身）触发误报。
- 发 `onConflict({type, key, title})`：`title` 取 `tasks.title || daily_logs.date || prefs.key`。

**去重与频率保护：**
- 覆盖后本地即变服务端版 → 下次 pull 前 `pre` 为空 → 不重复 emit。
- 同一 `key` 60s 内只提示一次（renderer 端 map 记 `lastToastAt`），避免 30s 轮询重复打扰。

**串联：** `syncBridge` 把 `onConflict` 传 engine → `main` 建桥时设 `onConflict` → `sendToMain('sync:conflict', info)` → renderer 监听 → `showToast('「'+title+'」已被另一台设备更新', 'warn')`。

### 3.5 测试

- **单元（node）**：`SyncEngine` 冲突检测（构造 fake `fetch`：B 离线改同任务、服务端已有另一设备更新、B `pull` 应 emit conflict）；`pendingCount` 正确；状态顺序 `syncing→synced` / `syncing→error` / `offline` 分支。
- **集成（verify-lan 风格）**：两个 engine 经真实 HTTP，A 改任务 → B 离线改同任务 → B 上线 `syncNow` → 断言 B 收到 conflict 回调且不重复。
- **烟测（electron）**：同步区渲染状态文字 + 按钮；点「立即同步」触发 `sync:now`；断网时显示离线。

## 4. 涉及文件

| 文件 | 改动 |
|---|---|
| `src/sync.js` | `onConflict`、`pendingCount`、`pull()` 快照+比对 |
| `src/syncBridge.js` | 透传 `onConflict`、`pendingCount` |
| `main.js` | `runSync` 状态机、`sync:now` handler、`lastSyncAt` 持久化、`onConflict→sendToMain` |
| `preload.js` | 暴露 `sync:now`；确认 `onSyncStatus` 载荷透传；新增冲突监听 |
| `src/renderer.js` | `renderSyncArea` 状态文案/按钮/待推送；监听 `sync:conflict` toast |
| `docs/plans/` | 本设计文档 |

## 5. 验收标准

1. 配置同步码后，状态显示 在线 / 离线 / 同步中 / 已同步·时间 / 失败。
2. 点「立即同步」立即触发，且同步中按钮禁用。
3. 离线时显示「待推送 N 条」，恢复网络后清零并同步。
4. 两台设备改同一任务：后拉取的一方弹「X 已被另一台设备更新」，不重复刷屏。
5. 单测 + 集成 + 烟测全绿；`npm test` 不回归。
