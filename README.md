# AG Nova Federation Tester 🚀

An **educational, provider-agnostic tester** for **SAML 2.0** and **OIDC** federation flows. 
Unlike standard client libraries, this tool **does not hide** intermediate steps, raw headers, or deflated payloads. It exposes exact HTTP requests, decoded JWT tokens, and raw assertion XML side-by-step for learning and troubleshooting.

![AG Nova Federation Tester](public/assets/agnovalogonotext.png)

---

## 🌟 Key Features

*   **Provider-Agnostic**: Works with any Identity Provider (Azure AD/Entra, Okta, Google, Ping, Auth0). Enter your own endpoints without hardcoded logic.
*   **Step-by-Step Breakdown**: See every `GET`, `POST`, PKCE challenge exchange, and query string parameter clearly formatted.
*   **Decoded Payloads**: Live viewer for **JWT** variables (Header/Payload/Signature colors) and **SAML XML** syntax highlighting.
*   **Clean backend assistance**: Handled securely on backend endpoints for flows demanding `client_secret` assistance, remaining stateless for educational testing.

---

## 🖥️ Supported Flows

### 🔐 OIDC (OpenID Connect)
1.  **Authorization Code + PKCE**: 5 clear Browser-side steps. Perfect for SPA flow understanding.
2.  **Authorization Code + Client Secret**: Uses a backend proxy for the token exchange to handle client secrets securely.
3.  **Client Credentials**: Machine-to-machine exchange fully executed with backend logs.
4.  **Device Authorization Flow**: Optimized for input-constrained devices (polled proxy logic).

### 🛡️ SAML 2.0
1.  **SP-Initiated SSO**: Generates a standard (unsigned) `AuthnRequest`, deflates/encodes it with correct `RelayState`, and handles POST Assertion redirection.
2.  **IdP-Initiated SSO**: Guide mapping details required for single SP execution mapping.

### 🔄 User Sync
1.  **SCIM 2.0 Server**: Your own SCIM endpoint (`/scim/{id}/v2`). Entra ID *pushes* users and groups to it; the page shows every raw request/response and the resulting state. Backed by Upstash Redis (in-memory fallback locally).
2.  **Graph API Pull**: Client-credentials token, then *pull* users from Microsoft Graph, scoped by an inclusion filter (Entra property + operator + value).

---

## 📂 Project Structure

```text
OIDC Tester/
├── public/                       # Static Frontend (Flat/Square UI)
│   ├── index.html                # Homepage with OIDC & SAML Cards
│   ├── style.css                 # Brand Design (Orange/Teal/Cream)
│   ├── shared.js                 # JS Helpers (PKCE, JWT Decode)
│   ├── oidc-pkce.html            # Auth Code + PKCE
│   ├── oidc-authcode.html        # Auth Code + Secret
│   ├── oidc-clientcreds.html     # Client Credentials
│   ├── oidc-device.html          # Device Flow (polling)
│   ├── saml-sp.html              # SP-Initiated SSO
│   ├── saml-idp.html             # IdP-Initiated SSO
│   ├── scim-server.html          # SCIM 2.0 Server (push)
│   ├── graph-pull.html           # Graph API Pull (users)
│   └── assets/                   # Branding 
│
├── api/                          # Node.js Serverless Functions
│   ├── token-exchange.js         # Proxy for Auth Code + Secret
│   ├── client-credentials.js     # Client Credentials implementation
│   ├── oidc-device.js            # Proxy for Device Flow init & polling
│   ├── saml-request.js           # Builds unsigned AuthnRequest
│   ├── saml-acs.js               # Assertion Consumer Service endpoint
│   ├── saml-metadata.js          # Outputs SP Metadata XML
│   ├── scim-server.js            # SCIM 2.0 endpoint
│   ├── scim-admin.js             # SCIM endpoint management
│   ├── graph-pull.js             # Graph token + users query
│   └── _lib/                     # Shared helpers (http, Redis/memory store)
│
├── dev-server.js                 # Local Router Helper
├── package.json                  # `fast-xml-parser`
└── vercel.json                   # Routes file
```

---

## 🛠️ Testing Locally

Since this tool uses raw Node.js endpoints, run the packaged internal wrapper router server:

```bash
# 1. Install dependents
npm install

# 2. Boot dev server
node dev-server.js
```

> **Localhost SAML restrictions**: SAML requires public `AssertionConsumerService` endpoints from external IdP callbacks to connect back. Use a local reverse proxy tunnel server router (like **ngrok**) to get full local Assertion workflow testing.

---

## ☁️ Deploying to Vercel

Simply connect this Git repository on **Vercel**. All routing inside `vercel.json` maps automatically for `/api` edge execution setups.

**SCIM storage**: connect an **Upstash Redis** database to the project (Vercel → Storage). The standard env vars `KV_REST_API_URL` / `KV_REST_API_TOKEN` (or `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`) are picked up automatically. The tool only touches keys prefixed `agnft:scim:` (7-day TTL), so the database can be shared with other projects.

---

### ⚖️ Disclaimer
This application is designed purely for **educational purposes** and setting up safe sandbox federations. Flow assistance pages do NOT securely persist credentials inside the workspace cache variables. Use appropriately.
