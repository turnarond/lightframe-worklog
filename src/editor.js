/*
 * editor.js —— 任务详情编辑相关的纯函数（不依赖 DOM / Electron）
 * 供浏览器（src/renderer.js）与 Node 单测共用。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Editor = factory();
})(typeof self !== 'undefined' ? self : this, function () {

  // 在 textarea 中按下回车时计算新的文本与光标位置：
  // - 当前行若已是“空圆点（仅 · 与空白）”，再次回车则结束列表（删除该行圆点）
  // - 否则在光标处插入换行 + “· ”
  // - 首行（前面没有换行）直接插入 “· ”
  function autoBulletOnEnter(value, caret) {
    value = value == null ? '' : String(value);
    if (typeof caret !== 'number' || caret < 0 || caret > value.length) caret = value.length;
    var before = value.slice(0, caret);
    var lineStart = before.lastIndexOf('\n') + 1;
    var currentLine = value.slice(lineStart, caret);
    if (/^\s*·\s*$/.test(currentLine)) {
      var cut = lineStart > 0 ? lineStart - 1 : 0;
      var collapsed = value.slice(0, cut) + value.slice(caret);
      return { value: collapsed, caret: cut };
    }
    var prefix = before === '' ? '· ' : '\n· ';
    var next = before + prefix + value.slice(caret);
    return { value: next, caret: caret + prefix.length };
  }

  // 保存前清洗详情：去除行尾空白、删掉“仅含空圆点”的行、整体 trim
  function cleanDetails(text) {
    if (!text) return '';
    return text
      .split('\n')
      .map(function (l) { return l.replace(/\s+$/, ''); })
      .filter(function (l) { return !/^\s*·\s*$/.test(l); })
      .join('\n')
      .trim();
  }

  return { autoBulletOnEnter: autoBulletOnEnter, cleanDetails: cleanDetails };
});
