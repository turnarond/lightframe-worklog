// 打包版 UI 回归烟测：启动 dist/win-unpacked 程序，经 CDP 验证首屏渲染完整性。
// 用法：npm run dist && npm run smoke
// 不改动用户磁盘文件；通过应用自身 IPC 临时写入一条任务，结束后恢复。
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execSync } = require('node:child_process');

const PORT = Number(process.env.SMOKE_PORT || 9347);
const ROOT = path.join(__dirname, '..');
const EXE = process.env.SMOKE_EXE || path.join(ROOT, 'dist', 'win-unpacked', '光影工作志.exe');
// 独立 userData：既绕开与用户已安装实例的单实例锁，也不触碰真实任务/设置数据
const SMOKE_USER_DATA = path.join(os.tmpdir(), 'lw-smoke-ui-' + process.pid);
const nowDate = new Date();
const localToday = nowDate.getFullYear() + '-' +
  String(nowDate.getMonth() + 1).padStart(2, '0') + '-' +
  String(nowDate.getDate()).padStart(2, '0');
const TASK = {
  id: 'smoke-ui-task',
  title: 'UI 冒烟任务',
  category: '工作',
  priority: 'mid',
  dueDate: localToday,
  details: '',
  done: false,
  createdAt: new Date().toISOString(),
  completedAt: null,
  completedOn: null,
  updatedAt: Date.now(),
  deletedAt: null
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise((resolve, reject) => setTimeout(() => reject(new Error('超时: ' + label)), ms))
]);

async function connect() {
  let page = null;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const res = await fetch('http://127.0.0.1:' + PORT + '/json/list', { signal: AbortSignal.timeout(1500) });
      const list = await res.json();
      page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) break;
    } catch (e) { /* 端口未就绪 */ }
  }
  if (!page) throw new Error('CDP 页面未就绪（请先执行 npm run dist）');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await withTimeout(new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  }), 15000, 'WebSocket 打开');
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      consoleErrors.push(m.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      consoleErrors.push('异常: ' + m.params.exceptionDetails.text);
    }
  });
  const send = (method, params) => withTimeout(new Promise((resolve) => {
    id++;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
  }), 15000, 'CDP ' + method);
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression: expression, awaitPromise: true, returnByValue: true
    });
    if (r.error) throw new Error('CDP ' + (r.error.message || JSON.stringify(r.error)));
    if (r.result && r.result.exceptionDetails) {
      throw new Error(JSON.stringify(r.result.exceptionDetails));
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  return { ws: ws, send: send, ev: ev, consoleErrors: consoleErrors };
}

