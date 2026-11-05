// startupSettings —— 启动态规整（仅 CommonJS，主进程使用）
'use strict';

/**
 * 应用每次启动都应回到「普通可交互」形态，绝不恢复上次的鼠标穿透（壁纸）态。
 *
 * 背景：穿透态是 OS 级 setIgnoreMouseEvents(true)，会把整窗点击全部吞掉；
 * 若该状态被持久化并在启动时恢复，而穿透态的 mouseover 自救又未生效，
 * 用户会得到一个「哪里都点不动」的锁死窗口，且无托盘出口。
 * 因此穿透态只作为会话内的临时状态存在，不跨启动保留。
 *
 * 返回新对象，不修改入参；其它设置原样保留。
 */
function normalizeStartupSettings(settings) {
  var src = settings && typeof settings === 'object' ? settings : {};
  var widget = src.widget && typeof src.widget === 'object' ? src.widget : {};
  var next = {};
  Object.keys(src).forEach(function (key) { next[key] = src[key]; });
  var nextWidget = {};
  Object.keys(widget).forEach(function (key) { nextWidget[key] = widget[key]; });
  nextWidget.clickThrough = false;
  next.widget = nextWidget;
  return next;
}

module.exports = { normalizeStartupSettings: normalizeStartupSettings };
