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

/* ------------------------------------------------------------------
 * Express setup
 * ------------------------------------------------------------------*/
app.use(cors());
app.use(bodyParser.json());

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
 * WhatsApp admin numbers & helper
 * ------------------------------------------------------------------*/
const ADMIN_NUMBERS = (process.env.ADMIN_NUMBERS || '')
  .split(',')
  .map(n => n.trim())
  .filter(Boolean);

const sendWhatsApp = (to, text) =>
  axios.post(
    `https://graph.facebook.com/v19.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`,
    { messaging_product: 'whatsapp', to, text: { body: text } },
    { headers: { Authorization: `Bearer ${process.env.ACCESS_TOKEN}` } }
  );

/* ------------------------------------------------------------------
 * Admin middleware (WhatsApp commands)
 * ------------------------------------------------------------------*/
async function adminHandler(req, res, next) {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = (message?.text?.body || '').trim();
    if (!ADMIN_NUMBERS.includes(from)) return next();
    const lower = text.toLowerCase().trim();
    if (['queue', 'clear'].includes(lower) || !isNaN(parseInt(lower, 10))) {
      console.log(`👑 Admin cmd by ${from}: ${lower}`);
    }
    if (lower === 'queue') {
      if (!queue.length) {
        await sendWhatsApp(from, '📭 Queue is empty.');
      } else {
        const summary = queue.map((o, i) => `#${i+1} • ${o.name} → ${o.cocktail}`).join('\n');
        await sendWhatsApp(from, `📋 Current orders (${queue.length}):\n${summary}\n\nReply with a number to mark done.`);
      }
      return res.sendStatus(200);
    }
    if (lower === 'clear') {
      queue = [];
      await sendWhatsApp(from, '🗑️ Queue cleared.');
      return res.sendStatus(200);
    }
    const idx = parseInt(lower, 10);
    if (!isNaN(idx)) {
      const pos = idx - 1;
      if (pos < 0 || pos >= queue.length) {
        await sendWhatsApp(from, `❌ No order #${idx}.`);
        return res.sendStatus(200);
      }
      const [order] = queue.splice(pos, 1);
      await sendWhatsApp(order.from, `🍸 Your "${order.displayName}" is ready!`);
      await sendWhatsApp(from, `✅ Order #${idx} served.`);
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
 * Seed drinks, then start server
 * ------------------------------------------------------------------*/
(async () => {
  try {
    await seedDrinks();
  } catch (err) {
    console.error('Fatal error during drink-seeding:', err);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();