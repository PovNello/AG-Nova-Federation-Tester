// api/saml-request.js
// Builds an unsigned SAML AuthnRequest XML and returns it with the redirect URL.
// No signing/encryption — educational tool.

const crypto = require('crypto');
const zlib = require('zlib');

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

function buildAuthnRequest({ id, issueInstant, acsUrl, entityId, idpSsoUrl }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<samlp:AuthnRequest
  xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
  xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  ID="${id}"
  Version="2.0"
  IssueInstant="${issueInstant}"
  Destination="${idpSsoUrl}"
  AssertionConsumerServiceURL="${acsUrl}"
  ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
  <saml:Issuer>${entityId}</saml:Issuer>
  <samlp:NameIDPolicy
    Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
    AllowCreate="true"/>
</samlp:AuthnRequest>`;
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

  const { idp_sso_url, entity_id, acs_url } = payload;
  if (!idp_sso_url || !entity_id || !acs_url) {
    res.status(400).json({ error: 'Missing required fields: idp_sso_url, entity_id, acs_url' });
    return;
  }

  const id = '_' + crypto.randomBytes(16).toString('hex');
  const issueInstant = new Date().toISOString();

  const xml = buildAuthnRequest({ id, issueInstant, acsUrl: acs_url, entityId: entity_id, idpSsoUrl: idp_sso_url });

  // Deflate + Base64url encode per SAML HTTP Redirect binding spec
  const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8'));
  const samlRequest = deflated.toString('base64');

  const redirectUrl = `${idp_sso_url}?SAMLRequest=${encodeURIComponent(samlRequest)}&RelayState=${encodeURIComponent(acs_url)}`;

  res.status(200).json({
    id,
    issueInstant,
    decodedXml: xml,
    samlRequest,           // base64-encoded deflated XML (what goes in the URL)
    redirectUrl            // full IdP redirect URL
  });
};
