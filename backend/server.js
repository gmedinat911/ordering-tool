require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Load drink mapping from external JSON file
const DRINK_MAP = require(path.join(__dirname, 'drinks.json'));
const DRINK_MAP_PATH = path.join(__dirname, 'drinks.json');
function readDrinkMap() {
  try {
    delete require.cache[require.resolve(DRINK_MAP_PATH)];
    return require(DRINK_MAP_PATH);
  } catch (e) {
    if (DEBUG) console.log('⚠️ Failed to reload drinks.json, using cached map:', e.message);
    return DRINK_MAP;
  }
}

// PostgreSQL connection pool and seeder
const seedDrinks = require('./seedDrinks');
const pool = require('./db');

const app = express();
const port = process.env.PORT || 3000;
const DEBUG = /^true$/i.test(process.env.DEBUG || 'true');

/* ------------------------------------------------------------------
 * In-memory state
 * ------------------------------------------------------------------*/
let queue = [];
// Simple in-memory SSE clients
const sseClients = new Set();
function broadcast(event, payload) {
  const msg = `event: ${event}\n` + `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch (_) {}
  }
}

/* ------------------------------------------------------------------
 * Express setup
 * ------------------------------------------------------------------*/
app.use(cors());
app.use(bodyParser.json());

// SSE endpoint for browser notifications
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  res.write(`event: hello\n` + `data: {"ok":true}\n\n`);
  sseClients.add(res);
  req.on('close', () => { sseClients.delete(res); });
});

/* ------------------------------------------------------------------
 * Meta/WhatsApp webhook verification (GET)
 * ------------------------------------------------------------------*/
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN;
  if (mode === 'subscribe' && token && challenge && token === VERIFY_TOKEN) {
    if (DEBUG) console.log('✅ Webhook verified');
    return res.status(200).send(challenge);
  }
  if (DEBUG) console.log('⛔ Webhook verify failed:', { mode, tokenPresent: !!token });
  return res.sendStatus(403);
});

/* ------------------------------------------------------------------
 * Web Push setup and subscription store
 * ------------------------------------------------------------------*/
const webPush = require('web-push');
let VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
let VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  const { publicKey, privateKey } = webPush.generateVAPIDKeys();
  VAPID_PUBLIC_KEY = publicKey;
  VAPID_PRIVATE_KEY = privateKey;
  console.log('⚠️ Generated ephemeral VAPID keys. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in env to persist.');
  console.log('VAPID_PUBLIC_KEY:', VAPID_PUBLIC_KEY);
}
webPush.setVapidDetails(`mailto:${process.env.CONTACT_EMAIL || 'admin@example.com'}`,
  VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
const subscriptions = new Map(); // clientId -> subscription

app.get('/vapidPublicKey', (req, res) => {
  res.json({ key: VAPID_PUBLIC_KEY });
});

app.post('/subscribe', (req, res) => {
  try {
    const { subscription, clientId } = req.body || {};
    const id = clientId || String(Date.now()) + Math.random().toString(36).slice(2);
    if (!subscription || !subscription.endpoint) return res.status(400).json({ ok: false });
    subscriptions.set(id, subscription);
    // Persist in DB
    upsertSubscription(id, subscription, VAPID_PUBLIC_KEY).catch(e => console.error('❌ upsertSubscription error:', e.message));
    return res.json({ ok: true, clientId: id });
  } catch (e) {
    console.error('❌ /subscribe error:', e);
    return res.status(500).json({ ok: false });
  }
});

/* ------------------------------------------------------------------
 * Admin: Test Push to a clientId
 * ------------------------------------------------------------------*/
app.post('/push/test', verifyJWT, async (req, res) => {
  try {
    const { clientId, title, body } = req.body || {};
    if (!clientId) return res.status(400).json({ ok: false, error: 'clientId is required' });
    await sendPushToClient(clientId, { title: title || 'Test Notification', body: body || 'This is a test push from the dashboard.' });
    return res.json({ ok: true });
  } catch (e) {
    console.error('❌ /push/test error', e);
    return res.status(500).json({ ok: false });
  }
});

async function sendPushToClient(clientId, payload) {
  let sub = subscriptions.get(clientId);
  let pubKey = VAPID_PUBLIC_KEY;
  if (!sub) {
    try {
      const row = await getSubscriptionRow(clientId);
      if (row) {
        sub = row.subscription;
        pubKey = row.vapid_public_key || VAPID_PUBLIC_KEY;
        subscriptions.set(clientId, sub);
      }
    } catch {}
  }
  if (!sub) return;
  // Choose matching VAPID private key for the stored public key
  const { publicKey, privateKey } = resolveVapidPair(pubKey);
  try {
    await webPush.sendNotification(
      sub,
      JSON.stringify(payload),
      { vapidDetails: { subject: `mailto:${process.env.CONTACT_EMAIL || 'admin@example.com'}`, publicKey, privateKey } }
    );
  }
  catch (e) { console.error('❌ web-push error:', e.statusCode, e.body || e.message); }
}

// Resolve a VAPID keypair given a public key, supporting one legacy pair via env
function resolveVapidPair(requestedPublic) {
  const pairs = [
    { pub: process.env.VAPID_PUBLIC_KEY, priv: process.env.VAPID_PRIVATE_KEY },
    { pub: process.env.VAPID_PUBLIC_KEY_2, priv: process.env.VAPID_PRIVATE_KEY_2 },
    { pub: process.env.VAPID_PUBLIC_KEY_3, priv: process.env.VAPID_PRIVATE_KEY_3 },
  ].filter(p => p && p.pub && p.priv);
  const found = pairs.find(p => p.pub === requestedPublic);
  if (found) return { publicKey: found.pub, privateKey: found.priv };
  // Fallback to current
  return { publicKey: VAPID_PUBLIC_KEY, privateKey: VAPID_PRIVATE_KEY };
}

// DB helpers for push subscriptions
async function ensureSubscriptionTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      client_id TEXT PRIMARY KEY,
      subscription JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      vapid_public_key TEXT
    );
  `);
  // Add column if it does not exist (for existing deployments)
  try { await pool.query('ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS vapid_public_key TEXT'); } catch {}
}
async function upsertSubscription(clientId, subscription, vapidPublicKey) {
  await pool.query(
    `INSERT INTO push_subscriptions (client_id, subscription, created_at, updated_at, vapid_public_key)
     VALUES ($1, $2, NOW(), NOW(), $3)
     ON CONFLICT (client_id)
     DO UPDATE SET subscription = EXCLUDED.subscription, vapid_public_key = EXCLUDED.vapid_public_key, updated_at = NOW()`,
    [clientId, subscription, vapidPublicKey]
  );
}
async function getSubscriptionRow(clientId) {
  const { rows } = await pool.query('SELECT subscription, vapid_public_key FROM push_subscriptions WHERE client_id = $1', [clientId]);
  return rows[0] || null;
}

