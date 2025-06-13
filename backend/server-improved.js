require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');

const DRINK_MAP = require(path.join(__dirname, 'drinks.json'));
const seedDrinks = require('./seedDrinks');
const pool = require('./db');

const app = express();
const port = process.env.PORT || 3000;
const DEBUG = /^true$/i.test(process.env.DEBUG || 'true');

let queue = [];

app.use(cors());
app.use(bodyParser.json());

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

// Ping and health check routes
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

// Login route
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== DASHBOARD_PASS) return res.status(401).send('Unauthorized');
  const token = signToken();
  return res.json({ token });
});

// WhatsApp helpers
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

// Admin handler
async function adminHandler(req, res, next) {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = (message?.text?.body || '').trim();
    if (!ADMIN_NUMBERS.includes(from)) return next();
    const lower = text.toLowerCase().trim();

    if (lower === 'queue') {
      const summary = queue.length
        ? queue.map((o, i) => `#${i + 1} • ${o.name} → ${o.cocktail}`).join('\n')
        : '📭 Queue is empty.';
      await sendWhatsApp(from, `📋 ${summary}`);
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

    if (DEBUG) console.log(`⚠️ Unknown admin text: "${text}"`);
    return next();
  } catch (err) {
    console.error('Admin handler error:', err);
    return res.sendStatus(500);
  }
}

// WhatsApp webhook
app.post('/webhook', adminHandler, async (req, res) => {
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  const message = value?.messages?.[0];
  const contact = value?.contacts?.[0];
  if (!message) return res.sendStatus(200);

  const from = message.from;
  const fullName = contact?.profile?.name || '';
  const firstName = fullName.split(/\s+/)[0] || from;
  const rawText = (message.text?.body || '').trim();

  let stripped = rawText.replace(/^i['’]?d\s+like\s+to\s+order\s+the\s+/i, '').trim();
  let cleaned = stripped.replace(/['’]/g, '').replace(/[!?.。，,]+$/g, '').trim();
  if (cleaned.toLowerCase().includes('take a minute')) return res.sendStatus(200);

  const key = cleaned.toLowerCase();
  const mapping = DRINK_MAP[key] || Object.values(DRINK_MAP).find(e => key.includes(e.canonical.toLowerCase()));

  if (!mapping) {
    await sendWhatsApp(from, `❌ Invalid order \"${stripped}\". \n Please check the menu at: https://tinyurl.com/53bmccax`);
    return res.sendStatus(200);
  }

  const canonical = mapping.canonical;
  queue.push({ id: Date.now(), from, name: firstName, cocktail: canonical, displayName: stripped, createdAt: Date.now() });
  queue.sort((a, b) => a.createdAt - b.createdAt);

  await sendWhatsApp(from, `👨‍🍳 Hi ${firstName}, we received your order for "${stripped}". We're preparing it now!`);
  return res.sendStatus(200);
});

// Dashboard API
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

// Startup logic
(async () => {
  try {
    await seedDrinks();
  } catch (err) {
    console.error('🚨 Failed to seed drinks on startup:', err);
    if (process.env.NODE_ENV === 'production') process.exit(1);
  }

  app.listen(port, () => {
    console.log(`🚀 Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();