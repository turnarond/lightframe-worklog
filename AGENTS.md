# 光影工作志 · 项目工程指令

本工程已接入工程手册（`.engineering-playbook.json`，画像 `web`）。写代码、准备发布或部署前，
先按 `engineering-playbook` 技能执行；本文件是本地采用副本，可按本工程实际调整。

## 一、项目定位

- 产品：常驻 Windows 桌面的半透明工作挂件（Electron），核心链路为「速记 → 分类 → 完成 → 日报 → 周报 → 复制」。
- 默认形态：**单机单用户、纯本地**；可选的「同步码多设备同步」由用户显式配置后才联网，不引入账号体系。
- 产品边界与需求以 `doc/01-蓝图/产品规格-光影工作志.md` 为准。

## 二、交互与文档

- 交流、提交信息、文档正文一律中文；专有名词与代码标识符保留原文。
- 文档唯一入口为 `doc/`，一级目录沿用采用方骨架：
  `00-总览 / 01-蓝图 / 02-需求分析 / 03-设计 / 04-测试 / 05-运维 / 06-参考 / 07-知识产权`，
  历史废弃文档入 `08-历史归档`。
- 文档与代码不一致视为缺陷：改功能必须同笔改文档，或在变更卡写明「无文档影响」。
- 根目录 `README.md` 仅保留用户使用入口；规格、计划、设计稿一律放 `doc/`。

## 三、版本与分支

- **版本三件套**：`package.json` 的 `version`、`VERSION`、`CHANGELOG.md` 头部必须同值；
  发布节点打附注 tag `vX.Y.Z`，tag 打在 `release/vX.Y.Z` 合入 `main` 的提交上。
- 分支模型：
  - `main`：只接受已验收的合入，不直接开发；
  - `release/vX.Y.Z`：版本收口与发版验证，合入后删除；
  - `feat/<主题>`、`fix/<主题>`、`docs/<主题>`：单一切片，寿命不超过 3 天。
- 提交信息格式：`<类型>(<范围>): <中文摘要>`；一个逻辑变更一个提交，不夹带无关改动。
- 推送、打 tag、GitHub Release 均需单独授权；未经授权只做本地提交。

## 四、质量门禁

| 门禁 | 命令 | 通过判据 |
|---|---|---|
| 单元/集成测试 | `npm test` | 全部通过，无失败用例 |
| 语法检查 | `for f in main.js preload.js src/*.js tools/*.js server-lite/*.js scripts/*.js; do node --check "$f" \|\| exit 1; done` | 每个文件退出码 0（`node --check` 多参数只校验首参，必须逐文件跑） |
| 局域网同步自测 | `node tools/verify-lan.js --self-host` | 输出全项通过 |
| 启动烟测 | `npm run smoke:boot` | 启动日志无 `[boot] 启动失败`，页面 ready |
| UI 烟测 | `npm run smoke` | 无 console.error，断言全 PASS（需完整安装 Electron） |
| 发布脚本测试 | `npm run test:release` | 全部通过，无失败用例 |
| 发布预检 | `node scripts/release.js --check` | 输出 `release preflight OK`，不构建、不联网、不执行远端操作 |
| 发布门 | `python scripts/release_gate.py <产物> --marker <标记> ...` | PASS，且旧产物不含标记 |
| 变更卡 | `python scripts/check_change_card.py <卡> --json` | ok=true，无占位符 |
| 评审证据 | `python scripts/check_review_evidence.py <证据> --json --require-second` | ok=true |
| CI | GitHub Actions `.github/workflows/ci.yml` | push/PR 的 Windows 门禁全绿 |

- 代码行为变更按风险选 `tdd:浅/中/深`；仅文档/版本元数据可选 `tdd:免` 并写明理由。
- 作者自审不算第二签；独立评审优先派独立会话，通道不可用时须在证据中标注「无独立评审席」。

## 五、当前本地约定与已知债务

- `server/`（Go + Postgres + JWT）为 v3.0 账号制方案的历史实现，**不部署、不进安装包**，仅作 LWW/接口语义参考。
- `server-lite/` 为当前同步服务端（零 npm 依赖，按同步码分空间）。
- 已知债务：`src/renderer.js`（约 1900 行）、`src/styles.css`（约 1600 行）、`main.js`（约 720 行）
  超过手册「单文件 > 600 行 = 腐朽」阈值，重构须单独立项、先提案后实施。
- CI 已接入：`.github/workflows/ci.yml` 在 push / PR 运行 Windows 门禁；本地命令仍可复跑。
- 分支保护尚未配置；建议在 GitHub 把 `Windows gates` 设为 required status check。
