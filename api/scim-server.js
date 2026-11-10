// api/scim-server.js
// SCIM 2.0 server (RFC 7643 / 7644), tuned for Microsoft Entra ID provisioning (push).
// Route: /scim/{eid}/v2/{Users|Groups|ServiceProviderConfig|ResourceTypes|Schemas}[/{id}]
// Auth : Authorization: Bearer <token>  (token issued by /api/scim-admin action "create")
// Every request (accepted or rejected) is written to the endpoint's request log.

const crypto = require('crypto');
const store = require('./_lib/store');
const { readBody, origin } = require('./_lib/http');

const URN = {
  USER: 'urn:ietf:params:scim:schemas:core:2.0:User',
  GROUP: 'urn:ietf:params:scim:schemas:core:2.0:Group',
  ENT_USER: 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User',
  LIST: 'urn:ietf:params:scim:api:messages:2.0:ListResponse',
  ERROR: 'urn:ietf:params:scim:api:messages:2.0:Error',
  PATCH: 'urn:ietf:params:scim:api:messages:2.0:PatchOp',
  SPC: 'urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig',
  RT: 'urn:ietf:params:scim:schemas:core:2.0:ResourceType',
  SCHEMA: 'urn:ietf:params:scim:schemas:core:2.0:Schema'
};

const TYPES = {
  users: { store: 'users', rt: 'User', schema: URN.USER, required: 'userName', unique: true },
  groups: { store: 'groups', rt: 'Group', schema: URN.GROUP, required: 'displayName', unique: false }
};

// attributes that are multi-valued in SCIM core (arrays)
const MULTI = new Set(['emails', 'phonenumbers', 'ims', 'photos', 'addresses', 'groups', 'entitlements', 'roles', 'x509certificates', 'members']);
// Entra sends booleans as strings ("True"/"False") in some operations
const BOOL_KEYS = new Set(['active', 'primary']);
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Errors ──
class ScimError extends Error {
  constructor(status, scimType, detail) {
    super(detail);
    this.status = status;
    this.scimType = scimType;
  }
  get body() {
    const b = { schemas: [URN.ERROR], status: String(this.status) };
    if (this.scimType) b.scimType = this.scimType;
    b.detail = this.message;
    return b;
  }
}

// ── Small helpers ──
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function findKey(obj, name) {
  if (has(obj, name)) return name;
  const l = name.toLowerCase();
  return Object.keys(obj).find(k => k.toLowerCase() === l);
}

function safeSeg(seg) {
  if (BAD_KEYS.has(seg)) throw new ScimError(400, 'invalidPath', 'Illegal attribute name: ' + seg);
  return seg;
}

// "True"/"False" strings -> booleans for known boolean attributes (recursive)
function deepCoerce(v, keyName) {
  if (Array.isArray(v)) return v.map(x => deepCoerce(x));
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) { if (!BAD_KEYS.has(k)) o[k] = deepCoerce(x, k); }
    return o;
  }
  if (typeof v === 'string' && keyName && BOOL_KEYS.has(keyName.toLowerCase())) {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
  }
  return v;
}

function maskPasswords(v) {
  if (Array.isArray(v)) return v.map(maskPasswords);
  if (isObj(v)) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = k.toLowerCase() === 'password' ? '***' : maskPasswords(x);
    return o;
  }
  return v;
}

function maskAuth(v) {
  const m = /^(Bearer\s+)(.+)$/i.exec(String(v));
  if (!m) return '***';
  return m[1] + '***' + (m[2].length > 8 ? m[2].slice(-4) : '');
}

function logHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk === 'cookie' || lk === 'forwarded' || lk === 'x-real-ip' || lk.startsWith('x-vercel') || lk.startsWith('x-forwarded') || lk.startsWith('sec-')) continue;
    out[k] = lk === 'authorization' ? maskAuth(v) : v;
  }
  return out;
}

