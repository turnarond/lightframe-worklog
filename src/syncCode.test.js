'use strict';

const { test } = require('node:test');
const SC = require('./syncCode.js');

test('生成的同步码为 16 位 Crockford Base32', function () {
  for (let i = 0; i < 20; i++) {
    const code = SC.generateSyncCode();
    if (!SC.isValidSyncCode(code)) throw new Error('生成的码非法: ' + code);
    if (code.length !== 16) throw new Error('长度应为 16: ' + code);
  }
});

test('每次生成的码不同', function () {
  const a = SC.generateSyncCode();
  const b = SC.generateSyncCode();
  if (a === b) throw new Error('同步码不应重复');
});

test('normalize 去掉分隔符与空格并统一大写', function () {
  const expected = 'ABCDEFGHJKMNPQRS';
  ['abcd-efgh-jkmn-pqrs', 'ab cd ef gh jk mn pq rs', 'ABCD-EFGH-JKMN-PQRS'].forEach(function (raw) {
    if (SC.normalizeSyncCode(raw) !== expected) {
      throw new Error('规范化结果不对: ' + raw + ' → ' + SC.normalizeSyncCode(raw));
    }
  });
});

test('normalize 把易混淆的 O/I/L 映射为 0/1/1', function () {
  if (SC.normalizeSyncCode('OOOOIIIILLLL') !== '000011111111') {
    throw new Error('映射结果不对: ' + SC.normalizeSyncCode('OOOOIIIILLLL'));
  }
});

test('isValid 拒绝空、过短与非法字符', function () {
  ['', 'ABC', 'U'.repeat(16), '!'.repeat(16), null, undefined].forEach(function (bad) {
    if (SC.isValidSyncCode(bad)) throw new Error('应拒绝: ' + bad);
  });
  if (!SC.isValidSyncCode('ABCD-EFGH-JKMN-PQRS')) throw new Error('带分隔符的合法码应通过');
});

test('display 格式为 XXXX-XXXX-XXXX-XXXX', function () {
  const shown = SC.displaySyncCode('ABCDEFGHJKMNPQRS');
  if (shown !== 'ABCD-EFGH-JKMN-PQRS') throw new Error('展示格式不对: ' + shown);
});
