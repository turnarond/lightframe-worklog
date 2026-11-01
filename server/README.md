# worklog-server（v3.0 同步后端）

Golang + Postgres 后端，提供账号（注册/登录/刷新/找回密码）与增量同步（`/api/sync/pull|push`）。
客户端 Electron 保留本地 JSON store，以每记录 `updatedAt`（毫秒）做增量拉/推与「最后写入获胜」(LWW) 合并。

## 目录
```
server/
  main.go                 # 入口：读环境变量、建池、迁移、起 HTTP
  go.mod
  Dockerfile
  internal/
    db/      pgx 连接池 + 迁移执行（migrations/*.sql 内嵌）
    auth/    argon2 哈希 + JWT 纯函数
    mail/    Mailer 接口 + 开发桩（DevMailer）
    api/     HTTP 路由与处理器（账号 + 同步）
    testutil/ 测试用临时 Postgres（embedded-postgres 单例）
```

## 环境变量（main.go 读取）
| 变量 | 说明 | 默认 |
|------|------|------|
| `DATABASE_URL` | Postgres 连接串，如 `postgres://user:pass@host:5432/db?sslmode=require` | 必填 |
| `JWT_SECRET` | JWT 签名密钥（HS256） | `dev-secret-change-me` |
| `MAIL_MODE` | `dev`（仅打印） / `aliyun`（待实现） | `dev` |
| `PORT` | HTTP 监听端口 | `8080` |

## 本地运行
```bash
cd server
export DATABASE_URL="postgres://user:pass@localhost:5432/worklog?sslmode=disable"
export JWT_SECRET="please-change"
go run .
```

## 测试（无需外部 Postgres）
测试通过 `embedded-postgres` 自动拉起临时 Postgres 并执行迁移，零外部依赖：
```bash
go test ./...
```
> 提示：跨包测试请用 `go test -p 1 ./...`，避免多个测试进程并发解压同一份 PG 二进制缓存。

## 线协议（与 Electron 客户端一致）
统一 **camelCase**；时间戳为 **毫秒（BIGINT）**，与客户端 `updatedAt` 同尺度（避免 timestamptz 与 ms `since` 的类型冲突）。

### 账号
- `POST /api/auth/register` `{email,password}` → `201 {access_token,refresh_token,email}`
- `POST /api/auth/login` `{email,password}` → `200 {access_token,refresh_token,email}`
- `POST /api/auth/refresh` `{refresh_token}` → `200 {access_token}`
- `POST /api/auth/forgot` `{email}` → `200`（未知邮箱也 200，防枚举）
- `POST /api/auth/reset` `{token,password}` → `200`

### 同步（需 `Authorization: Bearer <access_token>`）
- `GET /api/sync/pull?since=<ms>&types=tasks|daily_logs|prefs`
  → `{server_time:<ms>, changes:[{type, id|key|date, updatedAt, deletedAt, ...其余字段}]}`
- `POST /api/sync/push` `{changes:[{type, id|key|date, updatedAt, deletedAt, ...}]}`
  → `{applied:[...], conflicts:[...]}`

LWW 规则：服务端仅在 `incoming.updatedAt > existing.updatedAt` 时覆盖（含软删 `deletedAt`），否则记为 conflict（不覆盖，避免旧版本回灌）。
任务/日志/偏好整行以 `jsonb` 存储，保证客户端任意字段不丢；挂件坐标/透明度等本机项不上云（仅客户端侧 `SYNCABLE_PREFS` 控制）。