async function main() {
  fs.mkdirSync(SMOKE_USER_DATA, { recursive: true });
  const appLog = [];
  const child = spawn(EXE, [
    '--user-data-dir=' + SMOKE_USER_DATA,
    '--remote-debugging-port=' + PORT
  ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const collect = (prefix) => (d) => {
    String(d).split(/\r?\n/).filter(Boolean).forEach((line) => {
      appLog.push(prefix + line);
      if (appLog.length > 200) appLog.shift();
    });
  };
  child.stdout.on('data', collect('[app:out] '));
  child.stderr.on('data', collect('[app:err] '));
  const watchdog = setTimeout(function () {
    console.error('WATCHDOG 180s 未完成，应用日志：');
    console.error(appLog.slice(-80).join('\n'));
    try { execSync('taskkill /pid ' + child.pid + ' /t /f', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
    process.exit(3);
  }, 180000);
  let session = null;
  let origTasks = '[]';
  let origSettings = '{}';
  const results = {};

  try {
    console.log('STEP 等待 CDP');
    session = await connect();
    console.log('STEP CDP 已连接');
    const { send, ev, consoleErrors } = session;
    await send('Runtime.enable');
    await send('Page.enable');
    console.log('STEP CDP 域已启用');
    // 唯一文档标记：Page.reload 后旧文档同样有 cat-chips，必须等新文档落地再断言
    const docToken = 'smoke-' + process.pid + '-' + Date.now();
    // 每次文档加载前注入错误收集：unhandledrejection 不会被 Runtime.exceptionThrown 捕获
    await send('Page.addScriptToEvaluateOnNewDocument', {
      source: [
        'window.__smokeDocToken = ' + JSON.stringify(docToken) + ';',
        'window.__smokeErrors = [];',
        "window.addEventListener('error', function (e) { window.__smokeErrors.push('error: ' + e.message); });",
        "window.addEventListener('unhandledrejection', function (e) {",
        "  var r = e.reason; window.__smokeErrors.push('rejection: ' + (r && r.message ? r.message : String(r)));",
        '});'
      ].join('\n')
    });
    await sleep(1200);

    origTasks = await ev('window.api.loadTasks().then(function (t) { return JSON.stringify(t || []); })');
    origSettings = await ev('window.api.loadSettings().then(function (s) { return JSON.stringify(s || {}); })');
    console.log('STEP 原数据读取完成');
    await ev('window.api.saveTasks([' + JSON.stringify(TASK) + ']).then(function () { return true; })');
    console.log('STEP 任务写入完成');
    // 预置一个非默认字号，验证渲染端合并器不会在重启后把它丢掉
    await ev("(async function(){var s=await window.api.loadSettings();s.widget=s.widget||{};s.widget.scale=1.25;s.widget.expanded=false;await window.api.saveSettings(s);return true;})()");
    console.log('STEP 设置写入完成');
    await send('Page.reload', { ignoreCache: true });
    console.log('STEP reload 已发出');
    // 等新文档 init 落地：唯一 token + body.ready，二者缺一不可
    let docReady = false;
    for (let i = 0; i < 40; i++) {
      await sleep(250);
      docReady = await ev("document.readyState === 'complete' && window.__smokeDocToken === " +
        JSON.stringify(docToken) + " && document.body.classList.contains('ready')");
      if (docReady) break;
    }
    console.log('STEP 新文档就绪=' + docReady);
    if (!docReady) {
      console.log('诊断: 新文档未就绪', await ev("JSON.stringify({readyState:document.readyState,token:window.__smokeDocToken,bodyClass:document.body.className})"));
    }
    await sleep(200);

    console.log('诊断:', await ev("JSON.stringify({readyState:document.readyState, bodyClass:document.body.className, taskRows:document.querySelectorAll('#task-groups .task').length, chips:document.querySelectorAll('#cat-chips > *').length, initErr:document.querySelectorAll('.init-error').length, errs:window.__smokeErrors})"));

    results['init 执行完整（body.ready 已添加）'] =
      await ev("document.body.classList.contains('ready')");
    results['有任务时任务列表正常渲染'] =
      await ev("document.querySelectorAll('#task-groups .task').length >= 1");
    results['行内截止日触发器已挂载'] =
      await ev("document.querySelectorAll('#task-groups .task .date-trigger').length >= 1");
    results['首屏 reveal 内容可见（未停在 opacity:0）'] =
      await ev("(function(){var n=document.querySelector('.reveal');return !n || getComputedStyle(n).opacity==='1';})()");
    results['设置页已渲染（分类 chips 非空）'] =
      await ev("document.querySelectorAll('#cat-chips > *').length >= 1");
    results['Markdown 渲染在打包版可用'] =
      await ev("window.api.renderMarkdown('**粗体**').indexOf('<strong>') >= 0");
    results['无未捕获异常 / unhandledrejection'] =
      await ev('window.__smokeErrors.length === 0');
    const injected = await ev('window.__smokeErrors');
    if (Array.isArray(injected) && injected.length) console.log('页面异常:', injected.join(' | '));
    results['设置字段保留：字号缩放重启后不回退'] =
      await ev("document.getElementById('set-scale').value === '1.25'");
    results['手柄已移除日/周快捷按钮'] =
      await ev("!document.getElementById('w-daily') && !document.getElementById('w-weekly')");
    results['手柄无横向溢出'] =
      await ev("(function(){var h=document.getElementById('w-handle');return h.scrollWidth <= h.clientWidth + 1;})()");
    console.log('拖拽诊断:', await ev("(function(){var h=document.getElementById('w-handle');var r=h.getBoundingClientRect();var y=r.top+r.height/2;var g={};for(var x=r.left+1;x<r.right;x+=2){var el=document.elementFromPoint(x,y);var cs=el?getComputedStyle(el):null;var k=(el?(el.id||el.className||el.tagName):'null')+' | '+(cs?cs.getPropertyValue('-webkit-app-region'):'?')+' | '+(cs?cs.cursor:'?');g[k]=(g[k]||0)+1;}return JSON.stringify(g);})()"));
    results['手柄显示手形的区域均可拖动'] = await ev("(function(){var h=document.getElementById('w-handle');var r=h.getBoundingClientRect();var y=r.top+r.height/2;var bad=0,total=0;for(var x=r.left+2;x<r.right-2;x+=2){var el=document.elementFromPoint(x,y);if(!el)continue;var cs=getComputedStyle(el);if(cs.cursor==='grab'||cs.cursor==='grabbing'){total++;if(cs.getPropertyValue('-webkit-app-region')!=='drag')bad++;}}return total>0&&bad===0;})()");
    results['手柄可拖区域占比不低于 40%'] = await ev("(function(){var h=document.getElementById('w-handle');var r=h.getBoundingClientRect();var y=r.top+r.height/2;var drag=0,total=0;for(var x=r.left+2;x<r.right-2;x+=2){var el=document.elementFromPoint(x,y);if(!el)continue;total++;if(getComputedStyle(el).getPropertyValue('-webkit-app-region')==='drag')drag++;}return total>0&&drag/total>=0.4;})()");
    results['收起态速记条默认单行'] =
      await ev("getComputedStyle(document.querySelector('.qa-controls')).display === 'none'");
    await ev("document.getElementById('qa-title').focus(); true");
    results['聚焦速记框后控件展开'] =
      await ev("getComputedStyle(document.querySelector('.qa-controls')).display !== 'none'");
    results['收起态任务有显式编辑按钮'] =
      await ev("document.querySelectorAll('#w-tlist .w-task .w-edit').length >= 1");
    results['日历格有双击新建提示'] =
      await ev("(function(){var c=document.querySelector('.w-cell');return !!c && c.title.indexOf('双击')>=0;})()");
    results['壁纸穿透入口已移除'] =
      await ev("!document.getElementById('w-ct') && !document.body.classList.contains('ct-mode')");
    // 单一日期状态：收起态选另一天 → 筛选条同步出现；回到今天 → 同步清除
    await ev("(function(){var c=Array.from(document.querySelectorAll('#w-cal-grid .w-cell')).find(function(x){return !x.classList.contains('today');});if(c)c.click();return !!c;})()");
    await sleep(350);
    results['单一日期状态：选日后筛选条同步出现'] =
      await ev("!document.getElementById('filter-bar').hidden");
    await ev("document.getElementById('w-today').click(); true");
    await sleep(350);
    results['单一日期状态：回到今天同步清筛选'] =
      await ev("document.getElementById('filter-bar').hidden");
    await ev("window.api.openTab('daily').then(function () { return true; })");
    await sleep(800);
    results['托盘日报跳转自动展开并切 Tab'] =
      await ev("!document.getElementById('w-panel').hidden && document.getElementById('tab-daily').getAttribute('aria-selected') === 'true'");
    results['展开态今日任务列表仍可见'] =
      await ev("(function(){var t=document.getElementById('w-today');var b=document.getElementById('w-body');return !!t && getComputedStyle(b).display!=='none' && t.getBoundingClientRect().height>0;})()");
    await ev("document.querySelector('#task-groups .task .del').click(); true");
    await sleep(500);
    results['删除后提供撤销入口'] = await ev("!!document.querySelector('.toast-action')");
    results['撤销提示可被鼠标点击'] =
      await ev("(function(){var t=document.getElementById('toast');return t.classList.contains('actionable') && getComputedStyle(t).pointerEvents!=='none';})()");
    await ev("document.querySelector('.toast-action') && document.querySelector('.toast-action').click(); true");
    await sleep(700);
    results['撤销后任务恢复'] = await ev("document.querySelectorAll('#task-groups .task').length >= 1");
    await ev("window.api.openTab('weekly').then(function () { return true; })");
    await sleep(700);
    results['外部跳转周报自动展开并切换'] =
      await ev("!document.getElementById('w-panel').hidden && document.getElementById('tab-weekly').getAttribute('aria-selected') === 'true'");
    results['不再依赖 Google Fonts 外链'] =
      await ev("document.querySelectorAll('link[href*=\"fonts.googleapis.com\"], link[href*=\"fonts.gstatic.com\"]').length === 0");
    results['display 字体真正启用 Fraunces'] =
      await ev("getComputedStyle(document.documentElement).getPropertyValue('--display').indexOf('Fraunces') >= 0");
    results['自托管字体真实加载成功'] = await ev("(async function(){await document.fonts.ready;var f=Array.from(document.fonts).filter(function(x){return x.status==='loaded';}).map(function(x){return x.family.replace(/['\"]/g,'');});return f.indexOf('Karla')>=0 && f.indexOf('Fraunces')>=0;})()");
    results['根字号随缩放变化（14px * 1.25 = 17.5px）'] =
      await ev("getComputedStyle(document.documentElement).fontSize === '17.5px'");
    results['字号缩放覆盖卡片标题'] = await ev("(function(){var r=document.documentElement;var n=document.querySelector('.card-title');if(!n)return false;r.style.setProperty('--w-scale','1');var a=parseFloat(getComputedStyle(n).fontSize);r.style.setProperty('--w-scale','1.25');var b=parseFloat(getComputedStyle(n).fontSize);return b>a;})()");
    results['同步区输入框改为暖纸可见背景'] =
      await ev("(function(){var s=getComputedStyle(document.getElementById('sync-server'));return s.backgroundColor.indexOf('255, 255, 255, 0.14')<0;})()");
    results['账号体系 UI 已移除'] =
      await ev("!document.getElementById('acc-email') && !document.getElementById('acc-password') && !document.getElementById('acc-submit')");
    results['头部同步按钮已移除'] = await ev("!document.getElementById('w-sync')");
    results['备份区已渲染'] =
      await ev("!!document.getElementById('backup-list') && !!document.getElementById('backup-create')");
    results['备份创建与列出'] =
      await ev("(async function(){var r=await window.api.createBackup();if(!r||!r.ok)return false;var l=await window.api.listBackups();return !!(l&&l.ok&&l.items.length>=1);})()");
    results['损坏提示入口存在'] =
      await ev("!!document.getElementById('data-error') && !!document.getElementById('data-error-restore')");
    results['同步码区控件齐全'] =
      await ev("!!document.getElementById('sync-code') && !!document.getElementById('sync-apply') && !!document.getElementById('sync-generate') && !!document.getElementById('sync-clear')");
    results['同步码模块在渲染进程可用'] =
      await ev("(function(){var c=window.SyncCode.generateSyncCode();return window.SyncCode.isValidSyncCode(c) && window.SyncCode.displaySyncCode(c).length===19;})()");
    results['默认透明度归一为 0.9'] =
      await ev("(function(){var m=getComputedStyle(document.body).backgroundColor.match(/rgba?\\([^)]*?,\\s*([\\d.]+)\\)/);return !!m && Math.abs(parseFloat(m[1])-0.9)<0.01;})()");
    results['两窗口均有 CSP 声明'] =
      await ev("!!document.querySelector('meta[http-equiv=\"Content-Security-Policy\"]')");
    results['无 console.error'] = consoleErrors.length === 0;
    if (consoleErrors.length) console.log('控制台错误:', consoleErrors.join(' | '));
  } finally {
    clearTimeout(watchdog);
    if (appLog.length) {
      console.log('APP_LOG_BEGIN');
      console.log(appLog.slice(-80).join('\n'));
      console.log('APP_LOG_END');
    }
    if (session) {
      if (Object.keys(results).length) {
        try {
          await session.ev('window.api.saveTasks(' + origTasks + ').then(function () { return true; })');
          await session.ev('window.api.saveSettings(' + origSettings + ').then(function () { return true; })');
        } catch (e) { /* 页面可能已卸载 */ }
      }
      try { session.ws.close(); } catch (e) { /* 忽略 */ }
    }
    try { execSync('taskkill /pid ' + child.pid + ' /t /f', { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
    setTimeout(function () {
      try { fs.rmSync(SMOKE_USER_DATA, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    }, 600);
  }

  Object.keys(results).forEach((k) => console.log((results[k] ? 'PASS ' : 'FAIL ') + k));
  const ok = Object.keys(results).every((k) => results[k]);
  console.log(ok ? 'UI 烟测通过' : 'UI 烟测失败');
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
  console.error('UI 烟测异常:', e && e.message);
  process.exit(1);
});
