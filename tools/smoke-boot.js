// 启动回归烟测：真实启动 Electron，断言 bootstrap 无异常、页面 ready。
// 用法：npm run smoke:boot
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.SMOKE_BOOT_PORT || 9358);
const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-boot-smoke-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.writeFileSync(path.join(UD, 'settings.json'), JSON.stringify({
  categories: ['工作', '会议', '其他'],
  lastCategory: '工作',
  syncCode: '',
  serverUrl: '',
  launchAtLogin: false,
  alwaysOnTop: true,
  closeToTray: true,
  hotkey: 'Ctrl+Shift+Space',
  lastReminded: {},
  weeklyPlans: {},
  widget: { opacity: 0.9, blur: 14, expanded: false, rect: null, scale: 1 }
}, null, 2));
fs.writeFileSync(path.join(UD, 'tasks.json'), '[]');
fs.writeFileSync(path.join(UD, 'dailyLogs.json'), '{}');

let electronPath;
try {
  electronPath = require('electron');
} catch (e) {
  console.error('FAIL 未安装 Electron：' + e.message);
  process.exit(1);
}

async function main() {
  const child = spawn(electronPath, ['--remote-debugging-port=' + PORT, '--user-data-dir=' + UD, ROOT], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.stdout.on('data', (d) => { output += d.toString(); });
  child.stderr.on('data', (d) => { output += d.toString(); });

  let pageReady = false;
  let identityOk = false;
  for (let i = 0; i < 40; i++) {
    await sleep(400);
    try {
      const list = await (await fetch('http://127.0.0.1:' + PORT + '/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((res, rej) => {
          ws.addEventListener('open', res, { once: true });
          ws.addEventListener('error', rej, { once: true });
        });
        let id = 0;
        const pending = new Map();
        ws.addEventListener('message', (ev) => {
          let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
          if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
        });
        const ev = (expression) => new Promise((resolve) => {
          const my = ++id;
          pending.set(my, (m) => resolve(m.result && m.result.result ? m.result.result.value : undefined));
          ws.send(JSON.stringify({ id: my, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        for (let j = 0; j < 20; j++) {
          await sleep(300);
          if (await ev("document.readyState === 'complete' && document.body.classList.contains('ready')")) {
            pageReady = true;
            break;
          }
        }
        if (pageReady) {
          const identity = await ev("JSON.stringify({title:document.title,api:typeof window.api})");
          try { identityOk = JSON.parse(identity).title === '光影工作志' && JSON.parse(identity).api === 'object'; } catch (e) { identityOk = false; }
          if (!identityOk) console.error('调试端口页面身份不符：' + identity);
        }
        ws.close();
        break;
      }
    } catch (e) { /* 未就绪 */ }
  }

  // bootstrap 在 2s 后触发 runSync；等过该时点再判定
  await sleep(3500);
  try { spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' }); } catch (e) { /* 已退出 */ }
  await sleep(400);
  try { fs.rmSync(UD, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }

  const bootError = /\[boot\] 启动失败[^\r\n]*/.exec(output);
  const channelOk = /DevTools listening/.test(output);
  if (spawnError) console.error('Electron 启动失败：' + spawnError.message);
  if (bootError) console.error('捕获启动异常：' + bootError[0]);
  else if (output.split(/\r?\n/).filter(Boolean).length) {
    console.log('启动日志：' + output.split(/\r?\n/).filter(Boolean).slice(0, 5).join(' | '));
  }
  if (!channelOk) console.error('未捕获到启动输出通道（DevTools listening 缺失）');

  const ok = pageReady && identityOk && channelOk && !bootError && !spawnError;
  console.log(ok
    ? 'PASS 启动无 bootstrap 异常，页面 ready，输出通道有效'
    : 'FAIL 启动异常、页面未 ready 或输出通道失效');
  return ok;
}

main().then((ok) => process.exit(ok ? 0 : 1)).catch((e) => {
  console.error('启动烟测异常：' + (e && e.message));
  process.exit(1);
});
