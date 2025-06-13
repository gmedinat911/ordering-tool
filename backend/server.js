require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const pool = require('./db');


// Load drink mapping from external JSON file
const DRINK_MAP = require(path.join(__dirname, 'drinks.json'));

// PostgreSQL connection pool
// Seeder for drinks.json
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
// Lightweight health ping
app.get('/ping', (req, res) => res.send('✅ Server is alive'));

// Full health check with DB
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
    // Log only valid commands
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
     // Not a recognized admin command—pass it to customer flow
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
  // 2) Normalize apostrophes and remove
  let cleaned = stripped.replace(/['’]/g, '').trim();
  // 3) Remove trailing punctuation
  cleaned = cleaned.replace(/[!?.。，,]+$/g, '').trim();
  if (DEBUG) console.log('🔍 Cleaned text:', cleaned);

  // 4) Ignore tutorial multi-line messages
  if (cleaned.toLowerCase().includes('take a minute right now to send your first message')) {
    if (DEBUG) console.log('ℹ️ Ignored tutorial message');
    return res.sendStatus(200);
  }

  // 5) Map to canonical names loaded from drinks.json
   const key = cleaned.toLowerCase();
  const mapping = DRINK_MAP[key] || Object.values(DRINK_MAP).find(e => key.includes(e.canonical.toLowerCase()));
  if (!mapping) {
    if (DEBUG) console.log(`❌ Invalid order from ${from}: "${cleaned}"`);
    await sendWhatsApp(from, `❌ Invalid order \"${stripped}\". \n Please check the menu at: https://tinyurl.com/53bmccax `);
    return res.sendStatus(200);
  }
  const canonical = mapping.canonical;
  if (DEBUG) console.log(`✅ Parsed drink: display='${stripped}' → canonical='${canonical}'`);

  // 5) Queue and acknowledge.
  queue.push({ id: Date.now(), from, name: firstName, cocktail: canonical, displayName: stripped, createdAt: Date.now() });
  queue.sort((a, b) => a.createdAt - b.createdAt);
  console.log(`✅ New order from ${from}: ${stripped}`);

  await sendWhatsApp(from, `👨‍🍳 Hi ${firstName}, we received your order for "${stripped}". We're preparing it now!`);

  return res.sendStatus(200);
});

/* ------------------------------------------------------------------
 * Queue API (protected by JWT)
 * ------------------------------------------------------------------*/
app.get('/queue', verifyJWT, (req, res) => res.json(queue));
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

/* ------------------------------------------------------------------ */
// Seed drinks, then start server
(async () => {
  try {
    await seedDrinks();
  } catch (err) {
    console.error('Fatal error during drink-seeding:', err);
    process.exit(1);
  }
  (async () => {
  try {
    await seedDrinks(); // auto-runs at boot
  } catch (err) {
    console.error('🚨 Failed to seed drinks on startup:', err);
    // Optional: don't exit in dev
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }

  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();
