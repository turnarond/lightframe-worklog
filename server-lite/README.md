# server-lite · 同步码同步服务端

零 npm 依赖的 Node HTTP 服务，为「光影工作志」提供**可选**的多设备同步。默认不配置同步码时客户端完全离线，本服务不参与。

设计依据：`doc/03-设计/设计稿/2026-11-06-同步码多设备同步-设计.md`。

> **部署到内网 Windows 机器**：先用 `npm run pack:sync` 产出 `dist/lightframe-sync-server.zip`（自带 `node.exe`，目标机零前置）。目标机 SSH 可达时用 `npm run deploy:ssh -- -Target <IP>` 一键部署；否则手动拷贝 zip 运行 `install.ps1`。完整步骤见 `deploy/windows/README.md`（公钥配置 / 计划任务 / 防火墙 / 备份 / 卸载）。本文下方的 `systemd` 方案适用于 Linux ECS。

## 本地启动

```bash
# 仓库根目录
npm run sync:server
# 或
PORT=8080 DATA_DIR=./server-lite/data node server-lite/server.js
```

环境变量（全部可选）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8080` | 监听端口 |
| `DATA_DIR` | `server-lite/data` | 数据目录，每个同步码一个 JSON 文件 |
| `MAX_BODY` | `1048576` | 单请求体上限（字节） |

自检：

```bash
curl http://127.0.0.1:8080/api/health
# {"ok":true,"service":"lightframe-sync"}
```

测试：

```bash
npm test                              # 含服务端单测与双设备端到端联调
node --test server-lite/*.test.js     # 只跑服务端
```

## 接口

请求头统一 `Authorization: Bearer <同步码>`（16 位 Crockford Base32，分隔符与大小写不敏感）。服务端只保存 `sha256(码)` 派生的空间 ID，**不保存明文码**。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，无需同步码 |
| GET | `/api/sync/pull?since=<ms>&types=<type>` | 返回 `{changes, server_time}`；`since` 为上次拿到的 `server_time` |
| POST | `/api/sync/push` | body `{changes:[...]}` → `{applied, conflicts, server_time}` |

`types` 取值 `tasks` / `daily_logs` / `prefs`；记录主键分别为 `id` / `date` / `key`。冲突按记录自带的 `updatedAt`（毫秒）取大者；软删墓碑按普通记录保留。

**游标语义**：服务端为每次 push 打一个单调递增的 `_storedAt`（服务端逻辑时钟），pull 按 `_storedAt > since` 过滤，`server_time` 与它同域且单调。这样客户端时钟偏慢也不会漏拉。该内部字段不会出现在返回给客户端的 `changes` 里。

## 部署到 ECS

不装 Docker、不装数据库，`systemd` 直跑单进程（约 30MB 内存）。

`/etc/systemd/system/lightframe-sync.service`：

```ini
[Unit]
Description=Lightframe Sync Code Server
After=network.target

[Service]
Type=simple
User=lightframe
WorkingDirectory=/opt/lightframe
Environment=PORT=8080
Environment=DATA_DIR=/var/lib/lightframe-sync
ExecStart=/usr/bin/node /opt/lightframe/server-lite/server.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/lightframe-sync

[Install]
WantedBy=multi-user.target
```

```bash
sudo useradd -r -s /usr/sbin/nologin lightframe
sudo mkdir -p /var/lib/lightframe-sync && sudo chown lightframe: /var/lib/lightframe-sync
sudo systemctl daemon-reload
sudo systemctl enable --now lightframe-sync
sudo journalctl -u lightframe-sync -f
```

数据目录权限设为 `700`；日志文件只记录方法、状态、耗时和空间 ID 前 8 位，**不记录同步码或记录内容**。

备份（每日一次，保留 7 天）：

```bash
tar czf /backup/lightframe-$(date +%F).tar.gz -C /var/lib/lightframe-sync .
find /backup -name 'lightframe-*.tar.gz' -mtime +7 -delete
```

## HTTPS（尚未选定，部署前必须确定）

同步码等价于完整数据访问权，**不允许明文 HTTP 传输**。候选见设计稿 §9：

| 方案 | 成本 | 备注 |
|---|---|---|
| H1 免费域名（DuckDNS）+ Let's Encrypt DNS-01 + 非标端口 8443 | 0 | 需实测国内可达与证书续期 |
| H2 自签证书 + Electron 固定证书指纹 | 0 | 需改客户端，换证书要重发 |
| H3 自有域名 + Cloudflare Tunnel | 约 ¥10~60/年 | 最稳、隐藏源站 IP、不用备案 |

选定后再补反向代理 / 证书配置与客户端 `serverUrl` 示例。若仅在内网或本机联调，可暂用 `http://127.0.0.1:8080`。

## 客户端配置

1. 设置 → 多设备同步，填服务器地址（如 `https://sync.example.com`）。
2. 设备 A 点「生成新码」→「启用同步」，点「复制」保存同步码。
3. 设备 B 填同一地址、粘贴同一码 →「启用同步」。
4. 状态行显示「已同步 · HH:MM」或具体失败原因。

本地改动 5 秒防抖触发同步，另有启动补同步与 30 秒周期同步。

## 安全与限制

- **同步码丢失无法取回云端数据**；持有码者可读写该空间全部数据。请提示用户自行保存。
- 单空间记录上限 20000 条、单请求 1MB；损坏的 JSON 会被隔离为 `.json.bad` 并重建空空间，客户端下一轮 push 会用本地数据补齐。
- 同步码目前明文存于客户端 `userData/settings.json`（文件权限约束），后续可迁到 Electron `safeStorage`。
- 服务器 root 口令应尽快轮换，改用 SSH key 登录、禁用密码登录、防火墙只放行必要端口。**不要把凭据写进代码、仓库或日志**。
