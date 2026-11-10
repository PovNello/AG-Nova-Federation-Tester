// api/_lib/store.js
// Storage for the SCIM server (provisioned users/groups + request log).
//
//  * Upstash Redis over REST (global fetch, no npm dependency) when env vars are set.
//  * In-memory fallback (local dev / no Redis) with the same command interface.
//
// The Redis database may be SHARED with other projects, so this module is deliberately paranoid:
//  - every key starts with "agnft:scim:"  (anything else is rejected before it leaves the process)
//  - only a small allowlist of commands is ever sent (no KEYS / SCAN / FLUSH*)
//  - every key has a TTL (7 days, refreshed on write)
//
// Key schema (eid = 16 hex chars):
//   agnft:scim:{eid}:cfg     STRING  {"token":"...","createdAt":"..."}
//   agnft:scim:{eid}:users   HASH    id -> SCIM User JSON
//   agnft:scim:{eid}:groups  HASH    id -> SCIM Group JSON
//   agnft:scim:{eid}:log     LIST    newest first, capped at LOG_MAX

const crypto = require('crypto');

const PREFIX = 'agnft:scim:';
const KINDS = ['cfg', 'users', 'groups', 'log'];
const TTL = 7 * 24 * 3600;       // seconds
const MAX_PER_TYPE = 1000;       // users / groups per endpoint
const LOG_MAX = 200;             // log entries per endpoint
const LOG_ENTRY_MAX = 60000;     // chars per log entry
const ALLOWED = new Set(['GET', 'SET', 'HSET', 'HGET', 'HDEL', 'HLEN', 'HGETALL', 'LPUSH', 'LTRIM', 'LRANGE', 'EXPIRE', 'DEL']);

class StoreError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ── Backend selection ──
function redisCfg() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/+$/, ''), token } : null;
}

function backendName() { return redisCfg() ? 'redis' : 'memory'; }

// ── In-memory backend (mini Redis) ──
const mem = new Map(); // key -> { t, v, exp }

function memLive(key) {
  const e = mem.get(key);
  if (e && e.exp && e.exp <= Date.now()) { mem.delete(key); return null; }
  return e || null;
}

function memExec(cmd) {
  const [name, key, ...a] = cmd;
  switch (name) {
    case 'GET': { const e = memLive(key); return e ? e.v : null; }
    case 'SET': {
      const e = { t: 'string', v: String(a[0]), exp: null };
      if (a[1] && String(a[1]).toUpperCase() === 'EX') e.exp = Date.now() + Number(a[2]) * 1000;
      mem.set(key, e);
      return 'OK';
    }
    case 'HSET': {
      let e = memLive(key);
      if (!e) { e = { t: 'hash', v: new Map(), exp: null }; mem.set(key, e); }
      let added = 0;
      for (let i = 0; i < a.length; i += 2) { if (!e.v.has(String(a[i]))) added++; e.v.set(String(a[i]), String(a[i + 1])); }
      return added;
    }
    case 'HGET': { const e = memLive(key); return e && e.v.has(String(a[0])) ? e.v.get(String(a[0])) : null; }
    case 'HDEL': { const e = memLive(key); if (!e) return 0; let n = 0; a.forEach(f => { if (e.v.delete(String(f))) n++; }); return n; }
    case 'HLEN': { const e = memLive(key); return e ? e.v.size : 0; }
    case 'HGETALL': { const e = memLive(key); const out = []; if (e) e.v.forEach((v, k) => out.push(k, v)); return out; }
    case 'LPUSH': {
      let e = memLive(key);
      if (!e) { e = { t: 'list', v: [], exp: null }; mem.set(key, e); }
      a.forEach(v => e.v.unshift(String(v)));
      return e.v.length;
    }
    case 'LTRIM': { const e = memLive(key); if (e) e.v = e.v.slice(Number(a[0]), Number(a[1]) + 1); return 'OK'; }
    case 'LRANGE': {
      const e = memLive(key); if (!e) return [];
      const start = Number(a[0]); const stop = Number(a[1]);
      return e.v.slice(start, stop === -1 ? undefined : stop + 1);
    }
    case 'EXPIRE': { const e = memLive(key); if (!e) return 0; e.exp = Date.now() + Number(a[0]) * 1000; return 1; }
    case 'DEL': { let n = 0; [key, ...a].forEach(k => { if (mem.delete(k)) n++; }); return n; }
    default: throw new StoreError('Unsupported command ' + name);
  }
}

