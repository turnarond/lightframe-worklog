'use strict';

const { test } = require('node:test');
const { showInitError } = require('./initError.js');

function makeDoc() {
  const body = {
    children: [],
    classes: [],
    classList: { add: function (c) { body.classes.push(c); } },
    appendChild: function (el) { body.children.push(el); }
  };
  return {
    body: body,
    createElement: function (tag) {
      return {
        tag: tag,
        attrs: {},
        textContent: '',
        setAttribute: function (k, v) { this.attrs[k] = v; }
      };
    }
  };
}

test('init 失败时追加可见错误提示，并保留已有界面', function () {
  const doc = makeDoc();
  doc.body.children.push({ existing: true });
  showInitError(doc, new Error(' dateInput is not defined '));
  if (doc.body.children.length !== 2) throw new Error('不应清空已有界面');
  const box = doc.body.children[1];
  if (box.attrs.role !== 'alert') throw new Error('提示应可被读屏播报');
  if (!box.textContent.includes('dateInput is not defined')) throw new Error('应包含原始错误信息');
});

test('init 失败时解除 reveal 隐藏，避免整屏空白', function () {
  const doc = makeDoc();
  showInitError(doc, new Error('boom'));
  if (doc.body.classes.indexOf('ready') < 0) throw new Error('应添加 ready');
});

test('无错误对象时仍给出可读提示', function () {
  const doc = makeDoc();
  const msg = showInitError(doc, null);
  if (!msg.includes('未知错误')) throw new Error('应兜底为未知错误: ' + msg);
  if (!doc.body.children[0].textContent.includes('重启')) throw new Error('应给出可操作建议');
});
