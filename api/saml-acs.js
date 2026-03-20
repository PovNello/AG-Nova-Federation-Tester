// api/saml-acs.js
// SAML Assertion Consumer Service endpoint.
// Receives the IdP's HTTP-POST SAMLResponse, base64-decodes + pretty-prints the XML,
// then renders an HTML page with the decoded assertion for educational display.
//
// Handles both SP-Initiated and IdP-Initiated SSO (no InResponseTo validation — educational tool).

const { XMLParser } = require('fast-xml-parser');

function parseFormBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        resolve(Object.fromEntries(params));
      } catch (e) {
        reject(new Error('Failed to parse form body'));
      }
    });
  });
}

function prettyXml(xmlStr) {
  // Simple pretty-printer (indent nested tags)
  let indent = 0;
  const tab = '  ';
  return xmlStr
    .replace(/(>)(<)(\/?)/g, '$1\n$3$2') // newline between tags
    .split('\n')
    .map(line => {
      const trimmed = line.trim();
      if (!trimmed) return '';
      if (trimmed.match(/^<\/\w/)) indent = Math.max(0, indent - 1);
      const out = tab.repeat(indent) + trimmed;
      if (trimmed.match(/^<\w/) && !trimmed.match(/\/>$/) && !trimmed.match(/^<\//)) indent++;
      return out;
    })
    .filter(l => l)
    .join('\n');
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function extractAttributes(parsed) {
  // Navigate the parsed object to find Attribute/AttributeValue nodes
  try {
    const assertion =
      parsed?.['samlp:Response']?.['saml:Assertion'] ||
      parsed?.['Response']?.['Assertion'] ||
      parsed?.['samlp:Response']?.['Assertion'] ||
      {};
    const attrStatement =
      assertion['saml:AttributeStatement'] ||
      assertion['AttributeStatement'] || {};
    const attrs = attrStatement['saml:Attribute'] || attrStatement['Attribute'] || [];
    const list = Array.isArray(attrs) ? attrs : [attrs];
    return list.map(a => ({
      name: a['@_Name'] || a['Name'] || '?',
      value: a['saml:AttributeValue'] || a['AttributeValue'] || ''
    }));
  } catch { return []; }
}

function extractNameId(parsed) {
  try {
    const subject =
      parsed?.['samlp:Response']?.['saml:Assertion']?.['saml:Subject'] ||
      parsed?.['Response']?.['Assertion']?.['Subject'] || {};
    return subject['saml:NameID'] || subject['NameID'] || '';
  } catch { return ''; }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end('Method Not Allowed — IdP must POST the SAMLResponse here.');
    return;
  }

  let formData;
  try { formData = await parseFormBody(req); }
  catch (e) { res.status(400).end('Failed to parse POST body: ' + e.message); return; }

  const raw = formData['SAMLResponse'];
  const relayState = formData['RelayState'] || '';

  if (!raw) {
    res.status(400).end('No SAMLResponse field in POST body.');
    return;
  }

  let decodedXml = '';
  let parseError = '';
  let attributes = [];
  let nameId = '';
  let statusCode = '';

  try {
    decodedXml = Buffer.from(raw, 'base64').toString('utf8');
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const parsed = parser.parse(decodedXml);
    attributes = extractAttributes(parsed);
    nameId = extractNameId(parsed);

    // Extract status
    try {
      const status =
        parsed?.['samlp:Response']?.['samlp:Status']?.['samlp:StatusCode'] ||
        parsed?.['Response']?.['Status']?.['StatusCode'] || {};
      statusCode = status['@_Value'] || status['Value'] || '';
    } catch { statusCode = ''; }
  } catch (e) {
    parseError = 'XML parse error: ' + e.message;
  }

  const prettyDecoded = decodedXml ? prettyXml(decodedXml) : '';
  const isSuccess = statusCode.includes('Success');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SAML ACS — AG Nova Federation Tester</title>
  <link rel="icon" type="image/png" href="/assets/fav.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/style.css">
  <style>
    .acs-container { max-width: 900px; margin: 2rem auto; padding: 0 1.5rem; }
    .status-badge { display: inline-flex; align-items: center; gap: 0.5rem; padding: 0.4rem 1rem;
      border-radius: 999px; font-weight: 600; font-size: 0.95rem; margin-bottom: 1.5rem; }
    .status-success { background: #d1fae5; color: #065f46; }
    .status-error { background: #fee2e2; color: #7f1d1d; }
    .attr-table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
    .attr-table th { text-align: left; padding: 0.6rem 0.8rem; background: #f1f5f9;
      font-weight: 600; color: #475569; border-bottom: 2px solid #e2e8f0; }
    .attr-table td { padding: 0.6rem 0.8rem; border-bottom: 1px solid #e2e8f0; font-family: monospace; word-break: break-all; }
    .attr-table tr:last-child td { border-bottom: none; }
    .nameid-box { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px;
      padding: 0.75rem 1rem; font-family: monospace; font-size: 0.9rem; margin-bottom: 1rem; }
    .back-link { display: inline-flex; align-items: center; gap: 0.4rem; color: #df7b35;
      text-decoration: none; font-size: 0.9rem; font-weight: 500; margin-bottom: 1.5rem; }
    .back-link:hover { color: #c26825; }
    .relay-state { font-family: monospace; font-size: 0.85rem; color: #64748b; }
  </style>
</head>
<body>
  <nav class="navbar">
    <a href="/" class="nav-brand">
      <img src="/assets/agnovalogonotext.png" alt="AG Nova logo" class="nav-logo">
      <span class="nav-title">AG Nova Federation Tester</span>
    </a>
  </nav>

  <div class="acs-container">
    <a href="/saml-sp.html" class="back-link">← Back to SP-Initiated Tester</a>

    <h1 style="font-size:1.6rem; font-weight:700; margin-bottom:0.5rem;">SAML ACS — Assertion Received</h1>
    <p style="color:#64748b; margin-bottom:1.5rem;">The Identity Provider posted a SAMLResponse to this endpoint. Below is the decoded content.</p>

    <div class="status-badge ${isSuccess ? 'status-success' : 'status-error'}">
      <span>${isSuccess ? '✓' : '✗'}</span>
      <span>Status: ${escapeHtml(statusCode || (parseError ? 'Parse Error' : 'Unknown'))}</span>
    </div>

    ${relayState ? `<div style="margin-bottom:1rem;">
      <span style="font-size:0.8rem;font-weight:600;color:#94a3b8;text-transform:uppercase;letter-spacing:.05em;">RelayState</span>
      <div class="relay-state">${escapeHtml(relayState)}</div>
    </div>` : ''}

    ${nameId ? `<div class="step-card">
      <div class="step-header"><span class="step-number">1</span><span class="step-title">NameID (Subject)</span></div>
      <div class="nameid-box">${escapeHtml(String(nameId))}</div>
    </div>` : ''}

    ${attributes.length > 0 ? `<div class="step-card" style="margin-top:1rem;">
      <div class="step-header"><span class="step-number">2</span><span class="step-title">Asserted Attributes</span></div>
      <table class="attr-table">
        <thead><tr><th>Attribute Name</th><th>Value</th></tr></thead>
        <tbody>
          ${attributes.map(a => `<tr><td>${escapeHtml(a.name)}</td><td>${escapeHtml(String(a.value))}</td></tr>`).join('')}
        </tbody>
      </table>
    </div>` : ''}

    ${parseError ? `<div class="step-card" style="margin-top:1rem;border-left:4px solid #f87171;">
      <p style="color:#b91c1c;">${escapeHtml(parseError)}</p>
    </div>` : ''}

    <div class="step-card" style="margin-top:1rem;">
      <div class="step-header"><span class="step-number">${attributes.length > 0 ? '3' : '2'}</span><span class="step-title">Raw SAMLResponse (Base64-Encoded)</span></div>
      <div class="request-window">
        <div class="request-window-header">HTTP POST · field: SAMLResponse</div>
        <pre class="request-window-body" style="max-height:160px;overflow-y:auto;">${escapeHtml(raw)}</pre>
      </div>
    </div>

    <div class="step-card" style="margin-top:1rem;">
      <div class="step-header"><span class="step-number">${attributes.length > 0 ? '4' : '3'}</span><span class="step-title">Decoded SAMLResponse XML</span></div>
      <div class="request-window">
        <div class="request-window-header">XML · Base64 Decoded</div>
        <pre class="request-window-body">${escapeHtml(prettyDecoded || 'Could not decode XML.')}</pre>
      </div>
    </div>

    <div style="margin-top:2rem; display:flex; gap:1rem; flex-wrap:wrap;">
      <a href="/saml-sp.html" class="btn btn-primary">Run Another SP Flow</a>
      <a href="/saml-idp.html" class="btn btn-secondary">IdP-Initiated Flow</a>
      <a href="/" class="btn btn-secondary">Home</a>
    </div>
  </div>
</body>
</html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).end(html);
};
