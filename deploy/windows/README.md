# 光影工作志 · 同步码服务端（Windows 离线部署包）

适用于把同步服务跑在**局域网内一台常开的 Windows 机器**上（例如 `192.168.31.32`）。服务端零 npm 依赖，只需 `node.exe`，不需要 Docker、数据库或公网服务器。

## 适用范围（先确认）

- **只在局域网内同步**：客户端填 `http://<内网IP>:8080`。手机用流量、外网电脑都连不上；需要外网访问请看下面「HTTPS 与外网」。
- 这台机器需要**常开且不休眠**（计划任务会在开机时自启，但睡眠期间不服务）。
- 默认走明文 HTTP。同步码等价于完整数据访问权，因此**不建议把 8080 映射到公网**，也不建议在不可信网络（公共 Wi-Fi）里用。

## 部署方式

| 方式 | 适用 | 说明 |
|---|---|---|
| **A · SSH 自动部署**（推荐） | 目标机 22 端口可达 | 开发机跑 `npm run pack:sync` + `npm run deploy:ssh -- -Target <IP>` 一条完成 |
| B · 手动拷贝安装 | 无远程通道 | 按下方「安装（3 步）」操作 |

### A · SSH 自动部署

**认证只用专用部署密钥，不使用口令。** OpenSSH 客户端无法非交互传密码，把口令拼进命令会留在 PowerShell 历史与进程命令行里，因此不走密码认证。

1. 开发机生成密钥（私钥在 `%USERPROFILE%\.ssh\lightframe_deploy_ed25519`，**不要提交到仓库**），读取公钥：

   ```powershell
   Get-Content "$env:USERPROFILE\.ssh\lightframe_deploy_ed25519.pub"
   ```

2. 在**目标机**用管理员 PowerShell 把公钥加入管理员授权文件。注意 Windows OpenSSH 对管理员账户读的是 `C:\ProgramData\ssh\administrators_authorized_keys`，**不是**用户目录下的 `.ssh\authorized_keys`：

   ```powershell
   $pub = '<粘贴公钥>'
   $dir = "$env:ProgramData\ssh"
   New-Item -ItemType Directory -Force -Path $dir | Out-Null
   $f = Join-Path $dir 'administrators_authorized_keys'
   Add-Content -Path $f -Value $pub
   icacls $f /inheritance:r /grant "SYSTEM:F" /grant "*S-1-5-32-544:F"
   Restart-Service sshd
   ```

   同时确认 `C:\ProgramData\ssh\sshd_config` 里 `PubkeyAuthentication yes`，且末尾 `Match Group administrators` 段的 `AuthorizedKeysFile` 指向 `__PROGRAMDATA__/ssh/administrators_authorized_keys`（默认如此）。

3. 回到开发机执行：

   ```powershell
   npm run pack:sync
   npm run deploy:ssh -- -Target 192.168.31.32
   ```

   脚本流程：SSH 认证探测（`BatchMode=yes`，绝不提示密码）→ `scp` 上传 zip → 远端解压并以管理员运行 `install.ps1` → 目标机本机 health 自检 → **从开发机跨机访问** `http://<IP>:8080/api/health` 验证防火墙确实放行。末尾输出客户端要填的 `serverUrl`。

   可选参数：`-User`、`-SshPort 22`、`-Port 8080`、`-Key <私钥路径>`、`-UploadOnly`（只传包不安装，便于分步排查）。

4. 部署完成后可删除 `administrators_authorized_keys` 里那一行撤销授权，私钥也可删除。以后要更新，重新放公钥再跑一次即可。

> 若远端报「SSH 会话未获得管理员令牌」，说明 OpenSSH 未给该会话提升权限；此时用 RDP 登录目标机，手动执行一次 `install.ps1` 即可（只需一次）。

### B · 手动拷贝安装（3 步，全程不需要把口令交给任何人）