// ── Routing ──
function route(req) {
  const u = new URL(req.url, 'http://localhost');
  const m = /^\/scim\/([^/]+)\/v2(?:\/(.*))?$/.exec(u.pathname);
  let eid, path;
  if (m) { eid = m[1]; path = m[2] || ''; }
  else {
    const q = req.query || {};
    eid = String(q.eid || u.searchParams.get('eid') || '');
    path = String(q.path !== undefined ? q.path : (u.searchParams.get('path') || ''));
  }
  const segments = path.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
  const query = {};
  u.searchParams.forEach((v, k) => { if (k !== 'eid' && k !== 'path' && !has(query, k)) query[k] = v; });
  if (req.query) for (const [k, v] of Object.entries(req.query)) { if (k !== 'eid' && k !== 'path' && !has(query, k)) query[k] = String(v); }
  const qs = Object.keys(query).length ? '?' + new URLSearchParams(query).toString() : '';
  return { eid, segments, query, url: '/v2/' + segments.map(encodeURIComponent).join('/') + qs };
}

// ── Filter (subset of RFC 7644 §3.4.2.2: single expression) ──
const FILTER_RE = /^\s*([\w.:\-]+)\s+(eq|ne|co|sw|ew|gt|ge|lt|le)\s+(?:"((?:[^"\\]|\\.)*)"|(true|false|null|-?\d+(?:\.\d+)?))\s*$/i;
const PR_RE = /^\s*([\w.:\-]+)\s+pr\s*$/i;

function parseFilter(str) {
  let m = FILTER_RE.exec(str);
  let f;
  if (m) {
    f = { attr: m[1], op: m[2].toLowerCase(), quoted: m[3] !== undefined, value: m[3] !== undefined ? m[3].replace(/\\(.)/g, '$1') : m[4] };
  } else if ((m = PR_RE.exec(str))) {
    f = { attr: m[1], op: 'pr' };
  } else {
    throw new ScimError(400, 'invalidFilter', 'Unsupported filter (supported: attr op "value" with eq ne co sw ew gt ge lt le, or attr pr): ' + str);
  }
  if (/^urn:/i.test(f.attr)) f.attr = f.attr.slice(f.attr.lastIndexOf(':') + 1);
  f.attr.split('.').forEach(safeSeg);
  return f;
}

function attrValues(obj, path) {
  let cur = [obj];
  for (const part of path.split('.')) {
    const next = [];
    for (const c of cur) {
      if (!isObj(c)) continue;
      const k = findKey(c, part);
      if (k === undefined) continue;
      if (Array.isArray(c[k])) next.push(...c[k]); else next.push(c[k]);
    }
    cur = next;
  }
  return cur;
}

function compare(v, f) {
  if (f.value === 'null' && !f.quoted) return v === null || v === undefined;
  const a = String(v).toLowerCase();
  const b = String(f.value).toLowerCase();
  switch (f.op) {
    case 'eq': return a === b;
    case 'co': return a.includes(b);
    case 'sw': return a.startsWith(b);
    case 'ew': return a.endsWith(b);
    default: {
      const na = Number(v), nb = Number(f.value);
      const c = (!isNaN(na) && !isNaN(nb)) ? na - nb : a.localeCompare(b);
      return f.op === 'gt' ? c > 0 : f.op === 'ge' ? c >= 0 : f.op === 'lt' ? c < 0 : c <= 0;
    }
  }
}

function matches(item, f) {
  const vals = attrValues(item, f.attr);
  if (f.op === 'pr') return vals.some(v => v !== null && v !== undefined && v !== '');
  if (f.op === 'ne') return !vals.some(v => compare(v, { ...f, op: 'eq' }));
  return vals.some(v => compare(v, f));
}

// ── PATCH (RFC 7644 §3.5.2) ──
function splitUrn(path) {
  const lower = path.toLowerCase();
  for (const known of [URN.ENT_USER, URN.USER, URN.GROUP]) {
    if (lower === known.toLowerCase()) return { urn: known, attr: '' };
    if (lower.startsWith(known.toLowerCase() + ':')) return { urn: known, attr: path.slice(known.length + 1) };
  }
  const idx = path.lastIndexOf(':');
  return { urn: path.slice(0, idx), attr: path.slice(idx + 1) };
}