/* ------------------------------------------------------------------
 * Auth helpers
 * ------------------------------------------------------------------*/
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
const JWT_SECRET = process.env.JWT_SECRET;
function signToken() {
  return jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '2h' });
}
function verifyJWT(req, res, next) {
  const auth = req.get('authorization') || '';
  const token = auth.replace(/Bearer\s+/i, '');
  if (!token) return res.sendStatus(401);
  try {
    jwt.verify(token, JWT_SECRET);
    return next();
  } catch (err) {
    if (DEBUG) console.log('⛔ Invalid JWT:', err.message);
    return res.sendStatus(401);
  }
}

/* ------------------------------------------------------------------
 * Healthcheck
 * ------------------------------------------------------------------*/
app.get('/ping', (req, res) => res.send('✅ Server is alive'));

app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.status(200).json({ status: 'ok', timestamp: result.rows[0].now });
  } catch (err) {
    console.error('❌ /health DB check failed:', err);
    res.status(500).json({ status: 'error', message: 'DB connection failed' });
  }
});

/* ------------------------------------------------------------------
 * Diagnostics: WhatsApp credential status (no secrets exposed)
 * ------------------------------------------------------------------*/
app.get('/whatsapp/status', (req, res) => {
  try {
    const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
    const hasToken = !!(process.env.WHATSAPP_TOKEN || process.env.ACCESS_TOKEN);
    const hasVerify = !!(process.env.WHATSAPP_VERIFY_TOKEN || process.env.VERIFY_TOKEN);
    const canSend = hasToken && !!phoneId;
    const details = {
      ok: true,
      phoneIdPresent: !!phoneId,
      phoneId: phoneId || null,
      tokenPresent: hasToken,
      verifyTokenPresent: hasVerify,
      adminNumbers: ADMIN_NUMBERS,
      canSend
    };
    return res.json(details);
  } catch (e) {
    console.error('❌ /whatsapp/status error:', e);
    return res.status(500).json({ ok: false });
  }
});

