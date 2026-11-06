// startupSettings —— 启动态规整（仅 CommonJS，主进程使用）
'use strict';

/**
 * 壁纸穿透态已移除。这里清理历史 settings.json 里残留的 clickThrough 字段，
 * 避免废弃状态长期留在用户数据里（旧版本曾持久化过 true）。
 *
 * 返回新对象，不修改入参；其它设置原样保留。
 */
function normalizeStartupSettings(settings) {
  var src = settings && typeof settings === 'object' ? settings : {};
  var widget = src.widget && typeof src.widget === 'object' ? src.widget : {};
  var next = {};
  Object.keys(src).forEach(function (key) { next[key] = src[key]; });
  var nextWidget = {};
  Object.keys(widget).forEach(function (key) {
    if (key === 'clickThrough') return;   // 历史废弃字段
    nextWidget[key] = widget[key];
  });
  next.widget = nextWidget;
  return next;
}

module.exports = { normalizeStartupSettings: normalizeStartupSettings };
