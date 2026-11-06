'use strict';

const { test } = require('node:test');
const { normalizeStartupSettings } = require('./startupSettings.js');

test('启动规整：清理历史 clickThrough 废弃字段', function () {
  const out = normalizeStartupSettings({ widget: { clickThrough: true, opacity: 0.9 } });
  if ('clickThrough' in out.widget) throw new Error('废弃字段应被移除');
  if (out.widget.opacity !== 0.9) throw new Error('应保留其它挂件设置');
});

test('启动规整：不修改入参', function () {
  const src = { widget: { clickThrough: true } };
  normalizeStartupSettings(src);
  if (src.widget.clickThrough !== true) throw new Error('不应原地修改入参');
});

test('启动规整：widget 缺失 / 非法输入也返回干净设置', function () {
  const a = normalizeStartupSettings({ closeToTray: true });
  if (!a.widget) throw new Error('缺失 widget 时应补出 widget');
  if ('clickThrough' in a.widget) throw new Error('不应凭空产生废弃字段');
  const b = normalizeStartupSettings(null);
  if (!b.widget) throw new Error('null 输入应安全返回');
  if (a.closeToTray !== true) throw new Error('应保留顶层设置');
});

test('启动规整：无历史字段时原样保留设置', function () {
  const out = normalizeStartupSettings({ widget: { blur: 14, expanded: true }, hotkey: 'Ctrl+Alt+K' });
  if (out.widget.blur !== 14 || out.widget.expanded !== true) throw new Error('挂件设置应保留');
  if (out.hotkey !== 'Ctrl+Alt+K') throw new Error('顶层设置应保留');
});
