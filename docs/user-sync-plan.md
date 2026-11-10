> **Status: implemented.** Deviations from the original plan: `scim-admin` has 4 actions (`create`, `state`, `reset` = clear data but keep endpoint, `delete` = remove endpoint); Graph proxy allows exactly `/v1.0/users` or `/beta/users` (query string only, no sub-paths); group displayName is not required to be unique; no `package.json` engines change.

# Plan: "User Sync" section — SCIM 2.0 Server + Graph API Pull

## Context
Tool today = OIDC + SAML flows. Want third homepage section **User Sync**, same educational style (step cards, raw HTTP exposed):
1. **SCIM 2.0 Server** — tool exposes SCIM endpoint; Entra ID provisioning **pushes** users/groups to it; page shows every raw request Entra sent + resulting state.
2. **Graph API Pull** — tool gets app token (client credentials) then **pulls users only** from Microsoft Graph `/users`, scoped by an **inclusion filter** (pick Entra property + operator + value); shows raw request/response.

SCIM needs persistence (Vercel functions stateless) → user's existing **Upstash Redis** (shared with other projects) → all keys namespaced `agnft:` prefix + TTL, never touch other keys. In-memory fallback when env missing (local `node dev-server.js`).

## Existing patterns to reuse
- Page skeleton / step cards / `.request-window` / `.result-box`: copy from [public/oidc-clientcreds.html](public/oidc-clientcreds.html).
- Helpers in [public/shared.js](public/shared.js): `loadConfig/saveConfig/attachAutoSave`, `renderRequestBlock`, `showPending/showSuccess/showError`, `renderTokenTabs` (decode Graph token, show `roles`), `truncateToken`, `copyToClipboard`, `escHtml`.
- Backend response shape `{ requestSent:{method,url,headers,body}, responseStatus, responseBody }` from [api/client-credentials.js](api/client-credentials.js).
- Tile markup + `.tile-badge` classes in [public/index.html](public/index.html) / [public/style.css:305-312](public/style.css#L305-L312).

## Files

### New: `api/_lib/` (underscore = Vercel does NOT deploy as function)
- **`api/_lib/http.js`** — `readBody(req)` (raw stream → string; tolerate empty body; accept `application/json` + `application/scim+json`; cap 256 KB), `postForm(url, params)`, `getJson(url, headers)` (returns status, headers, body). Copy of existing helpers; existing files untouched.
- **`api/_lib/store.js`** — storage abstraction, two backends:
  - Upstash REST via global `fetch`, no npm dep. Env: `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN`. Use `POST {url}/pipeline` body `[["HSET",k,f,v],["EXPIRE",k,ttl],...]`, header `Authorization: Bearer <token>`.
  - Memory `Map` fallback (same interface) when env missing.
  - Key schema (only these, nothing else ever written; no `KEYS`/`SCAN`/`FLUSH*`):
    ```
    agnft:scim:{eid}:cfg     STRING  {"token":"...","createdAt":"..."}
    agnft:scim:{eid}:users   HASH    id -> SCIM User JSON
    agnft:scim:{eid}:groups  HASH    id -> SCIM Group JSON
    agnft:scim:{eid}:log     LIST    LPUSH entry, LTRIM 0 199
    ```
    TTL 7 days, refreshed (`EXPIRE`) on every write. Reset = `DEL` on exactly these 4 keys.
  - API: `createEndpoint()`, `getCfg(eid)`, `list(eid,type)`, `get(eid,type,id)`, `put(eid,type,obj)`, `del(eid,type,id)`, `log(eid,entry)`, `getLog(eid)`, `reset(eid)`, `backendName()`.
  - Caps: 1000 resources per type per eid (→ 507/400 SCIM error).

### New: `api/scim-server.js` — SCIM 2.0 endpoint (RFC 7643/7644, Entra-compatible)
- Route: `/scim/{eid}/v2/{path}`. Read `eid`/`path` from `req.query` (Vercel rewrite) else regex on `req.url` (dev).
- Auth: `Authorization: Bearer <token>` vs `cfg.token`, `crypto.timingSafeEqual`. Unknown eid → 404, bad token → 401 SCIM error.
- Responses `Content-Type: application/scim+json`; errors `{schemas:["urn:ietf:params:scim:api:messages:2.0:Error"],status:"409",scimType,detail}`.
- Endpoints:
  - `GET ServiceProviderConfig`, `ResourceTypes`, `Schemas` (static JSON; patch=true, filter=true, bulk=false).
  - `GET Users|Groups` — `filter` simple `attr eq "value"` (case-insensitive attr; `userName`, `externalId`, `id`, `displayName`), `startIndex`/`count` → `ListResponse`. Entra **Test Connection** = `GET /Users?filter=userName eq "<guid>"` → must return 200 `totalResults:0`.
  - `POST` → 201, assign `id` (uuid), `meta{resourceType,created,lastModified,location,version}`; duplicate `userName` (users) / `displayName` (groups) → 409 `uniqueness`.
  - `GET/{id}`, `PUT/{id}` (replace, keep id/meta.created), `DELETE/{id}` → 204.
  - `PATCH/{id}` PatchOp: `op` case-insensitive (Entra sends `Replace`/`Add`/`Remove`); no `path` → merge `value` object; dotted path (`name.givenName`); value-filter path (`emails[type eq "work"].value`, `members[value eq "x"]`); enterprise ext path (`urn:ietf:params:scim:schemas:extension:enterprise:2.0:User:manager`); coerce `active` `"True"/"False"` strings → bool; group `members` add (array append dedupe) / remove. Return 200 + resource.
- Every request (incl. 401/404) logged: `{ts, method, path, query, headers (Authorization masked "Bearer ***abcd"), body, status, responseBody}`.

### New: `api/scim-admin.js` — control plane for page (POST JSON)
- `{action:"create"}` → new `eid` (`crypto.randomBytes(8).toString('hex')`) + token (`randomBytes(24).toString('base64url')`); returns `{eid, token, tenantUrl:"https://{host}/scim/{eid}/v2", storage}`.
- `{action:"state", eid, token}` → `{users, groups, log, storage}` (token required, so no one else reads data).
- `{action:"reset", eid, token}` → delete 4 keys.

### New: `api/graph-pull.js`
- `{action:"token", tenant_id, client_id, client_secret}` → `postForm("https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token", {grant_type:"client_credentials", client_id, client_secret, scope:"https://graph.microsoft.com/.default"})`, return requestSent (secret masked) + response.
- `{action:"query", access_token, url, consistency}` → **allowlist**: `https:` + hostname `graph.microsoft.com` + pathname starts `/v1.0/users` or `/beta/users` (users only; no open proxy / SSRF), else 400. GET with `Authorization: Bearer`, `Accept: application/json`, optional `ConsistencyLevel: eventual`. Return requestSent (token truncated), status, selected headers (`request-id`, `client-request-id`, `x-ms-ags-diagnostic`, `retry-after`), body.

### New pages
- **`public/scim-server.html`** (prefix `scimserver`; eid/token in `localStorage` so survive across Entra provisioning cycles ~40 min):
  - Step 0 — what SCIM push is, flow diagram text (Entra → `POST /Users` → our store).
  - Step 1 — "Create Endpoint" / "Reset" buttons; show Tenant URL + Secret Token with copy; storage badge (Redis / memory warning).
  - Step 2 — Entra setup guide: Enterprise App → Provisioning → Automatic → Tenant URL + Secret Token → Test Connection → Mappings → Provision on demand. Plus sample curl (`POST /Users` with scim+json body) for manual test.
  - Step 3 — Request log, newest first, terminal-style per entry (`renderRequestBlock`-like + response), "Auto-refresh 5s" toggle (polls `scim-admin state`).
  - Step 4 — Current state: users table (userName, displayName, active, externalId), groups table (displayName, members count); click row → raw JSON.
- **`public/graph-pull.html`** — **users only** (no groups, no delta; keep simple). Prefix `graphpull`; secret not auto-saved, same as clientcreds.
  - Step 1 — config: tenant id, client id, secret; note required **Application** perm `User.Read.All` + admin consent.
  - Step 2 — token request preview → execute → requestSent + response + `renderTokenTabs` (check `roles` claim).
  - Step 3 — **Inclusion filter** (which users to import). Dynamic rows table (same add-row pattern as extra params in oidc pages), each row:
    - Property `<select>`: `userPrincipalName`, `mail`, `displayName`, `givenName`, `surname`, `department`, `jobTitle`, `companyName`, `officeLocation`, `city`, `country`, `employeeId`, `employeeType`, `userType`, `accountEnabled` (bool), `onPremisesSyncEnabled` (bool), `onPremisesExtensionAttributes/extensionAttribute1..15`, `Custom…` (shows free text input for property name).
    - Operator `<select>`: `eq`, `ne`, `startsWith`, `endsWith`.
    - Value text box (bool props → `true/false` select).
    - Rows joined with `and`. No rows = all users.
    - Build `$filter` client-side: string → `prop eq 'v'` / `startsWith(prop,'v')`, single quote escaped `'` → `''`; bool → unquoted. Value `encodeURIComponent` in URL.
    - Because `ne`, `endsWith`, extension attrs, many props need **advanced query**: when filter present always send `ConsistencyLevel: eventual` + `$count=true` (harmless for simple ones) → also gives `@odata.count`.
    - Extra fields: `$select` (default `id,displayName,userPrincipalName,mail,accountEnabled` + filtered props auto-added), `$top` (default 100, max 999).
    - Live preview of final GET URL + headers in `.request-window`; editable raw `$filter` override textbox for power users.
  - Step 4 — response: status, headers, JSON (pretty) + table (columns = `$select` fields) + `@odata.count` "N users match". `@odata.nextLink` → "Next page" button and "Load all" (loop, cap 50 pages, each call logged).

### Modify
- [public/index.html](public/index.html) — after SAML section add `<div class="divider">` + `protocol-section` "User Sync" (subtitle "Identity provisioning — push via SCIM, pull via Microsoft Graph"); icon: emoji 🔄 inside `.protocol-icon` (no asset yet). Tiles:
  - `/scim-server.html` 📥 "SCIM 2.0 Server" — "Expose a SCIM endpoint. Entra ID pushes users & groups; inspect every raw provisioning call." badge `badge-sync` "PUSH ENDPOINT".
  - `/graph-pull.html` 📤 "Graph API Pull" — "Client credentials token, then pull users from Microsoft Graph scoped by an inclusion filter on any Entra property." badge `badge-backend` "BACKEND PROXY".
  - Update meta description to include SCIM/Graph.
- [public/style.css](public/style.css) — add `.badge-sync` (teal variant, near line 312), `.method-PATCH/.method-PUT/.method-DELETE` badges, small `.data-table` if none exists.
- [vercel.json](vercel.json) — insert before `/(.*)`:
  `{ "src": "/scim/([^/]+)/v2/?(.*)", "dest": "/api/scim-server?eid=$1&path=$2" }`
- [dev-server.js](dev-server.js) — before `/api/` branch: regex `^/scim/([^/]+)/v2/?(.*)$` → set `req.query={eid,path, ...searchParams}` → `require('./api/scim-server')`. Also 404 for `/api/_*` names.
- `claude.md` + `gemini.md` (must stay identical per project rule): structure tree, new "User Sync" feature section, Redis key schema + env vars. `README.md` short section.
- `package.json`: no new deps (uses global `fetch`, Node ≥18 — add `"engines": {"node": ">=18"}`).

## Vercel setup (user side)
Connect Upstash DB to this project (Storage tab). Check env var names in project settings — if custom prefix used (e.g. `FOO_KV_REST_API_URL`), store.js reads only the 4 standard names → rename or tell me prefix.

## Verification
1. `node dev-server.js` (memory backend):
   - homepage shows User Sync section + 2 tiles, light/dark ok.
   - SCIM page: Create Endpoint → copy URL/token → curl:
     ```
     curl -s -H "Authorization: Bearer $T" "http://localhost:3001/scim/$E/v2/Users?filter=userName%20eq%20%22x%22"   # 200 totalResults 0
     curl -s -X POST -H "Authorization: Bearer $T" -H "Content-Type: application/scim+json" -d '{"schemas":["urn:ietf:params:scim:schemas:core:2.0:User"],"userName":"a@b.c","active":true}' http://localhost:3001/scim/$E/v2/Users   # 201
     # repeat POST -> 409; PATCH {"schemas":["urn:ietf:params:scim:api:messages:2.0:PatchOp"],"Operations":[{"op":"Replace","path":"active","value":"False"}]} -> active:false
     # DELETE -> 204; wrong token -> 401
     ```
     Log + state tables update on page.
   - Graph page: non-graph URL in query → 400.
2. Vercel preview deploy (Redis env set): repeat curls; check in Upstash data browser only `agnft:scim:*` keys created, with TTL.
3. Entra: Enterprise app (non-gallery) → Provisioning → Test Connection green → Provision on demand a user + group → page log shows `GET filter`, `POST /Users`, `PATCH`, group `members` add.
4. Graph: app reg with `User.Read.All` app perm consented → token `roles` visible → no filter `$top=5` → nextLink paging works → filter `department eq 'IT'` → only IT users, `@odata.count` right → `endsWith(mail,'@contoso.com')` works (advanced query header sent) → `accountEnabled eq false` (bool unquoted) → value with `'` (e.g. `O'Brien`) escaped ok → `/groups` URL to proxy → 400.
