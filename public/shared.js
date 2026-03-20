// ── Theme Management (Instantly apply light mode if saved) ──
(function() {
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.add('light');
  }
})();

const SVG_SUN = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>`;
const SVG_MOON = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>`;

document.addEventListener('DOMContentLoaded', () => {
  const navbar = document.querySelector('.navbar');
  if (navbar && !document.querySelector('.btn-theme-toggle')) {
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-theme-toggle';
    
    const isLight = document.documentElement.classList.contains('light');
    toggleBtn.innerHTML = isLight ? SVG_MOON : SVG_SUN;
    toggleBtn.title = 'Toggle Theme';
    
    toggleBtn.addEventListener('click', () => {
      const isNowLight = document.documentElement.classList.toggle('light');
      localStorage.setItem('theme', isNowLight ? 'light' : 'dark');
      toggleBtn.innerHTML = isNowLight ? SVG_MOON : SVG_SUN;
    });
    
    navbar.appendChild(toggleBtn);
  }
});

// shared.js — Utilities shared across all flow pages

// ── Session storage helpers ──
function saveConfig(fields, prefix) {
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (el) sessionStorage.setItem(prefix + ':' + id, el.value);
  });
}

function loadConfig(fields, prefix) {
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = sessionStorage.getItem(prefix + ':' + id);
    if (saved) el.value = saved;
  });
}

function attachAutoSave(fields, prefix, onChange) {
  fields.forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('input', () => {
      saveConfig(fields, prefix);
      if (onChange) onChange();
    });
  });
}

// ── Request window renderer ──
// Renders a formatted HTTP request in the terminal-style .request-window div.
// `containerId` is the id of the .request-window-body <pre>.
function renderRequestBlock(containerId, { method, url, headers = {}, body = null }) {
  const el = document.getElementById(containerId);
  if (!el) return;
  let text = `${method} ${url}\n`;
  Object.entries(headers).forEach(([k, v]) => { text += `${k}: ${v}\n`; });
  if (body) {
    text += '\n';
    if (typeof body === 'string') {
      // Format URL-encoded body as key=value per line
      body.split('&').forEach(pair => { text += pair + '\n'; });
    } else {
      text += JSON.stringify(body, null, 2);
    }
  }
  el.textContent = text;
}

function setPlaceholder(containerId, msg) {
  const el = document.getElementById(containerId);
  if (el) { el.textContent = ''; el.innerHTML = `<span class="comment">${msg}</span>`; }
}

// ── JWT decoder ──
function decodeJwt(token) {
  const parts = token.split('.');
  if (parts.length < 2) return null;
  function b64decode(str) {
    try {
      str = str.replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      return JSON.parse(atob(str));
    } catch { return str; }
  }
  return {
    header: b64decode(parts[0]),
    payload: b64decode(parts[1]),
    signature: parts[2] || ''
  };
}

function renderJwt(containerId, token) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!token || typeof token !== 'string') {
    container.innerHTML = '<span class="comment">No token to decode.</span>';
    return;
  }
  const decoded = decodeJwt(token);
  if (!decoded) {
    container.innerHTML = '<span class="text-danger">Could not decode token.</span>';
    return;
  }
  const fmt = obj => JSON.stringify(obj, null, 2);
  container.innerHTML = `
    <div class="jwt-parts">
      <div class="jwt-part jwt-header-section">
        <div class="jwt-part-header">Header</div>
        <div class="jwt-part-body">${escHtml(fmt(decoded.header))}</div>
      </div>
      <div class="jwt-part jwt-payload-section">
        <div class="jwt-part-header">Payload</div>
        <div class="jwt-part-body">${escHtml(fmt(decoded.payload))}</div>
      </div>
      <div class="jwt-part jwt-sig-section">
        <div class="jwt-part-header">Signature (raw, base64url)</div>
        <div class="jwt-part-body" style="word-break:break-all;">${escHtml(decoded.signature)}</div>
      </div>
    </div>`;
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Result box helpers ──
function showPending(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.className = 'result-box result-pending'; el.textContent = msg || 'Waiting…'; }
}
function showSuccess(id, text) {
  const el = document.getElementById(id);
  if (el) { el.className = 'result-box result-success'; el.textContent = typeof text === 'object' ? JSON.stringify(text, null, 2) : text; }
}
function showError(id, text) {
  const el = document.getElementById(id);
  if (el) { el.className = 'result-box result-error'; el.textContent = typeof text === 'object' ? JSON.stringify(text, null, 2) : text; }
}

// ── Base64url helpers ──
function base64urlencode(buffer) {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function generateRandomString(byteLength) {
  const arr = new Uint8Array(byteLength);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => ('0' + b.toString(16)).slice(-2)).join('');
}

async function generatePkce() {
  const verifier = generateRandomString(32);
  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(verifier));
  const challenge = base64urlencode(digest);
  return { verifier, challenge };
}

// ── URL param helper ──
function getUrlParam(name) {
  return new URLSearchParams(window.location.search).get(name);
}

// ── Navbar logo SVG (reusable) ──
const LOGO_SVG = `<svg width="26" height="26" viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="28" height="28" rx="7" fill="#6366f1"/>
  <path d="M7 14C7 10.134 10.134 7 14 7C17.866 7 21 10.134 21 14" stroke="white" stroke-width="2" stroke-linecap="round"/>
  <path d="M7 14C7 17.866 10.134 21 14 21C17.866 21 21 17.866 21 14" stroke="white" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 2"/>
  <circle cx="14" cy="14" r="2.5" fill="white"/>
</svg>`;