function sigOf(item) { return isObj(item) && item.value !== undefined ? String(item.value) : JSON.stringify(item); }

function applyPatch(resource, operations) {
  if (!Array.isArray(operations) || operations.length === 0) throw new ScimError(400, 'invalidSyntax', 'Operations array is required');
  for (const op of operations) {
    const name = String((op && op.op) || '').toLowerCase();
    if (!['add', 'replace', 'remove'].includes(name)) throw new ScimError(400, 'invalidSyntax', 'Unsupported op: ' + (op && op.op));
    if (op.path === undefined || op.path === null || op.path === '') {
      if (name === 'remove') throw new ScimError(400, 'noTarget', 'remove requires a path');
      if (!isObj(op.value)) throw new ScimError(400, 'invalidValue', 'value must be an object when path is omitted');
      for (const [k, v] of Object.entries(op.value)) applyOne(resource, name, String(k), v);
    } else {
      applyOne(resource, name, String(op.path), op.value);
    }
  }
}

function applyOne(resource, op, path, value) {
  if (/^urn:/i.test(path)) {
    const { urn, attr } = splitUrn(path);
    if (urn === URN.USER || urn === URN.GROUP) {
      if (!attr) {
        if (op === 'remove' || !isObj(value)) throw new ScimError(400, 'invalidValue', 'Cannot target the core schema as a whole');
        for (const [k, v] of Object.entries(value)) applyOne(resource, op, String(k), v);
        return;
      }
      return applyAttr(resource, op, attr, value);
    }
    // extension schema: stored as resource[urn] = {...}
    if (!attr) {
      if (op === 'remove') {
        delete resource[urn];
        if (Array.isArray(resource.schemas)) resource.schemas = resource.schemas.filter(s => s.toLowerCase() !== urn.toLowerCase());
        return;
      }
      if (!isObj(value)) throw new ScimError(400, 'invalidValue', 'Extension value must be an object');
      for (const [k, v] of Object.entries(value)) applyOne(resource, op, urn + ':' + k, v);
      return;
    }
    if (op !== 'remove') {
      if (!Array.isArray(resource.schemas)) resource.schemas = [];
      if (!resource.schemas.some(s => s.toLowerCase() === urn.toLowerCase())) resource.schemas.push(urn);
    }
    const key = safeSeg(findKey(resource, urn) || urn);
    if (!isObj(resource[key])) { if (op === 'remove') return; resource[key] = {}; }
    return applyAttr(resource[key], op, attr, value);
  }
  return applyAttr(resource, op, path, value);
}

function applyAttr(target, op, attrPath, value) {
  const fm = /^([^\[\].]+)\[(.+)\](?:\.([^\[\].]+))?$/.exec(attrPath);
  if (fm) return applyFiltered(target, op, safeSeg(fm[1]), fm[2], fm[3] ? safeSeg(fm[3]) : null, value);

  const parts = attrPath.split('.').map(safeSeg);
  let obj = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = findKey(obj, parts[i]) || parts[i];
    if (!isObj(obj[k])) { if (op === 'remove') return; obj[k] = {}; }
    obj = obj[k];
  }
  const leaf = parts[parts.length - 1];
  const k = findKey(obj, leaf) || leaf;
  const multi = MULTI.has(leaf.toLowerCase()) || Array.isArray(obj[k]);

  if (op === 'remove') {
    if (multi && Array.isArray(obj[k]) && value !== undefined) {
      // e.g. {"op":"remove","path":"members","value":[{"value":"<id>"}]}
      const drop = (Array.isArray(value) ? value : [value]).map(sigOf);
      obj[k] = obj[k].filter(item => !drop.includes(sigOf(item)));
    } else {
      delete obj[k];
    }
    return;
  }

  if (value === undefined) throw new ScimError(400, 'invalidValue', 'value is required for ' + op);
  value = deepCoerce(value, leaf);
  if (multi) {
    const incoming = Array.isArray(value) ? value : [value];
    if (op === 'replace') {
      obj[k] = incoming;
    } else {
      const cur = Array.isArray(obj[k]) ? obj[k] : [];
      for (const item of incoming) {
        const idx = cur.findIndex(c => sigOf(c) === sigOf(item));
        if (idx >= 0) cur[idx] = item; else cur.push(item);
      }
      obj[k] = cur;
    }
  } else {
    obj[k] = value;
  }
}

