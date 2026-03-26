// api/saml-metadata.js
// Returns a minimal SP metadata XML document.
// Since we don't sign requests, there is no certificate to include.
// This is mainly for registering the ACS URL with an IdP.

module.exports = (req, res) => {
  const host = req.headers['x-forwarded-host'] || req.headers['host'] || 'localhost:3000';
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const baseUrl = `${proto}://${host}`;

  const acsUrl = `${baseUrl}/saml/acs`;
  const entityId = `${baseUrl}/saml/entityid`;

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor
  xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${entityId}">
  <md:SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="false"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}"
      index="0"
      isDefault="true"/>
  </md:SPSSODescriptor>
</md:EntityDescriptor>`;

  res.setHeader('Content-Type', 'application/xml');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).end(xml);
};
