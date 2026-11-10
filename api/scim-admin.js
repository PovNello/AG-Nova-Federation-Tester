// api/scim-admin.js
// Control plane for the SCIM server page: create an endpoint, read its state, clear it, delete it.
// POST JSON { action, eid?, token? }

const store = require('./_lib/store');
const { readJson, origin, cors } = require('./_lib/http');

module.exports = async (req, res) => {
  cors(res, 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method Not Allowed' }); return; }

  let payload;
  try { payload = (await readJson(req, 4096)).json || {}; }
  catch (e) { res.status(400).json({ error: e.message }); return; }

  const { action, eid, token } = payload;
  const storage = store.backendName();

  try {
    if (action === 'create') {
      const created = await store.createEndpoint();
      res.status(200).json({
        eid: created.eid,
        token: created.token,
        tenantUrl: origin(req) + '/scim/' + created.eid + '/v2',
        storage
      });
      return;
    }

    if (!['state', 'reset', 'delete'].includes(action)) {
      res.status(400).json({ error: 'Invalid action. Use create, state, reset or delete' });
      return;
    }

    // everything below needs a valid endpoint id + secret token
    const cfg = await store.getCfg(eid);
    if (!cfg) { res.status(404).json({ error: 'Endpoint not found (expired or deleted). Create a new one.', code: 'not_found' }); return; }
    if (!store.checkToken(cfg, token)) { res.status(401).json({ error: 'Invalid token' }); return; }

    if (action === 'state') {
      const [users, groups, log] = await Promise.all([store.list(eid, 'users'), store.list(eid, 'groups'), store.getLog(eid)]);
      res.status(200).json({ users, groups, log, storage, createdAt: cfg.createdAt });
      return;
    }
    if (action === 'reset') { await store.reset(eid); res.status(200).json({ ok: true }); return; }
    if (action === 'delete') { await store.destroy(eid); res.status(200).json({ ok: true }); return; }
  } catch (e) {
    res.status(500).json({ error: 'Storage error: ' + e.message });
  }
};
