# v3.0 云同步 · 验收矩阵

对照 `docs/plans/2026-11-01-cloud-sync-v3.md` §5 功能清单，逐项标注实现状态与验证方式。
后端测试用 `embedded-postgres` 拉起真实临时 PG（`go test -p 1 ./...`，全绿）；前端 `npm test`（110 全绿）。

## 一、账号 / 安全
| 功能（设计稿 §5 / §6） | 状态 | 验证 |
|---|---|---|
| 注册（邮箱+密码）→ 200 + access/refresh token | ✅ | `api_test.TestRegisterLogin`（重复注册 409） |
| 登录 → 200 + 双 token | ✅ | `TestRegisterLogin`（错误密码 401） |
| 刷新 token → 新 access_token | ✅ | `auth_handlers.handleRefresh` + 测试 |
| 找回密码（防枚举，始终 200） | ✅ | `TestForgotReset`（未知邮箱 200；已知邮箱可改密后登录） |
| 密码 argon2id 哈希 + 常量时间校验 | ✅ | `auth_test.TestHashVerify` |
| JWT HS256（uid+exp），错误密钥拒绝 | ✅ | `auth_test.TestJWT` |
| 鉴权中间件（Bearer → uid） | ✅ | `api` 受保护路由需 token，无 token 401 |

## 二、增量同步（LWW）
| 功能（§2 / §6） | 状态 | 验证 |
|---|---|---|
| pull（since + types，server_time 推进 lastPull） | ✅ | `TestPushPullLWW` 拉回可见 |
| push（脏行按 updatedAt>cursor 发送） | ✅ | `api/sync.go` + `sync.test.js` |
| 单条原子 upsert（消除并发丢 INSERT） | ✅ | `TestPushOverwriteNewer`；评审 I2 修复 |
| LWW：传入更新鲜则覆盖；更旧则记为 conflict | ✅ | `TestPushPullLWW`（旧版不回灌） |
| 软删传播（deletedAt 同步到云端，跨端隐藏） | ✅ | `TestSoftDeleteSync` + 客户端软删（评审 I1 修复） |
| 多用户数据隔离 | ✅ | `TestSyncIsolation`（B 看不到 A 的数据） |
| 偏好仅同步子集（categories/defaultPriority 等），本机项（坐标/透明度）不同步 | ✅ | `syncBridge.test.js` 子集 + 非污染断言 |
| 断网可用，恢复后自动补同步（debounce 调度） | ✅ | `syncBridge.markDirty` + 未登录不触发 |

## 三、客户端（Electron）
| 功能 | 状态 | 验证 |
|---|---|---|
| 本地 store 加 updatedAt(ms)/deletedAt 软删 + SyncMeta 游标 | ✅ | `store.test.js` / `taskModel.test.js` |
| 所有 mutation 接 SyncEngine（任务/日志/偏好） | ✅ | `syncBridge.test.js`（markDirty 委托 + 适配器往返） |
| 账号 UI（登录/注册/找回/登出/状态/服务器地址） | ✅ | `index.html` + `renderer.js` + `authClient.test.js` |
| 首次登录本地数据 seed 上云 | ✅ | `syncBridge.test.js` seed 测试 |
| 启动恢复鉴权（重启自动续传） | ✅ | `main.js` bootstrap setAuth |

## 四、部署
| 功能 | 状态 | 验证 |
|---|---|---|
| Dockerfile（golang:1.22-alpine 构建，ENTRYPOINT ./server） | ✅ | `server/Dockerfile` |
| 后端部署说明（环境变量 DATABASE_URL/JWT_SECRET/MAIL_MODE/PORT） | ✅ | `server/README.md` |
| 线协议对齐（camelCase / 毫秒时间戳） | ✅ | `api_test.go` 断言与客户端期望形状一致 |

## 五、已知限制（非阻塞）
- 阿里云邮件推送未实现（`MAIL_MODE=aliyun` 暂回落到 DevMailer 打印）。
- 软删墓碑长期驻留（本地持久化+云端逻辑删除），产品层未做墓碑 GC/压缩。
- 端到端仅验证到「HTTP 层 + 线协议契约」；真实 Electron ↔ 运行中的服务端联调需在你阿里云/本地起 Postgres 后手动跑一次。
