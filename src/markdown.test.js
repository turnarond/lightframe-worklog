'use strict';

const { test } = require('node:test');
const { makeMarkdownIt, render } = require('./markdown.js');

// 测试第一道防线（markdown-it 配置）：DOMPurify 在渲染进程经真实 DOM 二次净化，
// 这里用一个恒等“净化器”只验证 markdown-it 层的 XSS 收敛与渲染行为。
const purify = { sanitize: function (h) { return h; } };
const md = makeMarkdownIt();

test('禁用原始 HTML：<script> 被转义，不会原样输出', function () {
  const out = render('<script>alert(1)</script>', md, purify);
  if (out.includes('<script>')) throw new Error('原始 <script> 不应原样输出: ' + out);
  if (!out.includes('&lt;')) throw new Error('脚本应被转义: ' + out);
});

test('链接强制 target=_blank + rel=noopener', function () {
  const out = render('[link](https://example.com)', md, purify);
  if (!out.includes('target="_blank"')) throw new Error('缺少 target=_blank: ' + out);
  if (!out.includes('rel="noopener noreferrer"')) throw new Error('缺少 rel=noopener: ' + out);
});

test('加粗与列表正常渲染', function () {
  const out = render('**重点**\n\n- 一\n- 二', md, purify);
  if (!out.includes('<strong>重点</strong>')) throw new Error('加粗未渲染: ' + out);
  const li = (out.match(/<li>/g) || []).length;
  if (li !== 2) throw new Error('列表项数量应为 2，实际 ' + li);
});

test('空输入返回空串', function () {
  if (render('', md, purify) !== '') throw new Error('空串应返回空串');
  if (render(null, md, purify) !== '') throw new Error('null 应返回空串');
});