/* ------------------------------------------------------------------
 * Login route (frontend auth)
 * ------------------------------------------------------------------*/
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  const ip = req.headers['x-forwarded-for'] || req.ip;
  console.log(`🔐 Login attempt from ${ip} @ ${new Date().toISOString()}`);
  if (password !== DASHBOARD_PASS) {
    console.log('❌ Login failed');
    return res.status(401).send('Unauthorized');
  }
  const token = signToken();
  console.log('✅ Login success – JWT issued');
  return res.json({ token });
});

/* ------------------------------------------------------------------
 * Admin: Generate VAPID keypair (JWT protected)
 * ------------------------------------------------------------------*/
app.post('/admin/vapid/generate', verifyJWT, (req, res) => {
  try {
    const { publicKey, privateKey } = webPush.generateVAPIDKeys();
    return res.json({ publicKey, privateKey });
  } catch (e) {
    console.error('❌ /admin/vapid/generate error:', e);
    return res.status(500).json({ ok: false });
  }
});

/* ------------------------------------------------------------------
 * WhatsApp admin numbers & helper
 * ------------------------------------------------------------------*/
function toE164(num) {
  if (!num) return '';
  const trimmed = String(num).trim();
  if (trimmed.startsWith('+')) return trimmed;
  const digits = trimmed.replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map(n => toE164(n))
  .filter(Boolean);

async function sendWhatsApp(to, text) {
  const token = process.env.WHATSAPP_TOKEN || process.env.ACCESS_TOKEN;
  const phoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  if (!token || !phoneId) {
    console.error('❌ Missing WhatsApp credentials. Set WHATSAPP_TOKEN (or ACCESS_TOKEN) and WHATSAPP_PHONE_NUMBER_ID in your environment.');
    return;
  }
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/${phoneId}/messages`,
      { messaging_product: 'whatsapp', to: toE164(to), text: { body: text } },
      { headers: { Authorization: `Bearer ${token}` } }
    );
  } catch (e) {
    const status = e?.response?.status;
    const data = e?.response?.data;
    console.error('❌ WhatsApp send error:', status || '', data || e.message);
  }
}

/* ------------------------------------------------------------------
 * Admin middleware (WhatsApp commands)
 * ------------------------------------------------------------------*/
async function adminHandler(req, res, next) {
  try {
    if (DEBUG) console.log('📩 Incoming webhook payload keys:', Object.keys(req.body || {}));
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const fromE = toE164(from);
    const text = (message?.text?.body || '').trim();
    if (DEBUG) console.log('👤 Webhook from:', { raw: from, e164: fromE, admins: ADMIN_NUMBERS });
    if (!ADMIN_NUMBERS.length && DEBUG) console.log('⚠️ ADMIN_NUMBERS empty; allowing all senders for admin commands (test mode)');
    const isAdmin = ADMIN_NUMBERS.length ? ADMIN_NUMBERS.includes(fromE) : true;
    if (!isAdmin) return next();
    const lower = text.toLowerCase().trim();
    if (['queue', 'clear'].includes(lower) || !isNaN(parseInt(lower, 10))) {
      console.log(`👑 Admin cmd by ${fromE}: ${lower}`);
    }
    if (lower === 'queue') {
      if (!queue.length) {
        await sendWhatsApp(fromE, '📭 Queue is empty.');
      } else {
        const summary = queue
          .map((o, i) => `#${i+1} [id:${o.id}] • ${o.name} → ${o.cocktail}`)
          .join('\n');
        await sendWhatsApp(fromE,
          `📋 Current orders (${queue.length}):\n${summary}\n\nReply with a number to mark done (e.g., 1) or send: done id <orderId>`
        );
      }
      return res.sendStatus(200);
    }
    if (lower === 'clear') {
      queue = [];
      await sendWhatsApp(fromE, '🗑️ Queue cleared.');
      return res.sendStatus(200);
    }
    // Support 'done id <orderId>' or 'id <orderId>'
    const idMatch = lower.match(/^\s*(?:done\s+)?id\s+(\d{6,})\s*$/);
    if (idMatch) {
      const orderId = parseInt(idMatch[1], 10);
      const qIdx = queue.findIndex(o => o.id === orderId);
      if (qIdx === -1) {
        await sendWhatsApp(fromE, `❌ No order with id ${orderId} on this server instance.`);
        return res.sendStatus(200);
      }
      const [order] = queue.splice(qIdx, 1);
      await sendWhatsApp(order.from, `🍸 Your "${order.displayName}" is ready!`);
      await sendWhatsApp(fromE, `✅ Order id ${orderId} served.`);
      return res.sendStatus(200);
    }
    // Fallback: numeric position (1-based)
    const idx = parseInt(lower, 10);
    if (!isNaN(idx)) {
      const pos = idx - 1;
      if (pos < 0 || pos >= queue.length) {
        await sendWhatsApp(fromE, `❌ No order #${idx}.`);
        return res.sendStatus(200);
      }
      const [order] = queue.splice(pos, 1);
      await sendWhatsApp(order.from, `🍸 Your "${order.displayName}" is ready!`);
      await sendWhatsApp(fromE, `✅ Order #${idx} served.`);
      return res.sendStatus(200);
    }
    if (DEBUG) console.log(`⚠️ Unknown admin text, passing to customer flow: "${text}"`);
    return next();
  } catch (err) {
    console.error('Admin handler error:', err);
    return res.sendStatus(500);
  }
}

