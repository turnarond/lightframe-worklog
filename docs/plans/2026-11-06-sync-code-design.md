# 同步码多设备同步 · 设计稿

> 日期：2026-11-06
> 状态：待评审
> 来源：brainstorming 两轮澄清（登录目的 → 后端承载）

## 1. 目标与非目标

**目标**：让同一个用户的几台设备共享任务 / 日报 / 偏好，服务端尽量轻、额外成本为 0。

**决策**：不引入用户账号体系。用一个随机「同步码」同时充当身份与凭据，服务端只按码派生的数据空间存取记录。

**非目标（YAGNI，明确不做）**：
- 邮箱 / 密码 / 注册 / 找回密码 / 邮件服务 / JWT 刷新
- 多用户权限、分享、协作、组织架构
- Web 管理后台、用户自助改码、审计日志
- 图片 / 附件同步、端到端加密（后续如需再议）

**已知取舍**：同步码丢失即无法取回该空间数据；持有码者可读该空间全部数据。UI 必须明确提示用户自行保存。

## 2. 现状与可复用资产

仓库已有 v3.0 云同步的真实实现（非骨架），本次不推翻同步内核：

| 资产 | 位置 | 复用方式 |
|---|---|---|
| LWW 合并 / 游标 / 脏行计算 | `src/sync.js:27-77` | 原样保留 |
| `SyncEngine`（pull → push、防抖、Bearer 头） | `src/sync.js:92-192` | 原样保留 |
| 本地 store 适配器 / prefs 子集 | `src/syncBridge.js` | 原样保留 |
| 软删墓碑 / `updatedAt` | `src/taskModel.js`、`src/store.js` | 原样保留 |
| 原子写（temp + rename） | `src/store.js` | 服务端沿用同一思路 |
| 账号 UI / `authClient.js` / 5 个 auth IPC | `index.html:257-291`、`src/renderer.js:1336-1418`、`main.js:457-508` | **移除并替换** |
| Go 后端 + Postgres + JWT | `server/` | **不部署**；仅参考其 LWW 与接口语义 |

现有 wire 协议（已核对源码，新服务端必须严格兼容）：

- `GET /api/sync/pull?since=<毫秒>&types=<tasks|daily_logs|prefs>`
  → `{ changes: [{ type, ...row }], server_time: <毫秒> }`
- `POST /api/sync/push`，body `{ changes: [{ type, ...row }] }`
  → `{ applied, conflicts, server_time: <毫秒> }`
- 请求头 `Authorization: Bearer <同步码>`
- 三类记录；`prefs` 为 `{key, value, updatedAt}` 行；其余为任务 / 日志行，含 `updatedAt` 与软删 `deletedAt`
- 客户端 `pull()` 用 `server_time` 推进 `lastPull`，`push()` 用 `server_time` 推进 `pushCursor`（`src/sync.js:168-172,187-188`）

**必须补的既有缺陷**：现有 Go 后端 push 响应缺 `server_time`（`server/internal/api/sync.go:89-92`），客户端会回退本地时钟；新服务端必须返回。此外 `src/sync.js:157,186` 对 `!res.ok` 静默 `continue`，需改为可上报错误，否则离线/失效时用户无感。

## 3. 架构

```
设备 A ─┐                          ┌─ data/<sha256(码)前32位>.json
        ├─ HTTPS + Bearer 同步码 ─→ │  Node 零依赖单进程
设备 B ─┘   GET pull / POST push   │  systemd 直跑，无 Docker / 无 DB
                                   └─ temp + rename 原子写
```

- 服务端无状态（不存会话），每个请求自带同步码；服务端仅持有码的哈希作为空间 ID。
- 客户端仍负责 LWW 合并与冲突判定；服务端只做「按 `updatedAt` 逐条 upsert + 按 `since` 返回变更」。
- 单进程串行化写请求，规避多设备并发写同一文件的竞态。

## 4. 同步码

- 生成：`crypto.randomBytes(10)` → Crockford Base32 → 16 字符，按 `XXXX-XXXX-XXXX-XXXX` 展示（80 bit 熵）。
- 校验：客户端去掉分隔符与大小写后须匹配 `^[0-9A-HJKMNP-TV-Z]{16}$`。
- 派生：`spaceId = sha256(normalizedCode).slice(0, 32)`，作为文件名。
- 语义：输入任意合法码即访问（必要时创建）对应空间，服务端**不校验码是否已注册**——码本身就是能力凭证，无需注册表。
- UI：提供「生成新空间」「加入已有空间」「复制码」「退出同步」；退出只清本地 `syncCode`，不动云端数据。
- 存储：`settings.syncCode` 与 `settings.serverUrl`。**当前为明文 JSON**，本期先用文件权限约束（`chmod 600`），后续可迁到 Electron `safeStorage` 加密（列入待办）。

