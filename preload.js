// preload —— 仅通过 contextBridge 暴露窄接口，不泄露 ipcRenderer
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// v2.7 Markdown 渲染：markdown-it 产 HTML，DOMPurify 在渲染进程经真实 DOM 二次净化防 XSS
let MarkdownLib = null, MarkdownIt = null, DOMPurify = null;
try {
  MarkdownLib = require('./src/markdown.js');
  MarkdownIt = MarkdownLib.makeMarkdownIt();
  DOMPurify = require('dompurify')(window);
} catch (e) {
  console.error('[preload] Markdown 渲染初始化失败，已降级：', e && e.message);
}

contextBridge.exposeInMainWorld('api', {
  // 数据
  loadTasks: function () { return ipcRenderer.invoke('tasks:load'); },
  saveTasks: function (tasks) { return ipcRenderer.invoke('tasks:save', tasks); },
  loadLogs: function () { return ipcRenderer.invoke('logs:load'); },
  saveLogs: function (logs) { return ipcRenderer.invoke('logs:save', logs); },
  loadSettings: function () { return ipcRenderer.invoke('settings:load'); },
  saveSettings: function (settings) { return ipcRenderer.invoke('settings:save', settings); },

  // 账号 / 同步（v3.0）
  authLogin: function (payload) { return ipcRenderer.invoke('auth:login', payload); },
  authRegister: function (payload) { return ipcRenderer.invoke('auth:register', payload); },
  authLogout: function () { return ipcRenderer.invoke('auth:logout'); },
  authStatus: function () { return ipcRenderer.invoke('auth:status'); },
  authForgot: function (payload) { return ipcRenderer.invoke('auth:forgot', payload); },

  // 应用动作
  copyText: function (text) { return ipcRenderer.invoke('app:copy', text); },
  quit: function () { return ipcRenderer.invoke('app:quit'); },
  hideWindow: function () { return ipcRenderer.invoke('window:hide'); },
  showWindow: function () { return ipcRenderer.invoke('window:show'); },
  openTab: function (tab) { return ipcRenderer.invoke('app:open-tab', tab); },
  setAlwaysOnTop: function (value) { return ipcRenderer.invoke('app:set-always-on-top', value); },
  setLaunchAtLogin: function (value) { return ipcRenderer.invoke('app:set-launch-at-login', value); },
  setHotkey: function (value) { return ipcRenderer.invoke('app:set-hotkey', value); },
  setWidgetExpanded: function (expanded) { return ipcRenderer.invoke('widget:setExpanded', expanded); },
  setClickThrough: function (flag) { return ipcRenderer.invoke('widget:setClickThrough', flag); },
  setHeight: function (h) { return ipcRenderer.invoke('widget:setHeight', h); },
  resetWidgetPosition: function () { return ipcRenderer.invoke('widget:resetPosition'); },
  notifyRefresh: function () { return ipcRenderer.invoke('app:refresh'); },
  getVersion: function () { return ipcRenderer.invoke('app:getVersion'); },
  checkUpdate: function () { return ipcRenderer.invoke('app:checkUpdate'); },
  onUpdate: function (cb) { ipcRenderer.on('app:update-status', function (_e, payload) { cb(payload); }); },

  // v2.7 Markdown 渲染（任务详情 / 日报 / 周报），输出已净化的安全 HTML
  renderMarkdown: function (src) {
    if (!MarkdownLib || !MarkdownIt || !DOMPurify) return '';
    try {
      return MarkdownLib.render(src, MarkdownIt, DOMPurify);
    } catch (e) {
      console.error('[preload] Markdown 渲染失败，已降级为空：', e && e.message);
      return '';
    }
  },

  // 主进程 -> 渲染进程
  onRefresh: function (cb) {
    if (typeof cb !== 'function') return function () {};
    const handler = function () { cb(); };
    ipcRenderer.on('refresh', handler);
    return function () { ipcRenderer.removeListener('refresh', handler); };
  },
  onOpenTab: function (cb) {
    if (typeof cb !== 'function') return function () {};
    const handler = function (_event, tab) { cb(tab); };
    ipcRenderer.on('open-tab', handler);
    return function () { ipcRenderer.removeListener('open-tab', handler); };
  }
});
