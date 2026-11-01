// sync.js —— v3.0 云端同步引擎（纯函数 + 网络分离，可单测）
'use strict';

// 同步行统一用毫秒时间戳做 LWW；兼容历史 ISO 字符串
function toMs(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v) {
    const n = Date.parse(v);
    if (!Number.isNaN(n)) return n;
  }
  return 0;
}

// 行的唯一键：任务/日志用 id，偏好用 key
function rowKey(r) {
  if (!r) return null;
  return r.id != null ? String(r.id) : (r.key != null ? String(r.key) : null);
}

/**
 * 按记录级 LWW 合并一条本地与一条远程：取 updatedAt 较大者；
 * 相等时远程优先（保证多端收敛），远程可携带软删（deletedAt）。
 */
function mergeLWW(local, remote) {
  if (!local) return remote;
  if (!remote) return local;
  return toMs(remote.updatedAt) >= toMs(local.updatedAt) ? remote : local;
}

/**
 * 给定本地行集合与拉取到的远程行，返回合并后的本地行集合（数组）。
 * - 远程行 updatedAt >= 本地同键行时覆盖（含软删）；否则保留本地较新版本。
 */
function applyPull(localRows, remoteRows) {
  const map = new Map();
  (localRows || []).forEach(function (r) {
    const k = rowKey(r);
    if (k) map.set(k, r);
  });
  (remoteRows || []).forEach(function (r) {
    const k = rowKey(r);
    if (!k) return;
    const cur = map.get(k);
    if (!cur || toMs(r.updatedAt) >= toMs(cur.updatedAt)) {
      map.set(k, r);
    }
  });
  return Array.from(map.values());
}

/** 取本地 updatedAt 超过游标（pushCursor）的脏行 */
function dirtyDiff(rows, cursor) {
  const c = cursor || 0;
  return (rows || []).filter(function (r) {
    return toMs(r.updatedAt) > c;
  });
}

/** 本地行转线上变更体（附加 type 字段） */
function toWire(rows, type) {
  return (rows || []).map(function (r) {
    return Object.assign({ type: type }, r);
  });
}

/** 线上变更体剥离 type 字段还原为行 */
function fromWire(change) {
  if (!change || typeof change !== 'object' || Array.isArray(change)) return change;
  const out = {};
  Object.keys(change).forEach(function (k) {
    if (k !== 'type') out[k] = change[k];
  });
  return out;
}

const TYPES = ['tasks', 'daily_logs', 'prefs'];

/**
 * SyncEngine：持有 baseUrl / token / 本地存取适配器 / 网络实现。
 * 纯同步逻辑（mergeLWW/applyPull/dirtyDiff）可独立单测；网络仅在方法内发生。
 *
 * 适配器约定（注入，便于测试与解耦 renderer）：
 *   getLocal(type) -> Promise<Array>
 *   putLocal(type, rows) -> Promise<void>
 *   getMeta() -> Promise<{tasks,daily_logs,prefs:{lastPull,pushCursor}}>
 *   setMeta(meta) -> Promise<void>
 *   fetchImpl(method, url, body) -> Promise<{ok, status, json}>
 */
class SyncEngine {
  constructor(opts) {
    opts = opts || {};
    this.baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
    this.token = opts.token || null;
    this.getLocal = opts.getLocal;
    this.putLocal = opts.putLocal;
    this.getMeta = opts.getMeta;
    this.setMeta = opts.setMeta;
    // 默认使用浏览器/Node 原生 fetch；测试可注入假实现
    this.fetchImpl = opts.fetchImpl || function (method, url, body) {
      return fetch(url, {
        method: method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + (this.token || '')
        },
        body: body ? JSON.stringify(body) : undefined
      }).then(function (res) {
        return res.json().then(function (j) { return { ok: res.ok, status: res.status, json: j }; });
      });
    }.bind(this);
    this._timer = null;
    this._debounceMs = opts.debounceMs || 5000;
  }

  setToken(token) { this.token = token; }

  /**
   * 标记某类型有变更：本实现以「updatedAt > pushCursor」判定脏行，
   * 故 markDirty 仅触发防抖同步；也可手动调用 syncNow 立即同步。
   */
  markDirty(type, id) {
    if (TYPES.indexOf(type) < 0) return;
    this.schedule();
  }

  schedule() {
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => { this._timer = null; this.syncNow(); }, this._debounceMs);
  }

  onOnline() { return this.syncNow(); }

  async syncNow() {
    if (this._inFlight) return this._inFlight;
    this._inFlight = (async () => {
      try {
        await this.pull();
        await this.push();
      } finally {
        this._inFlight = null;
      }
    })();
    return this._inFlight;
  }

  async pull() {
    const meta = await this.getMeta();
    let serverTime = Date.now();
    for (const type of TYPES) {
      if (!meta[type]) meta[type] = { lastPull: 0, pushCursor: 0 };
      const since = meta[type].lastPull || 0;
      const res = await this.fetchImpl('GET',
        this.baseUrl + '/api/sync/pull?since=' + since + '&types=' + type, null);
      if (!res.ok) continue;
      const changes = (res.json && res.json.changes) || [];
      const remoteRows = changes.filter(c => c.type === type).map(fromWire);
      const local = await this.getLocal(type);
      const merged = applyPull(local, remoteRows);
      await this.putLocal(type, merged);
      let pulledMax = 0;
      remoteRows.forEach(function (r) {
        const u = toMs(r.updatedAt);
        if (u > pulledMax) pulledMax = u;
      });
      if (res.json && res.json.server_time) serverTime = toMs(res.json.server_time);
      // lastPull 用 server_time（下次拉取从该时刻之后）；pushCursor 只推进到「本次拉回行的最大 updatedAt」，
      // 避免本地时钟慢时在 pull→push 窗口内的编辑被误判为已同步而丢失
      meta[type].lastPull = serverTime;
      meta[type].pushCursor = Math.max(meta[type].pushCursor || 0, pulledMax);
    }
    await this.setMeta(meta);
  }

  async push() {
    const meta = await this.getMeta();
    let serverTime = Date.now();
    for (const type of TYPES) {
      const rows = await this.getLocal(type);
      const dirty = dirtyDiff(rows, meta[type].pushCursor || 0);
      if (!dirty.length) continue;
      const res = await this.fetchImpl('POST',
        this.baseUrl + '/api/sync/push', { changes: toWire(dirty, type) });
      if (!res.ok) continue;
      if (res.json && res.json.server_time) serverTime = toMs(res.json.server_time);
      meta[type].pushCursor = serverTime;
    }
    await this.setMeta(meta);
  }
}

module.exports = {
  toMs: toMs,
  rowKey: rowKey,
  mergeLWW: mergeLWW,
  applyPull: applyPull,
  dirtyDiff: dirtyDiff,
  toWire: toWire,
  fromWire: fromWire,
  TYPES: TYPES,
  SyncEngine: SyncEngine
};
