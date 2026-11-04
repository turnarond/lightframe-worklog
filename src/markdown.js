'use strict';

const MarkdownIt = require('markdown-it');

// 创建 markdown-it 实例：禁用原始 HTML 是 XSS 第一道防线
function makeMarkdownIt() {
  const md = new MarkdownIt({
    html: false,        // 不允许原始 HTML，杜绝 <script>/<img onerror> 注入
    linkify: true,      // 裸链接自动识别
    breaks: true,       // 单换行即换行（贴合手账逐行书写习惯）
    typographer: true
  });
  // 链接强制新窗口 + noopener（防御 tabnabbing）
  md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
    const token = tokens[idx];
    token.attrSet('target', '_blank');
    token.attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, options);
  };
  return md;
}

// 渲染：markdown-it 产出 HTML 后，用 DOMPurify 二次净化（第二道防线）
function render(src, md, DOMPurify) {
  if (!src) return '';
  const html = md.render(String(src));
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

module.exports = { makeMarkdownIt, render };
