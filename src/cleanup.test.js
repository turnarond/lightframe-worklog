'use strict';

const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('默认分类只有一份共享数据源', function () {
  const cats = require('./defaultCategories.js');
  const store = require('./store.js');
  if (JSON.stringify(store.DEFAULT_SETTINGS.categories) !== JSON.stringify(cats)) {
    throw new Error('store 默认分类应来自共享常量');
  }
  if (/categories:\s*\[/.test(read('src/renderer.js'))) {
    throw new Error('渲染端不应再硬编码分类数组');
  }
  if (/let category = '[^']+'/.test(read('quick-add.html'))) {
    throw new Error('速记窗不应再硬编码兜底分类');
  }
});

test('死样式类已清理', function () {
  const css = read('src/styles.css');
  ['.date-mini', '.time-mini', '.readonly', '.app-head',
    '.ai-text[data-empty]', '.icon-btn[aria-pressed="true"]'].forEach(function (sel) {
    if (css.indexOf(sel) >= 0) throw new Error('残留死样式: ' + sel);
  });
});

test('toast.info 有样式定义', function () {
  if (read('src/styles.css').indexOf('.toast.info') < 0) throw new Error('应补 toast.info 样式');
});

test('过期自动更新占位文案已移除', function () {
  if (read('main.js').indexOf('v2.6 将启用') >= 0) throw new Error('过期占位文案仍在');
});

test('设计预览稿不再含穿透开关', function () {
  const p = 'design/widget-preview.html';
  if (!fs.existsSync(path.join(ROOT, p))) return;
  if (read(p).indexOf('clickthrough') >= 0) throw new Error('设计稿仍有穿透开关');
});

test('账号体系已移除、同步码区就位', function () {
  const html = read('index.html');
  if (html.indexOf('acc-email') >= 0 || html.indexOf('acc-password') >= 0) {
    throw new Error('账号 UI 仍在');
  }
  if (html.indexOf('id="sync-code"') < 0) throw new Error('同步码区缺失');
  if (fs.existsSync(path.join(ROOT, 'src/authClient.js'))) throw new Error('authClient 应删除');
  if (!fs.existsSync(path.join(ROOT, 'server-lite/server.js'))) throw new Error('极简服务端缺失');
});

test('Windows 离线部署包脚本带 UTF-8 BOM（PowerShell 5.1 兼容）', function () {
  ['deploy/windows/install.ps1', 'deploy/windows/uninstall.ps1',
    'tools/pack-sync-server.ps1', 'tools/deploy-ssh.ps1'].forEach(function (p) {
    const full = path.join(ROOT, p);
    if (!fs.existsSync(full)) throw new Error('部署包文件缺失: ' + p);
    const buf = fs.readFileSync(full);
    if (!(buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF)) {
      throw new Error(p + ' 缺少 UTF-8 BOM，Windows PowerShell 5.1 会误解码中文导致语法错乱');
    }
  });
  if (!fs.existsSync(path.join(ROOT, 'deploy/windows/README.md'))) {
    throw new Error('部署包缺少中文说明');
  }
});

test('规划文档已同步当前形态', function () {
  const doc = read('docs/plans/2026-11-03-next-steps-design.md');
  if (doc.indexOf('含 widget 透明度/穿透/位置') >= 0) throw new Error('文档仍把穿透写成在售设置');
  if (doc.indexOf('实施记录') < 0) throw new Error('文档缺少实施记录章节');
  if (doc.indexOf('单一日期状态') < 0) throw new Error('文档缺少双日期合并记录');
});
