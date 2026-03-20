// api/client-credentials.js
// OIDC Client Credentials grant — fully server-side, returns raw request + response for display

const https = require('https');
const http = require('http');

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON body')); }
    });
  });
}

function postForm(urlStr, params) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams(params).toString();
    const url = new URL(urlStr);
    const lib = url.protocol === 'https:' ? https : http;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        'Accept': 'application/json'
      }
    };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  let payload;
  try { payload = await parseBody(req); }
  catch (e) { res.status(400).json({ error: e.message }); return; }

  const { token_endpoint, client_id, client_secret, scope } = payload;
  if (!token_endpoint || !client_id || !client_secret) {
    res.status(400).json({ error: 'Missing required fields: token_endpoint, client_id, client_secret' });
    return;
  }

  const params = {
    grant_type: 'client_credentials',
    client_id,
    client_secret,
    ...(scope ? { scope } : {})
  };

  const requestBodyStr = new URLSearchParams(params).toString();

  try {
    const response = await postForm(token_endpoint, params);
    let responseBody;
    try { responseBody = JSON.parse(response.body); } catch { responseBody = response.body; }

    res.status(200).json({
      requestSent: {
        method: 'POST',
        url: token_endpoint,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: requestBodyStr
      },
      responseStatus: response.status,
      responseBody
    });
  } catch (e) {
    res.status(502).json({ error: 'Token endpoint request failed: ' + e.message });
  }
};