// ── Redis backend (Upstash REST pipeline) ──
async function redisRun(cfg, cmds) {
  const r = await fetch(cfg.url + '/pipeline', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + cfg.token, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmds)
  });
  if (!r.ok) throw new StoreError('Redis HTTP ' + r.status);
  const arr = await r.json();
  return arr.map(x => {
    if (x && x.error) throw new StoreError('Redis: ' + x.error);
    return x ? x.result : null;
  });
}

// Guard: only allowlisted commands, only keys inside our namespace
function assertSafe(cmds) {
  cmds.forEach(c => {
    if (!Array.isArray(c) || !ALLOWED.has(String(c[0]).toUpperCase())) throw new StoreError('Command not allowed');
    c[0] = String(c[0]).toUpperCase();
    const keys = c[0] === 'DEL' ? c.slice(1) : [c[1]];
    keys.forEach(k => {
      if (typeof k !== 'string' || !k.startsWith(PREFIX)) throw new StoreError('Key outside namespace');
    });
  });
}

async function run(cmds) {
  assertSafe(cmds);
  const cfg = redisCfg();
  return cfg ? redisRun(cfg, cmds) : cmds.map(memExec);
}

// ── Helpers ──
function validEid(eid) { return typeof eid === 'string' && /^[a-f0-9]{16}$/.test(eid); }

function key(eid, kind) {
  if (!validEid(eid) || !KINDS.includes(kind)) throw new StoreError('Bad key');
  return PREFIX + eid + ':' + kind;
}

function touchCmds(eid) {
  return KINDS.map(k => ['EXPIRE', key(eid, k), TTL]);
}

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function flatToValues(flat) {
  const out = [];
  if (Array.isArray(flat)) { for (let i = 1; i < flat.length; i += 2) out.push(JSON.parse(flat[i])); }
  else if (flat && typeof flat === 'object') { Object.values(flat).forEach(v => out.push(JSON.parse(v))); }
  return out;
}

// ── Public API ──
async function createEndpoint() {
  const eid = crypto.randomBytes(8).toString('hex');
  const token = crypto.randomBytes(24).toString('base64url');
  const cfg = { token, createdAt: new Date().toISOString() };
  await run([['SET', key(eid, 'cfg'), JSON.stringify(cfg), 'EX', TTL]]);
  return { eid, token };
}

async function getCfg(eid) {
  if (!validEid(eid)) return null;
  const [v] = await run([['GET', key(eid, 'cfg')]]);
  return v ? JSON.parse(v) : null;
}

function checkToken(cfg, token) {
  return !!cfg && typeof token === 'string' && token.length > 0 && safeEqual(cfg.token, token);
}

async function list(eid, type) {
  const [flat] = await run([['HGETALL', key(eid, type)]]);
  return flatToValues(flat).sort((a, b) => String(a.meta && a.meta.created).localeCompare(String(b.meta && b.meta.created)));
}

async function get(eid, type, id) {
  const [v] = await run([['HGET', key(eid, type), String(id)]]);
  return v ? JSON.parse(v) : null;
}

async function put(eid, type, obj, { isNew = false } = {}) {
  const k = key(eid, type);
  if (isNew) {
    const [n] = await run([['HLEN', k]]);
    if (n >= MAX_PER_TYPE) throw new StoreError('Limit of ' + MAX_PER_TYPE + ' ' + type + ' per endpoint reached', 'limit');
  }
  await run([['HSET', k, obj.id, JSON.stringify(obj)], ...touchCmds(eid)]);
  return obj;
}

async function del(eid, type, id) {
  const [n] = await run([['HDEL', key(eid, type), String(id)], ...touchCmds(eid)]);
  return n > 0;
}

async function log(eid, entry) {
  entry = { id: crypto.randomBytes(6).toString('hex'), ...entry };
  let s = JSON.stringify(entry);
  if (s.length > LOG_ENTRY_MAX) s = JSON.stringify({ ...entry, body: '[truncated: too large]', responseBody: '[truncated: too large]' });
  await run([['LPUSH', key(eid, 'log'), s], ['LTRIM', key(eid, 'log'), 0, LOG_MAX - 1], ...touchCmds(eid)]);
}

async function getLog(eid) {
  const [arr] = await run([['LRANGE', key(eid, 'log'), 0, -1]]);
  return (arr || []).map(s => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean);
}

// Clear provisioned data + log, keep the endpoint/token
async function reset(eid) {
  await run([['DEL', key(eid, 'users'), key(eid, 'groups'), key(eid, 'log')]]);
}

// Remove everything for this endpoint
async function destroy(eid) {
  await run([['DEL', ...KINDS.map(k => key(eid, k))]]);
}

module.exports = {
  StoreError, MAX_PER_TYPE, backendName, validEid,
  createEndpoint, getCfg, checkToken, list, get, put, del, log, getLog, reset, destroy
};
