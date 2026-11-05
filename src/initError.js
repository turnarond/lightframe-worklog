// initError —— 初始化异常兜底（UMD：Node 与浏览器共用）
// init() 是挂在 DOMContentLoaded 上的异步函数，若不捕获，异常只会成为
// unhandledrejection：界面停在静态骨架、reveal 内容永久透明，用户毫无线索。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.InitError = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function showInitError(doc, err) {
    var detail = err && err.message ? String(err.message).trim() : '未知错误';
    var msg = '界面初始化失败：' + detail + '。请重启应用；若持续出现请反馈此信息。';
    try {
      var box = doc.createElement('div');
      box.className = 'init-error';
      box.setAttribute('role', 'alert');
      box.textContent = msg;
      doc.body.appendChild(box);
      // 让 .reveal 元素解除 opacity:0，避免整块面板空白
      if (doc.body.classList && doc.body.classList.add) doc.body.classList.add('ready');
    } catch (e) { /* DOM 不可用时不再二次抛错 */ }
    return msg;
  }

  return { showInitError: showInitError };
});
