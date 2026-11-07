// syncCode —— 同步码生成与规范化（UMD：渲染进程与 Node 服务端共用）
// 同步码同时充当身份与凭据：80 bit 熵，服务端只保存其 sha256 派生的空间 ID。
(function (root, factory) {
  const nodeCrypto = (typeof module !== 'undefined' && module.exports) ? require('node:crypto') : null;
  const api = factory(nodeCrypto);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SyncCode = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (nodeCrypto) {
  'use strict';

  // Crockford Base32：去掉 I / L / O / U，避免手抄误读
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const CODE_RE = /^[0-9A-HJKMNP-TV-Z]{16}$/;

  function randomBytes(n) {
    if (nodeCrypto) return nodeCrypto.randomBytes(n);
    const bytes = new Uint8Array(n);
    (globalThis.crypto || (typeof window !== 'undefined' && window.crypto)).getRandomValues(bytes);
    return bytes;
  }

  function generateSyncCode() {
    const bytes = randomBytes(16);
    let out = '';
    for (let i = 0; i < 16; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  }

  function normalizeSyncCode(raw) {
    return String(raw == null ? '' : raw)
      .toUpperCase()
      .replace(/[\s-]/g, '')
      .replace(/O/g, '0')
      .replace(/[IL]/g, '1');
  }

  function isValidSyncCode(raw) {
    return CODE_RE.test(normalizeSyncCode(raw));
  }

  function displaySyncCode(raw) {
    return normalizeSyncCode(raw).replace(/(.{4})(?=.)/g, '$1-');
  }

  return {
    generateSyncCode: generateSyncCode,
    normalizeSyncCode: normalizeSyncCode,
    isValidSyncCode: isValidSyncCode,
    displaySyncCode: displaySyncCode
  };
});