## 5. 服务端（ECS 极简 Node 服务）

**选型**：Node 原生 `http` + `crypto` + `fs/promises`，零 npm 依赖，单文件 `server-lite/server.js`（目标 ≤ 250 行）。内存约 30MB，不装 Docker、不装数据库。

**存储**：每空间一个 JSON 文件，结构：

```json
{
  "version": 1,
  "records": {
    "tasks":       { "<id>":  { "type": "tasks", "updatedAt": 0 } },
    "daily_logs":  { "<key>": { "type": "daily_logs", "updatedAt": 0 } },
    "prefs":       { "<key>": { "type": "prefs", "updatedAt": 0 } }
  }
}
```

- 记录主键：`tasks` / `prefs` 用 `id` / `key`，`daily_logs` 用日期键；缺失主键的请求拒绝。
- 写盘：内存态 → 写 `<space>.json.tmp` → `rename` 覆盖；全局 Promise 队列串行化，避免并发覆盖。
- `pull`：`records[type]` 中 `updatedAt > since` 的行，附 `type` 后返回；`server_time = Date.now()`。
- `push`：逐条比较 `updatedAt`，仅当新值更大才覆盖（LWW），统计 `applied` / `conflicts`；返回 `server_time`。
- 软删墓碑按普通记录保存，不物理删除（与客户端 `deletedAt` 一致）。
- 启动自检：数据目录可写、损坏 JSON 隔离为 `.bad` 并新建空空间、记录告警日志。

**最小防护**：
- 请求体上限 1MB；单空间记录上限 20000 条；URL/方法白名单；非 `application/json` 拒绝。
- 同步码格式与长度校验后才计算哈希，拒绝路径穿越字符（哈希本身已消除该风险）。
- 单 IP 简易限流（如 120 次/分钟），防误配置被刷。
- 日志只记方法、状态、耗时、`spaceId` 前 8 位，**绝不记录同步码或记录内容**。

## 6. 客户端改动清单

| 文件 | 改动 |
|---|---|
| `index.html` | 账号区（`257-291`）替换为同步码区：码输入 / 生成 / 加入 / 复制 / 退出 / 状态行 / 服务器地址；删除邮箱、密码、确认密码、忘记密码、登录注册切换 |
| `src/renderer.js` | 删 `handleAuthSubmit` / `switchAccMode` / `handleForgot` / `handleLogout`；`renderAccountArea` → `renderSyncArea`；`updateSyncIndicator` 改为显示真实状态（未配置 / 同步中 / 成功时间 / 失败原因） |
| `src/authClient.js` | 删除（同步码无需登录握手，首次 `pull` 即验证连通） |
| `preload.js` | 删 5 个 auth 方法；新增 `syncSetCode(code, serverUrl)` / `syncClear()` |
| `main.js` | 删 5 个 auth handler；新增对应 handler 调 `syncBridge.setAuth()`；启动时由 `settings.syncCode` 恢复；补启动 `syncNow()`、30s 周期、`online` 监听 |
| `src/sync.js` | 保留；把 `!res.ok` 静默改为抛错/回调，供 UI 展示失败 |
| `src/store.js` | `DEFAULT_SETTINGS` 去掉 `account`，加 `syncCode: ''` 与 `serverUrl: ''` |
| `src/startupSettings.js` | 清理历史 `account` / `token` 字段（兼容旧 settings.json） |
| `src/styles.css` | 复用现有 `.set-block` / `.text-input` / `.btn-mini` 样式，新增同步码等宽展示与状态色 |
| `src/syncBridge.js` | 不改（`setAuth` 已是 `(baseUrl, token)` 形态） |

## 7. 数据流与时序

1. **首次配置**：用户生成或输入码 → 保存 `settings` → `syncSetCode` → `setAuth(baseUrl, code)` → `seedIfFirstSync()`（清游标 + `syncNow()`）。
2. **本地改动**：`tasks/logs/settings:save` → `markDirty` → 防抖 5s → `syncNow()` → pull → push。
3. **启动**：读 `settings.syncCode` → `setAuth` → 立即 `syncNow()`；此后 30s 周期 + `online` 事件触发。
4. **冲突**：同一记录两端都改 → 服务端按 `updatedAt` 取大者；客户端 pull 时 `applyPull` 再做一次本地 LWW。
5. **离线**：失败入队并展示「离线，待同步」；恢复在线或下次本地改动时重试，不丢本地数据。

