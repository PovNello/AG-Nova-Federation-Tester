// api/_lib/http.js
// Shared HTTP helpers for the User Sync endpoints.
// Folder starts with "_" so Vercel does NOT deploy it as a serverless function.

const https = require('https');
const http = require('http');

const MAX_BODY = 256 * 1024; // 256 KB

// Read the raw request body as a string (stream based, same approach as the other api/*.js files)
function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(new Error('Request body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Read body and parse it as JSON. Empty body -> null.
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return { raw, json: null };
  try { return { raw, json: JSON.parse(raw) }; }
  catch { throw new Error('Invalid JSON body'); }
}

// Generic outbound request. Resolves { status, headers, body } (body = string).
function request(urlStr, { method = 'GET', headers = {}, body = null, timeout = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const h = { ...headers };
    if (body !== null) h['Content-Length'] = Buffer.byteLength(body);
    const req = lib.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: h
    }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error('Request timed out after ' + timeout / 1000 + 's')));
    req.on('error', reject);
    if (body !== null) req.write(body);
    req.end();
  });
}

function postForm(urlStr, params) {
  const body = new URLSearchParams(params).toString();
  return request(urlStr, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
    body
  });
}

function tryParseJson(str) {
  try { return JSON.parse(str); } catch { return str; }
}

// Public origin of this deployment, e.g. https://my-app.vercel.app or http://localhost:3001
function origin(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  const proto = String(req.headers['x-forwarded-proto'] || (/^(localhost|127\.|\[::1\])/.test(host) ? 'http' : 'https')).split(',')[0].trim();
  return proto + '://' + host;
}

function cors(res, methods) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

module.exports = { readBody, readJson, request, postForm, tryParseJson, origin, cors };
