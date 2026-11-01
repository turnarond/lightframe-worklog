// authClient.js —— 账号网络请求（纯逻辑，可注入 fetch 单测）
'use strict';

function emailValid(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

async function postJSON(serverUrl, path, body, fetchImpl) {
  const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!doFetch) throw new Error('当前环境不支持网络请求');
  const base = (serverUrl || '').replace(/\/$/, '');
  let res;
  try {
    res = await doFetch(base + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  } catch (err) {
    throw new Error('无法连接服务器，请检查服务器地址与网络');
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data: data || {} };
}

async function login(serverUrl, email, password, fetchImpl) {
  if (!emailValid(email)) throw new Error('邮箱格式不正确');
  if (!password) throw new Error('请输入密码');
  const r = await postJSON(serverUrl, '/api/auth/login', { email: email, password: password }, fetchImpl);
  if (!r.ok) throw new Error((r.data && r.data.error) || '登录失败');
  var token = r.data.token || r.data.access_token;
  if (!token) throw new Error('服务端未返回令牌');
  return { token: token, email: r.data.email || email };
}

async function register(serverUrl, email, password, fetchImpl) {
  if (!emailValid(email)) throw new Error('邮箱格式不正确');
  if (!password || password.length < 6) throw new Error('密码至少 6 位');
  const r = await postJSON(serverUrl, '/api/auth/register', { email: email, password: password }, fetchImpl);
  if (!r.ok) throw new Error((r.data && r.data.error) || '注册失败');
  var token = r.data.token || r.data.access_token;
  if (!token) throw new Error('服务端未返回令牌');
  return { token: token, email: r.data.email || email };
}

async function forgot(serverUrl, email, fetchImpl) {
  if (!emailValid(email)) throw new Error('邮箱格式不正确');
  const r = await postJSON(serverUrl, '/api/auth/forgot', { email: email }, fetchImpl);
  if (!r.ok) throw new Error((r.data && r.data.error) || '请求失败');
  return true;
}

module.exports = { emailValid: emailValid, postJSON: postJSON, login: login, register: register, forgot: forgot };
