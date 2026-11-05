# 下一步规划（v2.6 / v2.7 / v3.0）

> 日期：2026-11-03
> 方式：brainstorming 逐条讨论「做不做、做到什么程度」，最后归纳版本。
> 范围：版本升级 / 数据存储导出 / 加链接 / 字体颜色 四块。

## 0. 背景与现状（事实核查）

- **存储**：Electron `userData` 目录下 4 个本地 JSON，经主进程 IPC 读写（`settings:load/save` 等），`fs.promises` 异步，无 DB、无导出/导入、无加密：
  - `tasks.json`（任务，已预留 `updatedAt`/`deletedAt` 软删，为 v3 同步准备）
  - `dailyLogs.json`（日报/周报）
  - `settings.json`（设置，含 widget 透明度/穿透/位置）
  - `syncmeta.json`（同步游标，v3 云同步专用）
- **版本**：已有 SemVer（`package.json` 版本号）+ `CHANGELOG.md` + 手工打包（portable 单文件 exe、NSIS 安装版）。
- **v3.0 云同步**：已在 `feat/v3.0-cloud` 分支有设计稿 `docs/plans/2026-11-01-cloud-sync-v3.md` 与半成品 `src/syncBridge.js`（含 `SYNCABLE_PREFS` 偏好子集同步框架）。

## 1. 决策记录（逐条）

### #1 版本管理 / 升级 → 只做自动更新
- 接入 `electron-updater` + GitHub Releases（或自建静态托管）。
- **NSIS 安装版**静默自更新；**portable 单文件版**只弹「有新版本，去下载」提示（无安装目录、无法自我替换）。
- 结论：**分发以 NSIS 安装版为主**，portable 退居「绿色版」定位。
- **决议（2026-11-04）**：正式采用 `electron-updater` + **公开 GitHub Releases**，仓库 `turnarond/lightframe-worklog`（`publish` 已配置）。`package.json` 的 `release` 脚本 = `electron-builder --win nsis --publish=always`，发版时 `GH_TOKEN=<token> npm run release` 一条出 Release（含 `latest.yml` / `.blockmap` / 安装包）。**代码签名暂缓**：更新/安装时仍弹 SmartScreen 警告，用户点「仍要运行」可过，与手动下载同体验；零警告留待后续评估付费证书。

### #2 数据存储 / 导出 → 暂不做导出 UI，只补原子写入
- 不做导出/导入界面（v3 云同步上线后天然成为备份；此前可由用户手动复制 `userData` 文件夹兜底）。
- `src/store.js` 改为**写临时文件再 `rename`** 的原子写入，防止写到一半崩溃/断电导致单文件损坏全丢。最低成本健壮性提升。

### #3 加链接 → 支持 Markdown 富文本（v2.7，已实现于 feat/v2.7-markdown）
- 任务与日志支持 Markdown 渲染：链接、加粗、列表、引用、行内/块代码。
- 渲染管线：`src/markdown.js`（`markdown-it` + `DOMPurify` **双层 XSS 防护**；`html:false` 禁原始 HTML 为第一道，DOMPurify 为第二道；链接强制 `target=_blank rel=noopener noreferrer`）。
- 经 preload `window.api.renderMarkdown` 暴露给渲染进程（contextIsolation 下安全；preload 桥接内以 try/catch 兜底，调用方拿到 `''` 即安全降级，**不拖垮 api 桥接**）。
- 存储：只存**原始 Markdown 源码**进现有 JSON，云同步（v3.0）零冲突。
- 编辑模型（已定，**预览切换**）：每个文本域「预览/编辑」切换——默认源码态，点「预览」就地渲染成手账样式；保存逻辑不变（读 `textarea.value`）；任务列表备注首行亦渲染。
- 视觉（frontend-design，活版印刷手账风）：衬线标题+细墨线、火漆色「–」列表记号、强调色下划线链接、加重墨色加粗、贴纸描边代码块、左侧火漆规引用；预览容器有高度上限可滚动。
- 测试：`src/markdown.test.js` 4 项覆盖第一层 XSS 收敛（script 转义 / 链接 target·rel / 加粗列表 / 空输入），全量 114 测试通过。**第二层（DOMPurify）单测暂以恒等 mock 覆盖，真实 DOM 集成测试待补（需 jsdom）**。
- 评审（requesting-code-review，2026-11-05）：无 Critical；1 Important（`renderMarkdown` 调用缺 try/catch，已修）+ 数项 Minor（预览高度上限、降级回退纯文本、纯空格占位、DRY 复用）均已修；jsdom 集成测试记为后续。

### #4 字体 / 颜色 → 仅字号 / 缩放
- 设置页新增字号/缩放项，存入 `settings`，解决桌面悬浮场景下的可读性。
- 不开放字体族与配色自定义（保持现状暖纸配色，避免主题系统膨胀）。

## 2. 版本规划

| 版本 | 包含 | 说明 |
|---|---|---|
| **v2.6 本地增强包** | #1 自动更新 + #2 原子写入 + #4 字号缩放 | 纯客户端、无后端依赖；自动更新落地后，后续版本可自动推送给用户 |
| **v2.7 Markdown 富文本** | #3 Markdown 渲染层（链接/加粗/列表/引用/代码块） | 独立的「内容渲染子系统」，建议统一设计，v3.0 展示层复用 |
| **v3.0 云同步** | 沿用 `feat/v3.0-cloud` 设计 | Markdown/字号属客户端展示，云只同步内容文本，无冲突 |

## 3. 待定 / 风险

- **发布渠道（已定）**：公开 GitHub Releases，仓库 `turnarond/lightframe-worklog`；发版经 `GH_TOKEN` + `npm run release` 自动建 Release 并上传 `latest.yml` / `.blockmap` / 安装包。
- **代码签名（暂缓）**：暂不付费签名；更新与安装均会弹 SmartScreen，用户点「仍要运行」可过。若后续要求零警告，再评估 OV/EV 证书接入 `electron-builder` 自动签名。
- **Markdown 选型与防护**：渲染库选型、`sanitize` 策略、是否支持编辑态预览。
- **升级顺序收益**：v2.6 先上自动更新，可使 v2.7 / v3.0 直接静默推达，降低用户手动重装成本。
- **数据迁移**：当前 JSON 直接读写，v3 schema 变更时仍需按 `settings.version` 驱动轻量迁移（本次未纳入范围，留待 v3.0 一并设计）。
