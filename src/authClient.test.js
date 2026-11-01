// authClient 单元测试：登录/注册/找回（注入假 fetch）
const test = require('node:test');
const assert = require('node:assert/strict');
const Auth = require('./authClient.js');

function okFetch(body) {
  return async function () {
    return { ok: true, status: 200, json: () => Promise.resolve(body) };
  };
}
function statusFetch(status, body) {
  return async function () {
    return { ok: status < 400, status: status, json: () => Promise.resolve(body) };
  };
}

test('emailValid: 基本格式', () => {
  assert.equal(Auth.emailValid('a@b.com'), true);
  assert.equal(Auth.emailValid('bad'), false);
  assert.equal(Auth.emailValid('a@b'), false);
});

test('login: 成功返回 token', async () => {
  const r = await Auth.login('https://s.example', 'me@x.com', 'pw', okFetch({ token: 'T1', email: 'me@x.com' }));
  assert.equal(r.token, 'T1');
  assert.equal(r.email, 'me@x.com');
});

test('login: 401 透传服务端错误信息', async () => {
  await assert.rejects(
    () => Auth.login('https://s.example', 'me@x.com', 'pw', statusFetch(401, { error: '邮箱或密码错误' })),
    /邮箱或密码错误/
  );
});

test('login: 邮箱格式非法抛错', async () => {
  await assert.rejects(() => Auth.login('https://s.example', 'bad', 'pw', okFetch({})), /邮箱格式/);
});

test('register: 密码过短抛错', async () => {
  await assert.rejects(() => Auth.register('https://s.example', 'me@x.com', '123', okFetch({ token: 'T' })), /至少 6 位/);
});

test('register: 成功', async () => {
  const r = await Auth.register('https://s.example', 'me@x.com', 'secret1', okFetch({ token: 'T2' }));
  assert.equal(r.token, 'T2');
});

test('forgot: 成功返回 true', async () => {
  const r = await Auth.forgot('https://s.example', 'me@x.com', okFetch({}));
  assert.equal(r, true);
});

test('postJSON: 连不上服务器时给出友好错误', async () => {
  const failing = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(() => Auth.login('https://s.example', 'me@x.com', 'pw', failing), /无法连接服务器/);
});
