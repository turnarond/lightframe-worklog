'use strict';

const { test } = require('node:test');
const { normalizeStartupSettings } = require('./startupSettings.js');

test('启动规整：持久化的 clickThrough:true 必须被强制为 false（默认普通可交互 app）', function () {
  const out = normalizeStartupSettings({ widget: { clickThrough: true, opacity: 0.9 } });
  if (out.widget.clickThrough !== false) throw new Error('启动不应进入穿透态');
  if (out.widget.opacity !== 0.9) throw new Error('应保留其它挂件设置');
});

test('启动规整：不修改入参', function () {
  const src = { widget: { clickThrough: true } };
  normalizeStartupSettings(src);
  if (src.widget.clickThrough !== true) throw new Error('不应原地修改入参');
});

test('启动规整：widget 缺失 / 非法输入也返回可交互设置', function () {
  const a = normalizeStartupSettings({ closeToTray: true });
  if (!a.widget || a.widget.clickThrough !== false) throw new Error('缺失 widget 时应补出可交互设置');
  const b = normalizeStartupSettings(null);
  if (!b.widget || b.widget.clickThrough !== false) throw new Error('null 输入应安全返回');
  if (a.closeToTray !== true) throw new Error('应保留顶层设置');
});

test('启动规整：clickThrough:false 保持不变', function () {
  const out = normalizeStartupSettings({ widget: { clickThrough: false, blur: 14 } });
  if (out.widget.clickThrough !== false || out.widget.blur !== 14) throw new Error('false 应原样保留');
});
