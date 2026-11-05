// apiWrite —— 写操作结果校验（UMD：Node 与浏览器共用）
// 与 apiCall 的区别：apiCall 失败时静默返回 fallback，调用方无法区分成功失败，
// 于是会出现「落盘失败却提示已保存」。写操作必须拿到明确的成功/失败。
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ApiWrite = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function createWriter(bridge, options) {
    var opts = options || {};
    return async function write(method) {
      var fn = bridge && bridge[method];
      if (typeof fn !== 'function') {
        if (opts.onError) opts.onError(method, new Error('接口不可用'));
        return false;
      }
      var args = Array.prototype.slice.call(arguments, 1);
      try {
        await fn.apply(bridge, args);
        return true;   // IPC 常无返回值，undefined 也算成功
      } catch (err) {
        if (opts.onError) opts.onError(method, err);
        return false;
      }
    };
  }

  return { createWriter: createWriter };
});