## 8. 错误处理

- 网络失败 / 4xx / 5xx：不再静默；UI 显示最近一次失败原因与重试按钮。
- 码错误或服务端无该空间：`pull` 返回空 `changes` 属正常（新空间），不报错。
- 服务端文件损坏：隔离后重建空空间并告警，客户端下一轮 push 会用本地数据补齐。
- 时钟偏差：`lastPull` / `pushCursor` 一律以服务端 `server_time` 为准，不信任本地时钟。

## 9. HTTPS 与部署（待定，见 §14）

登录凭据虽已简化为同步码，但它等价于完整数据访问权，**不允许明文 HTTP 传输**。三个候选：

| 方案 | 现金成本 | 客户端改动 | 风险 |
|---|---|---|---|
| H1 免费域名（DuckDNS）+ Let's Encrypt DNS-01 + 非标端口 8443 | 0 | 无 | 依赖 duckdns.org 可达；certbot 续期需配好；阿里云国内 ECS 非标端口规避备案，需实测 |
| H2 自签证书 + Electron 校验证书指纹 | 0 | 需加 `certificate-error` 处理并内置指纹 | 换证书要重发客户端 |
| H3 自有域名（约 ¥10~60/年）+ Cloudflare Tunnel | 小额年费 | 无 | 最稳：隐藏源站 IP、CF 代管证书、不用备案 |

部署形态：`systemd` unit 直跑 `node server-lite/server.js`，环境变量仅 `PORT` / `DATA_DIR` / `MAX_BODY`；数据目录每日 `cp` 一份保留 7 天；防火墙只放行隧道/必要端口。

## 10. 迁移与兼容

- 现有本地任务 / 日志不动；首次配置同步码后按 LWW 与云端合并。
- 旧 `settings.account` / `token` / `serverUrl` 中的账号字段由 `startupSettings` 清理；`serverUrl` 复用为新服务地址。
- 现有 Go 后端 `server/` 保留在仓库作为参考，不删除、不部署、不进安装包。
- 文档口径修正：`README.md` / `CHANGELOG.md` 仍写「不做云同步」，需同步更新。

## 11. 测试策略

- **服务端单测**（Node，零依赖）：pull 增量过滤、push LWW（新/旧/并发）、软删墓碑、空间隔离、`server_time` 单调、码格式与路径校验、损坏文件恢复、请求体上限。
- **客户端单测**：码生成熵与格式、normalize、`mergeSettings` 保留 `syncCode`、失败上报。
- **端到端**：本地起服务，用两个临时 `userData` 的 Electron 实例（或 fake fetch 双客户端）验证「A 建码 → B 加入 → 双向改动 → 离线恢复 → 冲突取新」。
- **打包烟测** `npm run smoke`：新增同步码区 UI 存在、账号 UI 不存在、未配置时不发起请求。

## 12. 分阶段实施

1. 服务端 `server-lite/` + 单测 + 本地 `curl` 验收
2. 客户端改造 + 单测 + 烟测
3. 双实例端到端联调
4. HTTPS 方案落地 + 部署文档 + 备份脚本
5. 文档口径修正、bump 版本、打包

## 13. 成本

| 项 | 成本 |
|---|---|
| ECS（已有 47.92.110.53） | 0 增量 |
| 后端运行（Node 单进程 ~30MB、JSON 文件 < 1MB） | 0 增量 |
| 数据库 / 容器 / 第三方 BaaS | 0（均不使用） |
| HTTPS | 0（H1/H2）或约 ¥10~60/年（H3 域名） |

## 14. 待定项

1. **HTTPS 方案选 H1 / H2 / H3**（唯一阻塞部署的决策，不阻塞 1~3 阶段开发）。
2. 是否需要在 UI 提供「导出同步码到文件」（防丢失），还是仅显示 + 复制。
3. 同步码明文存 `settings.json` 是否本期就迁到 `safeStorage`（建议列入下一版）。
4. 单空间记录上限与保留策略（墓碑 GC）是否本期实现。

## 15. 安全提醒

- 用户曾在对话中明文提供 ECS root 口令，应尽快轮换；后续改用 SSH key、禁用 root 密码登录、防火墙只放行必要端口。
- 凭据不写入代码、仓库、日志或设计文档；部署时通过交互式输入或环境变量注入。
