# AG Nova Federation Tester — Claude Context

This file serves as a baseline context for **Claude Code** (or any AI assistant) working on this project. It summarizes the architecture, completed work, and design guidelines.

---

## 🚀 Project Overview
An educational, provider-agnostic tester for **SAML 2.0** and **OIDC** federation flows. 
Unlike standard client libraries, it **does not hide** intermediate steps or raw payloads. It exposes exact HTTP requests/responses, deflated XML, and decoded JWTs for learning and debugging purposes.

---

## 📂 Project Structure

```text
AG Nova Federation Tester/
├── public/                       # Static Frontend (Modern, Flat/Square UI)
│   ├── index.html                # Homepage with OIDC & SAML Grid
│   ├── style.css                 # Brand Design System (Orange/Teal/Cream)
│   ├── shared.js                 # JS Helpers (PKCE, JWT Decode, SessionStorage)
│   ├── oidc-pkce.html            # Auth Code + PKCE (Browser-only)
│   ├── oidc-authcode.html        # Auth Code + Secret (Uses backend proxy)
│   ├── oidc-clientcreds.html     # Client Credentials (Fully backend-driven)
│   ├── saml-sp.html              # SP-Initiated SSO (Generate AuthnRequest)
│   ├── saml-idp.html             # IdP-Initiated SSO (Setup Guide)
│   └── assets/                   # Branding Assets
│       ├── fav.png               # Favicon
│       └── agnovalogonotext.png  # Navbar Logo
│
├── api/                          # Vercel Serverless Functions (Node.js)
│   ├── token-exchange.js         # Proxy exchange for Auth Code + Secret
│   ├── client-credentials.js     # Executes Client Credentials grant
│   ├── saml-request.js           # Builds unsigned AuthnRequest (Deflate+B64)
│   ├── saml-acs.js               # ACS Endpoint (Decodes POST Response -> HTML)
│   └── saml-metadata.js          # Outputs minimal SP Metadata XML
│
├── dev-server.js                 # Local wrapper to mimic Vercel routing
├── package.json                  # Only uses `fast-xml-parser`
└── vercel.json                   # Routes /api and static paths
```

---

## 🎨 Design System (AG Nova Rebrand)
- **Palette**:
  - Primary Accent: `#df7b35` (logo orange)
  - Secondary Accent: `#7faea8` (logo teal)
  - Highlight: `#e8e3d8` (logo cream)
- **Style**:
  - **Flat & Angular**: Heavy usage of square nodes (`border-radius: 4px` or `0` for buttons and inputs).
  - Minimalistic cards with side borders to create clean separator modules.

---

## 🛠️ API & Endpoint Map

| Endpoint | Type | Description |
| :--- | :--- | :--- |
| `/api/token-exchange` | `POST` | Exchanges `code` for token with client secret (keeps secret off frontend). |
| `/api/client-credentials`| `POST` | Simple wrapper to run credential token exchange. |
| `/api/saml-request` | `POST` | Standard deflated ACS AuthnBuilder output. |
| `/saml/acs` (`/api/saml-acs`) | `POST` | Assertion URL for IdPs. Parsed in browser window render output. |
| `/saml/metadata` | `GET` | Generates minimal `<EntityDescriptor>` SP file. |

---

## 🖥️ Running Locally

Run without full Vercel setup via the custom lightweight proxy-server:
```bash
npm install
node dev-server.js
# Serves at http://localhost:3001
```

To live test fully, bundle through `vercel dev` or push to a live static environment for assertion callbacks.