// path like emails[type eq "work"].value
function applyFiltered(target, op, attr, filterStr, sub, value) {
  const f = parseFilter(filterStr);
  const k = findKey(target, attr) || attr;
  const arr = Array.isArray(target[k]) ? target[k] : null;
  const idxs = [];
  if (arr) arr.forEach((it, i) => { if (matches(it, f)) idxs.push(i); });

  if (op === 'remove') {
    if (!arr) return;
    if (sub) idxs.forEach(i => { if (isObj(arr[i])) delete arr[i][sub]; });
    else target[k] = arr.filter((_, i) => !idxs.includes(i));
    return;
  }

  if (value === undefined) throw new ScimError(400, 'invalidValue', 'value is required for ' + op);
  value = deepCoerce(value, sub);
  if (idxs.length === 0) {
    // Lenient (Entra friendly): create the item from a simple "attr eq value" filter
    if (f.op !== 'eq' || f.attr.includes('.')) throw new ScimError(400, 'noTarget', 'No element matches the filter: ' + filterStr);
    const lit = f.quoted ? f.value : (f.value === 'true' ? true : f.value === 'false' ? false : f.value);
    const item = { [f.attr]: lit };
    if (sub) item[sub] = value; else if (isObj(value)) Object.assign(item, value);
    target[k] = (arr || []).concat([item]);
    return;
  }
  idxs.forEach(i => {
    if (sub) { if (isObj(arr[i])) arr[i][sub] = value; }
    else if (isObj(value) && isObj(arr[i])) Object.assign(arr[i], value);
    else arr[i] = value;
  });
}

// ── Static discovery documents ──
function discovery(kind, base) {
  const list = Resources => ({ schemas: [URN.LIST], totalResults: Resources.length, startIndex: 1, itemsPerPage: Resources.length, Resources });
  if (kind === 'serviceproviderconfig' || kind === 'serviceproviderconfigs') {
    return {
      schemas: [URN.SPC],
      documentationUri: 'https://datatracker.ietf.org/doc/html/rfc7644',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'OAuth Bearer Token', description: 'Authentication via the Authorization: Bearer header', primary: true }],
      meta: { resourceType: 'ServiceProviderConfig', location: base + '/ServiceProviderConfig' }
    };
  }
  if (kind === 'resourcetypes') {
    return list([
      { schemas: [URN.RT], id: 'User', name: 'User', endpoint: '/Users', schema: URN.USER, schemaExtensions: [{ schema: URN.ENT_USER, required: false }], meta: { resourceType: 'ResourceType', location: base + '/ResourceTypes/User' } },
      { schemas: [URN.RT], id: 'Group', name: 'Group', endpoint: '/Groups', schema: URN.GROUP, meta: { resourceType: 'ResourceType', location: base + '/ResourceTypes/Group' } }
    ]);
  }
  if (kind === 'schemas') {
    const attr = (name, type, extra = {}) => ({ name, type, multiValued: false, required: false, mutability: 'readWrite', ...extra });
    return list([
      { schemas: [URN.SCHEMA], id: URN.USER, name: 'User', description: 'User Account', attributes: [attr('userName', 'string', { required: true, uniqueness: 'server' }), attr('displayName', 'string'), attr('externalId', 'string'), attr('active', 'boolean'), attr('name', 'complex'), attr('emails', 'complex', { multiValued: true })], meta: { resourceType: 'Schema', location: base + '/Schemas/' + URN.USER } },
      { schemas: [URN.SCHEMA], id: URN.GROUP, name: 'Group', description: 'Group', attributes: [attr('displayName', 'string', { required: true }), attr('members', 'complex', { multiValued: true })], meta: { resourceType: 'Schema', location: base + '/Schemas/' + URN.GROUP } },
      { schemas: [URN.SCHEMA], id: URN.ENT_USER, name: 'EnterpriseUser', description: 'Enterprise User', attributes: [attr('employeeNumber', 'string'), attr('department', 'string'), attr('manager', 'complex')], meta: { resourceType: 'Schema', location: base + '/Schemas/' + URN.ENT_USER } }
    ]);
  }
  return null;
}

