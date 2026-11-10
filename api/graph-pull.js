// api/graph-pull.js
// Microsoft Graph "pull" helper (users only).
//   action "token": client-credentials token for https://graph.microsoft.com/.default
//   action "query": GET a Graph /users URL with the bearer token (strict allowlist, not an open proxy)
// Both return the exact request sent (secrets masked) + the response, like the other api/*.js proxies.

const { readJson, request, postForm, tryParseJson, cors } = require('./_lib/http');

const KEEP_HEADERS = ['content-type', 'date', 'request-id', 'client-request-id', 'x-ms-ags-diagnostic', 'retry-after'];

function maskToken(t) {
  t = String(t || '');
  return t.length > 24 ? t.slice(0, 12) + '...' + t.slice(-6) : '***';
}

// Only https://graph.microsoft.com/{v1.0|beta}/users (query string allowed)
function validateGraphUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { return 'Invalid URL'; }
  if (u.protocol !== 'https:') return 'Only https is allowed';
  if (u.hostname !== 'graph.microsoft.com' || u.port) return 'Only graph.microsoft.com is allowed';
  if (u.username || u.password) return 'Credentials in URL are not allowed';
  if (!/^\/(v1\.0|beta)\/users\/?$/.test(u.pathname)) return 'Only /v1.0/users or /beta/users is allowed';
  return null;
}

module.exports = async (req, res) => {
  cors(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  let p;
  try { p = (await readJson(req)).json || {}; }
  catch (e) { res.status(400).json({ error: e.message }); return; }

  try {
    if (p.action === 'token') {
      const { tenant_id, client_id, client_secret } = p;
      if (!tenant_id || !client_id || !client_secret) {
        res.status(400).json({ error: 'Missing required fields: tenant_id, client_id, client_secret' });
        return;
      }
      if (!/^[A-Za-z0-9.\-]+$/.test(tenant_id)) {
        res.status(400).json({ error: 'tenant_id must be a tenant GUID or domain name' });
        return;
      }
      const url = 'https://login.microsoftonline.com/' + tenant_id + '/oauth2/v2.0/token';
      const params = { grant_type: 'client_credentials', client_id, client_secret, scope: 'https://graph.microsoft.com/.default' };
      const response = await postForm(url, params);
      res.status(200).json({
        requestSent: {
          method: 'POST',
          url,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ ...params, client_secret: '***' }).toString()
        },
        responseStatus: response.status,
        responseBody: tryParseJson(response.body)
      });
      return;
    }

    if (p.action === 'query') {
      const { access_token, url, consistency } = p;
      if (!access_token || !url) { res.status(400).json({ error: 'Missing required fields: access_token, url' }); return; }
      const bad = validateGraphUrl(url);
      if (bad) { res.status(400).json({ error: bad }); return; }

      const headers = { 'Authorization': 'Bearer ' + access_token, 'Accept': 'application/json' };
      if (consistency) headers['ConsistencyLevel'] = 'eventual';

      const response = await request(url, { method: 'GET', headers });
      const respHeaders = {};
      KEEP_HEADERS.forEach(h => { if (response.headers[h]) respHeaders[h] = response.headers[h]; });

      res.status(200).json({
        requestSent: { method: 'GET', url, headers: { ...headers, Authorization: 'Bearer ' + maskToken(access_token) }, body: null },
        responseStatus: response.status,
        responseHeaders: respHeaders,
        responseBody: tryParseJson(response.body)
      });
      return;
    }

    res.status(400).json({ error: 'Invalid action. Use "token" or "query"' });
  } catch (e) {
    res.status(502).json({ error: 'Request failed: ' + e.message });
  }
};
