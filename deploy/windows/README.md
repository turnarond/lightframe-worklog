# 光影工作志 · 同步码服务端（Windows 离线部署包）

适用于把同步服务跑在**局域网内一台常开的 Windows 机器**上（例如 `192.168.31.32`）。服务端零 npm 依赖，只需 `node.exe`，不需要 Docker、数据库或公网服务器。

## 适用范围（先确认）

- **只在局域网内同步**：客户端填 `http://<内网IP>:8080`。手机用流量、外网电脑都连不上；需要外网访问请看下面「HTTPS 与外网」。
- 这台机器需要**常开且不休眠**（计划任务会在开机时自启，但睡眠期间不服务）。
- 默认走明文 HTTP。同步码等价于完整数据访问权，因此**不建议把 8080 映射到公网**，也不建议在不可信网络（公共 Wi-Fi）里用。

## 安装（3 步，全程不需要把口令交给任何人）

1. 把 `lightframe-sync-server.zip` 拷到目标机（SMB 共享 / 远程桌面 / U 盘均可），**完整解压**到一个固定目录，例如 `C:\lightframe-sync`。目录结构应如下：

   ```text
   C:\lightframe-sync\
     install.ps1
     uninstall.ps1
     README.md
     server-lite\server.js
     src\syncCode.js
   ```

2. 在目标机上以**管理员身份**打开 PowerShell，执行：

   ```powershell
   cd C:\lightframe-sync
   powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
   ```

   脚本会：检查/自动安装 Node.js LTS → 创建 `C:\ProgramData\lightframe-sync\data` 并收紧权限 → 生成 `start.cmd` → 放行入站 TCP 8080（仅 Private/Domain 网络）→ 注册计划任务 `LightframeSync`（SYSTEM 身份、开机自启、崩溃自动重启）→ 做一次健康检查。

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

## HTTPS 与外网（部署前必须决策）

同步码是完整数据访问凭据，明文 HTTP 只适合可信局域网。三种候选（设计稿 §9）：

| 方案 | 现金成本 | 说明 |
|---|---|---|
| H1 免费域名（DuckDNS）+ Let's Encrypt DNS-01 + 非标端口 | 0 | 需实测国内可达与证书续期 |
| H2 自签证书 + Electron 固定证书指纹 | 0 | 需改客户端，换证书要重发 |
| H3 自有域名（约 ¥10~60/年）+ Cloudflare Tunnel | 小额年费 | 最稳：隐藏源站、CF 代管证书、**不用公网 IP、不用映射端口、不用备案** |

若目标是「外出也能同步」，**H3 最合适**：在目标机跑 `cloudflared tunnel`，把 `http://127.0.0.1:8080` 映射成一个 HTTPS 域名，客户端 `serverUrl` 填该域名即可。这样也无需在路由器做端口映射。选定后再补具体配置。

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