// ── Resource handlers ──
function excludeAttrs(resource, query) {
  const ex = String(query.excludedAttributes || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  if (!ex.length) return resource;
  const out = {};
  for (const [k, v] of Object.entries(resource)) { if (!ex.includes(k.toLowerCase()) || ['id', 'schemas', 'meta'].includes(k)) out[k] = v; }
  return out;
}

function newMeta(T, base, id, created, now) {
  return { resourceType: T.rt, created, lastModified: now, location: base + '/' + (T.rt === 'User' ? 'Users' : 'Groups') + '/' + id, version: 'W/"' + crypto.randomBytes(6).toString('hex') + '"' };
}

function validate(T, data) {
  if (typeof data[T.required] !== 'string' || !data[T.required].trim()) {
    throw new ScimError(400, 'invalidValue', T.required + ' is required');
  }
}

async function assertUnique(eid, T, value, exceptId) {
  if (!T.unique) return;
  const lower = String(value).toLowerCase();
  const items = await store.list(eid, T.store);
  if (items.some(i => i.id !== exceptId && String(i[T.required]).toLowerCase() === lower)) {
    throw new ScimError(409, 'uniqueness', T.required + ' "' + value + '" already exists');
  }
}

async function putChecked(eid, T, resource, isNew) {
  try { await store.put(eid, T.store, resource, { isNew }); }
  catch (e) { if (e.code === 'limit') throw new ScimError(507, 'tooMany', e.message); throw e; }
}

const ok = (status, body, headers) => ({ status, body, headers });

async function handleResource({ eid, T, method, id, query, body, base }) {
  const now = new Date().toISOString();

  if (!id) {
    if (method === 'GET') {
      let items = await store.list(eid, T.store);
      if (query.filter) { const f = parseFilter(query.filter); items = items.filter(i => matches(i, f)); }
      let start = parseInt(query.startIndex, 10); if (!(start >= 1)) start = 1;
      let count = parseInt(query.count, 10); if (!(count >= 0)) count = 100;
      count = Math.min(count, 200);
      const page = items.slice(start - 1, start - 1 + count).map(r => excludeAttrs(r, query));
      return ok(200, { schemas: [URN.LIST], totalResults: items.length, startIndex: start, itemsPerPage: page.length, Resources: page });
    }
    if (method === 'POST') {
      if (!isObj(body)) throw new ScimError(400, 'invalidSyntax', 'Request body must be a JSON object');
      const { id: _i, meta: _m, schemas, password: _p, ...rest } = deepCoerce(body);
      validate(T, rest);
      await assertUnique(eid, T, rest[T.required], null);
      const newId = crypto.randomUUID();
      const resource = { schemas: Array.isArray(schemas) && schemas.length ? schemas : [T.schema], id: newId, ...rest, meta: newMeta(T, base, newId, now, now) };
      await putChecked(eid, T, resource, true);
      return ok(201, resource, { Location: resource.meta.location });
    }
    throw new ScimError(405, null, 'Method not allowed on collection');
  }

  const existing = await store.get(eid, T.store, id);
  if (!existing) throw new ScimError(404, null, 'Resource ' + id + ' not found');

  switch (method) {
    case 'GET':
      return ok(200, excludeAttrs(existing, query));

    case 'PUT': {
      if (!isObj(body)) throw new ScimError(400, 'invalidSyntax', 'Request body must be a JSON object');
      const { id: _i, meta: _m, schemas, password: _p, ...rest } = deepCoerce(body);
      validate(T, rest);
      await assertUnique(eid, T, rest[T.required], id);
      const resource = { schemas: Array.isArray(schemas) && schemas.length ? schemas : [T.schema], id, ...rest, meta: newMeta(T, base, id, existing.meta.created, now) };
      await putChecked(eid, T, resource, false);
      return ok(200, resource);
    }

    case 'PATCH': {
      if (!isObj(body)) throw new ScimError(400, 'invalidSyntax', 'Request body must be a JSON object');
      const resource = JSON.parse(JSON.stringify(existing));
      applyPatch(resource, body.Operations || body.operations);
      resource.id = id;
      resource.meta = newMeta(T, base, id, existing.meta.created, now);
      validate(T, resource);
      await assertUnique(eid, T, resource[T.required], id);
      await putChecked(eid, T, resource, false);
      return ok(200, resource);
    }

    case 'DELETE':
      await store.del(eid, T.store, id);
      return ok(204, undefined);

    default:
      throw new ScimError(405, null, 'Method not allowed');
  }
}

async function dispatch({ eid, segments, method, query, body, base }) {
  const first = (segments[0] || '').toLowerCase();

  if (['serviceproviderconfig', 'serviceproviderconfigs', 'resourcetypes', 'schemas'].includes(first)) {
    if (method !== 'GET') throw new ScimError(405, null, 'Method not allowed');
    return ok(200, discovery(first, base));
  }
  if (first === 'users' || first === 'groups') {
    if (segments.length > 2) throw new ScimError(404, null, 'Unknown path');
    return handleResource({ eid, T: TYPES[first], method, id: segments[1], query, body, base });
  }
  throw new ScimError(404, null, 'Unknown SCIM path: /' + segments.join('/'));
}

// ── Response ──
function send(res, status, body, extraHeaders) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/scim+json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  if (body === undefined) { res.end(); return; }
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const started = Date.now();
  const { eid, segments, query, url } = route(req);

  if (!store.validEid(eid)) { send(res, 404, new ScimError(404, null, 'Unknown SCIM endpoint').body); return; }

  let cfg;
  try { cfg = await store.getCfg(eid); }
  catch (e) { send(res, 500, new ScimError(500, null, 'Storage error: ' + e.message).body); return; }
  if (!cfg) { send(res, 404, new ScimError(404, null, 'Unknown SCIM endpoint (expired or never created)').body); return; }

  let raw = '';
  let body = null;
  let result;
  try {
    raw = await readBody(req);
    const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || ''));
    if (!m || !store.checkToken(cfg, m[1].trim())) {
      throw Object.assign(new ScimError(401, null, 'Invalid or missing bearer token'), { headers: { 'WWW-Authenticate': 'Bearer' } });
    }
    if (raw.trim()) {
      try { body = JSON.parse(raw); }
      catch { throw new ScimError(400, 'invalidSyntax', 'Request body is not valid JSON'); }
    }
    result = await dispatch({ eid, segments, method: req.method, query, body, base: origin(req) + '/scim/' + eid + '/v2' });
  } catch (e) {
    result = e instanceof ScimError
      ? { status: e.status, body: e.body, headers: e.headers }
      : { status: 500, body: new ScimError(500, null, e.message).body };
  }

  try {
    await store.log(eid, {
      ts: new Date().toISOString(),
      method: req.method,
      url,
      headers: logHeaders(req.headers),
      body: body !== null ? maskPasswords(body) : (raw || null),
      status: result.status,
      responseBody: result.body === undefined ? null : result.body,
      ms: Date.now() - started
    });
  } catch { /* logging must never break provisioning */ }

  send(res, result.status, result.body, result.headers);
};
