// dev-server.js — Local development server
// Serves public/ as static files and routes /api/* to api/*.js
// Run with: node dev-server.js

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3001;

// Patch a raw Node.js ServerResponse to match the Vercel serverless res API
function patchRes(res) {
  res.status = function(code) { this.statusCode = code; return this; };
  res.json = function(data) {
    this.setHeader('Content-Type', 'application/json');
    this.end(JSON.stringify(data));
    return this;
  };
  // Wrap end() to also accept a single string/buffer arg without breaking chaining
  const origEnd = res.end.bind(res);
  res.end = function(data) { origEnd(data); return this; };
  return res;
}

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) return false;
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/plain';
  res.setHeader('Content-Type', mime);
  res.statusCode = 200;
  fs.createReadStream(filePath).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  patchRes(res);
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = url.pathname;

  // Route /saml/acs and /saml/metadata
  if (pathname === '/saml/acs') {
    return require('./api/saml-acs')(req, res);
  }
  if (pathname === '/saml/metadata') {
    return require('./api/saml-metadata')(req, res);
  }

  // Route /scim/{endpointId}/v2/* (SCIM 2.0 server; mirrors the vercel.json route)
  if (/^\/scim\/[^/]+\/v2(\/|$)/.test(pathname)) {
    return require('./api/scim-server')(req, res);
  }

  // Route /api/*
  if (pathname.startsWith('/api/')) {
    const name = pathname.replace('/api/', '').replace(/\/$/, '');
    const modPath = path.join(__dirname, 'api', name + '.js');
    // only plain function names (no "_lib/..." helpers, no path tricks)
    if (/^[\w-]+$/.test(name) && fs.existsSync(modPath)) {
      return require(modPath)(req, res);
    }
    res.statusCode = 404;
    return res.end('API function not found: ' + name);
  }

  // Static files from public/
  let filePath = path.join(__dirname, 'public', pathname === '/' ? 'index.html' : pathname);
  if (serveStatic(res, filePath)) return;

  // Try appending .html
  if (!path.extname(filePath)) {
    if (serveStatic(res, filePath + '.html')) return;
  }

  res.statusCode = 404;
  res.end('Not found: ' + pathname);
});

server.listen(PORT, () => {
  console.log(`\n  FedTester dev server running at http://localhost:${PORT}\n`);
});