1. 把 `lightframe-sync-server.zip` 拷到目标机（SMB 共享 / 远程桌面 / U 盘均可），**完整解压**到一个固定目录，例如 `C:\lightframe-sync`。目录结构应如下：

   ```text
   C:\lightframe-sync\
     install.ps1
     uninstall.ps1
     enable-tunnel.ps1
     disable-tunnel.ps1
     README.md
     server-lite\server.js
     src\syncCode.js
     runtime\node.exe          # 自带运行时，目标机无需安装 Node
     runtime\cloudflared.exe   # 外网访问用（执行过 fetch:cloudflared 才有）
   ```

2. 在目标机上以**管理员身份**打开 PowerShell，执行：

   ```powershell
   cd C:\lightframe-sync
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   脚本会：优先使用包内 `runtime\node.exe`（目标机**无需预装 Node**，也避免非交互调用 winget 失败）→ 创建 `C:\ProgramData\lightframe-sync\data` 并收紧权限 → 生成 `start.cmd` → 放行入站 TCP 8080 → 注册计划任务 `LightframeSync`（SYSTEM 身份、开机自启、崩溃自动重启）→ 做一次健康检查。
   防火墙规则**覆盖 Domain/Private/Public 全部网络位置**（不少 WLAN 机器默认是「公用」，只放行 Private/Domain 会导致「安装成功但别的设备连不上」），同时用 `-RemoteAddress LocalSubnet` 把来源限制在局域网，不会暴露到公网；规则幂等重建，重跑不会产生重复项。

3. 看到「安装完成」后，记下输出的 `客户端填 : http://192.168.31.32:8080`。

可选参数：

```powershell
# 换端口 / 换数据目录 / 不改防火墙（自己已有规则时）
.\install.ps1 -Port 8443 -DataDir "D:\sync-data" -SkipFirewall
```

## 客户端配置

1. 设置 → 多设备同步 → 服务器地址填 `http://192.168.31.32:8080`。
2. 设备 A 点「生成新码」→「启用同步」，再点「复制」**保存好同步码**。
3. 设备 B 填同一地址、粘贴同一码 →「启用同步」。
4. 状态行会显示「已同步 · HH:MM」或具体失败原因。本地改动 5 秒防抖同步，另有启动补同步与 30 秒周期同步。

**同步码丢失无法取回云端数据**；持有码者可读写该空间全部数据，请自行保管。

## 局域网端到端验证

`tools/verify-lan.js` 用两个独立 `SyncEngine`（模拟两台设备）通过**真实 HTTP** 验证：health、A→B 同步、LWW 冲突取新、旧版本不回退、不同同步码隔离、`daily_logs` / `prefs` 往返、无错误上报。每次生成全新同步码，不污染已有空间。

```powershell
# 未部署目标机时：本机自带临时服务端，经局域网网卡 IP（非 127.0.0.1）自测
npm run verify:lan -- --self-host

# 部署完成后：跨机验收目标机
npm run verify:lan -- http://192.168.31.32:8080
```

`npm run deploy:ssh` 默认会在部署末尾自动跑这一步并输出 `LAN_E2E_OK`；加 `-SkipVerify` 可跳过。本机自测已通过 9 项断言。

## 验证与排查

```powershell
# 健康检查
Invoke-RestMethod http://127.0.0.1:8080/api/health    # 应返回 ok = True

# 计划任务状态
Get-ScheduledTask -TaskName LightframeSync | Get-ScheduledTaskInfo

# 端口是否在听
netstat -ano | findstr :8080

# 手动前台跑一次（看实时日志，先停掉计划任务）
Stop-ScheduledTask -TaskName LightframeSync
cmd /c .\start.cmd
```

| 现象 | 处理 |
|---|---|
| 客户端一直「同步失败」 | 目标机防火墙是否放行；客户端与服务器是否同网段；`serverUrl` 末尾不要带 `/` |
| 健康检查失败 | 看 `Get-ScheduledTaskInfo` 的 `LastTaskResult`；确认 Node 路径与 `start.cmd` 内容 |
| 重启后不同步 | 计划任务触发器是否为 `AtStartup`；机器是否只是睡眠而非重启 |
| 数据异常 | 数据目录下损坏的 `.json` 会被隔离为 `.json.bad`，客户端下一轮 push 会用本地数据补齐 |