/* ------------------------------------------------------------------
 * Main webhook (adminHandler first)
 * ------------------------------------------------------------------*/
app.post('/webhook', adminHandler, async (req, res) => {
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  if (!value?.messages?.[0]) {
    if (DEBUG) {
      const status = value.statuses?.[0]?.status || 'unknown';
      console.log(`ℹ️ Ignored status event (${status})`);
    }
    return res.sendStatus(200);
  }
  const message = value.messages[0];
  const contact = value.contacts?.[0];
  const from = message.from;
  const fullName = contact?.profile?.name || '';
  const firstName = fullName.split(/\s+/)[0] || from;
  const rawText = (message.text?.body || '').trim();
  if (DEBUG) console.log('📝 Incoming text:', rawText);

  // 1) Strip prefix
  let stripped = rawText.replace(/^i['’]?d\s+like\s+to\s+order\s+the\s+/i, '').trim();
  // 2) Normalize and clean input (remove apostrophes, emojis, punctuation)
  let cleaned = stripped.replace(/['’]/g, '').trim();
  cleaned = cleaned.replace(/[^\w\s]/g, '').trim();

  // 3) Map to canonical or display-name triggers
  const DM = readDrinkMap();
  const key = cleaned.toLowerCase();
  const mapping = DM[key]
    || Object.values(DM).find(e =>
         key.includes(e.canonical.toLowerCase())
      || key.includes(e.display.toLowerCase())
    );
  if (!mapping) {
    if (DEBUG) console.log(`❌ Invalid order from ${from}: "${cleaned}"`);
    await sendWhatsApp(
      from,
      `❌ Invalid order "${stripped}". \n Please check the menu at: https://tinyurl.com/53bmccax`
    );
    return res.sendStatus(200);
  }
  const canonical = mapping.canonical;
  if (DEBUG) console.log(`✅ Parsed drink: display='${stripped}' → canonical='${canonical}'`);
  // ─── STOCK CHECK ──────────────────────────────────────
  const stockRes = await pool.query(
    'SELECT id, stock_count FROM drinks WHERE canonical = $1',
    [canonical]
  );
  const drinkRecord = stockRes.rows[0] || {};
  if ((drinkRecord.stock_count || 0) <= 0) {
    await sendWhatsApp(from, `❌ Sorry, "${stripped}" is sold out.`);
    return res.sendStatus(200);
  }
  if (DEBUG) console.log(`✅ Parsed drink: display='${stripped}' → canonical='${canonical}'`);

  queue.push({ id: Date.now(), from, name: firstName, cocktail: canonical, displayName: stripped, createdAt: Date.now() });
  // ─── STOCK DECREMENT ───────────────────────────────────
  await pool.query(
    'UPDATE drinks SET stock_count = GREATEST(stock_count - 1, 0) WHERE id = $1',
    [drinkRecord.id]
  );
  queue.sort((a, b) => a.createdAt - b.createdAt);
  console.log(`✅ New order from ${from}: ${stripped}`);
  await sendWhatsApp(from, `👨‍🍳 Hi ${firstName}, we received your order for "${stripped}". We're preparing it now!`);
  // Broadcast to SSE listeners and notify admins
  try {
    broadcast('order_new', { id: queue[queue.length-1]?.id, cocktail: canonical, displayName: stripped, source: 'whatsapp' });
    if (ADMIN_NUMBERS.length) {
      const adminMsg = `🆕 New WhatsApp order: ${stripped} (${canonical})`;
      await Promise.allSettled(ADMIN_NUMBERS.map(n => sendWhatsApp(n, adminMsg)));
    }
  } catch (e) { if (DEBUG) console.log('SSE/admin notify error:', e.message); }
  return res.sendStatus(200);
});

/* ------------------------------------------------------------------
 * Queue API (protected by JWT)
 * ------------------------------------------------------------------*/
app.get('/queue', verifyJWT, (req, res) => {
  // Return canonical names instead of user-typed fuzzy displayName
  const normalizedQueue = queue.map(o => ({
    id: o.id,
    from: o.from,
    name: o.name,
    cocktail: o.cocktail,
    displayName: o.cocktail,
    createdAt: o.createdAt
  }));
  res.json(normalizedQueue);
});
app.post('/clear', verifyJWT, (req, res) => {
  queue = [];
  return res.send('Queue cleared');
});

app.post('/done', verifyJWT, async (req, res) => {
  const { id } = req.body;
  const idx = queue.findIndex(o => o.id === id);
  if (idx === -1) return res.status(404).send('Order not found');
  const [order] = queue.splice(idx, 1);
  await sendWhatsApp(order.from, `🍸 Your "${order.displayName}" is ready!`);
  // Broadcast completion event (include clientId so the originating browser can match even after reload)
  try { broadcast('order_done', { id: order.id, cocktail: order.cocktail, displayName: order.displayName, clientId: order.clientId || null }); } catch {}
  // Send push to the originating client if available
  try { if (order.clientId) { await sendPushToClient(order.clientId, { type: 'order_done', id: order.id, cocktail: order.cocktail, displayName: order.displayName }); } } catch {}
  return res.send('Done');
});

/* ------------------------------------------------------------------
 * Admin: Adjust Stock
 * ------------------------------------------------------------------*/
app.post('/stock', verifyJWT, async (req, res) => {
  const { id, delta, absolute } = req.body;
  try {
    if (absolute != null) {
      await pool.query(
        'UPDATE drinks SET stock_count = $1 WHERE id = $2',
        [absolute, id]
      );
    } else if (delta != null) {
      await pool.query(
        'UPDATE drinks SET stock_count = GREATEST(stock_count + $1, 0) WHERE id = $2',
        [delta, id]
      );
    } else {
      return res.status(400).send('Provide either { absolute } or { delta }');
    }
    const { rows } = await pool.query(
      'SELECT id, display_name, stock_count FROM drinks WHERE id = $1',
      [id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('❌ /stock error:', err);
    res.status(500).send('Stock update failed');
  }
});

/* ------------------------------------------------------------------
 * Admin: Reload Drinks Map
 * ------------------------------------------------------------------*/
app.post('/admin/reload-drinks', verifyJWT, (req, res) => {
  try {
    const dm = readDrinkMap();
    const count = Object.keys(dm || {}).length;
    return res.json({ ok: true, keys: count });
  } catch (e) {
    console.error('❌ /admin/reload-drinks error:', e);
    return res.status(500).json({ ok: false });
  }
});

/* ------------------------------------------------------------------
 * Public menu endpoint
 * ------------------------------------------------------------------*/
app.get('/menu', async (req, res) => {
  try {
    console.log('⚙️  /menu handler invoked');
    const { rows } = await pool.query(
      `SELECT id, canonical, display_name, stock_count
         FROM drinks
        ORDER BY display_name`
    );
    console.log('✅ /menu query succeeded, rows:', rows);
    res.json(rows);
  } catch (err) {
    console.error('❌ /menu error:', err);
    // Send the error message back so we can see it in curl
    res.status(500).send(err.message);
  }
});

/* ------------------------------------------------------------------
 * Public direct order endpoint (no WhatsApp/SMS)
 * ------------------------------------------------------------------*/
app.post('/order', async (req, res) => {
  try {
    const { drink, canonical, name, clientId } = req.body || {};
    const DM = readDrinkMap();

    let targetCanonical = canonical;
    let displayName = drink;

    if (!targetCanonical) {
      const cleaned = (drink || '')
        .replace(/['’]/g, '')
        .replace(/[^\w\s]/g, '')
        .trim()
        .toLowerCase();
      const mapping = DM[cleaned] || Object.values(DM).find(e =>
        cleaned.includes(e.canonical.toLowerCase()) ||
        cleaned.includes(e.display.toLowerCase())
      );
      if (!mapping) {
        return res.status(400).json({ ok: false, error: 'Invalid drink' });
      }
      targetCanonical = mapping.canonical;
      displayName = mapping.display || targetCanonical;
    } else {
      const mapping = Object.values(DM).find(e => e.canonical === targetCanonical) || DM[targetCanonical.toLowerCase()];
      displayName = mapping?.display || targetCanonical;
    }

    // Stock check
    const stockRes = await pool.query(
      'SELECT id, stock_count FROM drinks WHERE canonical = $1',
      [targetCanonical]
    );
    const drinkRecord = stockRes.rows[0] || {};
    if ((drinkRecord.stock_count || 0) <= 0) {
      return res.status(409).json({ ok: false, error: 'Out of stock' });
    }

    // Enqueue and decrement stock
    const order = {
      id: Date.now(),
      from: 'web',
      name: name || 'Web',
      cocktail: targetCanonical,
      displayName,
      createdAt: Date.now(),
      clientId: clientId || null
    };
    queue.push(order);
    await pool.query(
      'UPDATE drinks SET stock_count = GREATEST(stock_count - 1, 0) WHERE id = $1',
      [drinkRecord.id]
    );
    queue.sort((a, b) => a.createdAt - b.createdAt);
    console.log(`✅ New web order: ${displayName} (${targetCanonical}) by ${order.name}`);
    // Notify admins about new web order
    try {
      if (ADMIN_NUMBERS.length) {
        const adminMsg = `🆕 New Web order: ${displayName} (${targetCanonical}) by ${order.name}`;
        await Promise.allSettled(ADMIN_NUMBERS.map(n => sendWhatsApp(n, adminMsg)));
      }
    } catch (e) { if (DEBUG) console.log('Admin notify error:', e.message); }
    // Broadcast SSE event
    try { broadcast('order_new', { id: order.id, cocktail: order.cocktail, displayName: order.displayName, source: 'web' }); } catch {}
    return res.json({ ok: true, id: order.id });
  } catch (err) {
    console.error('❌ /order error:', err);
    return res.status(500).json({ ok: false, error: 'Internal error' });
  }
});

/* ------------------------------------------------------------------
 * Seed drinks, then start server
 * ------------------------------------------------------------------*/
(async () => {
  try {
    await seedDrinks();
    await ensureSubscriptionTable();
  } catch (err) {
    console.error('Fatal error during drink-seeding:', err);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();