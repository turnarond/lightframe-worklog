// defaultCategories —— 首次启动的默认分类（UMD：主进程与两个渲染窗口共用）
// 单一数据源，避免 store / renderer / quick-add 三处硬编码漂移。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.DefaultCategories = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  return ['工作', '会议', '其他'];
});