## 备份

数据就是 `C:\ProgramData\lightframe-sync\data` 里每个空间一个 JSON 文件。建议用「计划任务 + PowerShell」每日压缩一份、保留 7 天：

```powershell
$d = "$env:ProgramData\lightframe-sync\data"
$b = "D:\backup\lightframe-$(Get-Date -Format yyyy-MM-dd).zip"
Compress-Archive -Path "$d\*" -DestinationPath $b -Force
Get-ChildItem 'D:\backup\lightframe-*.zip' |
  Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-7) } | Remove-Item
```

## 外网访问（Cloudflare Tunnel，已内置）

部署包自带 `runtime/cloudflared.exe` 与 `enable-tunnel.ps1` / `disable-tunnel.ps1`。**不需要公网 IP、端口映射或备案**，同步流量走正规 HTTPS。

### 一键完成（SSH 部署时）

```powershell
npm run fetch:cloudflared   # 首次：下载约 53MB 二进制到 dist/tools/（不入库）
npm run pack:sync           # 打进部署包
npm run deploy:ssh -- -Target 192.168.31.32 -EnableTunnel
```

部署结束会回显 `外网「服务器地址」：https://xxx.trycloudflare.com`，客户端填它即可。

### 两种模式

| 模式 | 前置条件 | 域名 | 适用 |
|---|---|---|---|
| **Quick**（默认） | 无 | `https://xxx.trycloudflare.com`，**每次重启会变** | 验证 / 临时外网访问 |
| **Named** | 域名托管到 Cloudflare + 交互式 `cloudflared tunnel login` 一次 | `https://sync.example.com` 固定 | 长期多设备同步 |

**Quick**（零账号零域名）：

```powershell
cd C:\lightframe-sync
powershell -NoProfile -ExecutionPolicy Bypass -File .\enable-tunnel.ps1
```

脚本会先检查本机 8080 服务，再注册计划任务 `LightframeSyncTunnel`（开机自启、崩溃重启），从日志抓取临时域名，写入 `%ProgramData%\lightframe-sync\tunnel-url.txt`，并输出 `TUNNEL_URL=...`。

**Named**（稳定域名）：

```powershell
.\runtime\cloudflared.exe tunnel login   # 浏览器授权，选择已托管的域名
powershell -NoProfile -ExecutionPolicy Bypass -File .\enable-tunnel.ps1 -Mode Named -Hostname sync.example.com
```

脚本自动创建 tunnel、配置 DNS 路由、生成 `config.yml`（凭据复制到 `ProgramData` 供 SYSTEM 计划任务读取）并注册开机任务。客户端填 `https://sync.example.com`。

**关闭**：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\disable-tunnel.ps1
```

默认保留配置，加 `-RemoveConfig` 可删除。

> **Quick 的代价**：域名每次重启都变，客户端要重填。若确实要「外出长期同步」，请走 Named（需一个域名，约 ¥10~60/年）——这是唯一稳定方案。
> 目标机访问 Cloudflare 不通时，Quick 会在 60 秒后给出警告，日志留在 `%ProgramData%\lightframe-sync\tunnel\quick-tunnel.log` 供排查。
> 无论哪种模式，同步码仍等价于完整数据访问权，请自行保管。

## 卸载

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall.ps1
```

默认**保留**数据目录；确认已备份后可加 `-RemoveData` 删除。

## 安全提醒

- 部署包与脚本**不包含任何账号口令**，安装也不需要交互式输入凭据。不要把口令写进脚本、命令行或共享目录。
- 若这台机器同时开放了 445 / 3389，请务必使用强口令，并限制来源网段；弱口令 + 内网暴露是常见被入侵路径。
- 服务端日志只记录方法、路径、耗时与空间 ID 前 8 位，**不记录同步码或任务内容**。
- 同步码目前明文存于客户端 `userData/settings.json`（靠文件权限约束），后续可迁到 Electron `safeStorage`。
