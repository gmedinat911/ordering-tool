require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

// --- PostgreSQL Setup ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Load drink mapping from external JSON file
// (used only for seeding or fallback fuzzy lookup)
const DRINK_MAP = require(path.join(__dirname, 'drinks.json'));

const seedDrinks = require('./seedDrinks');

const app = express();
const port = process.env.PORT || 3000;
const DEBUG = /^true$/i.test(process.env.DEBUG || 'true');

app.use(cors());
app.use(bodyParser.json());

// --- Auth Helpers ---
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

// --- WhatsApp Helper ---
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

// --- Database Functions ---
async function insertOrder({ from, firstName, drinkId, displayName }) {
  const res = await pool.query(
    `INSERT INTO orders(from_number, first_name, drink_id, display_name)
     VALUES($1,$2,$3,$4) RETURNING id, created_at`,
    [from, firstName, drinkId, displayName]
  );
  return res.rows[0];
}

async function listOrders() {
  const res = await pool.query(
    `SELECT o.id, o.from_number AS from, o.first_name, d.display_name, o.created_at
     FROM orders o
     JOIN drinks d ON o.drink_id = d.id
     WHERE o.status = 'pending'
     ORDER BY o.created_at`
  );
  return res.rows;
}

async function serveOrder(id) {
  const res = await pool.query(
    `UPDATE orders
     SET status = 'served', served_at = now()
     WHERE id = $1 AND status = 'pending'
     RETURNING *`,
    [id]
  );
  return res.rows[0];
}

// --- Routes ---

// Healthcheck
app.get('/health', (req, res) => res.send('✅ Server is alive'));

// Login route (frontend auth)
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

// Admin middleware (WhatsApp commands)
async function adminHandler(req, res, next) {
  try {
    const message = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const from = message?.from;
    const text = (message?.text?.body || '').trim();
    if (!ADMIN_NUMBERS.includes(from)) return next();
    const lower = text.toLowerCase().trim();

    // List queue
    if (lower === 'queue') {
      const orders = await listOrders();
      if (!orders.length) {
        await sendWhatsApp(from, '📭 Queue is empty.');
      } else {
        const summary = orders
          .map((o, i) => `#${i + 1} • ${o.first_name} → ${o.display_name}`)
          .join('\n');
        await sendWhatsApp(
          from,
          `📋 Current orders (${orders.length}):\n${summary}\n\nReply with a number to mark done.`
        );
      }
      return res.sendStatus(200);
    }

    // Clear queue
    if (lower === 'clear') {
      await pool.query(`UPDATE orders SET status='cancelled' WHERE status='pending'`);
      await sendWhatsApp(from, '🗑️ Queue cleared.');
      return res.sendStatus(200);
    }

    // Serve specific order
    const idx = parseInt(lower, 10);
    if (!isNaN(idx)) {
      const orders = await listOrders();
      if (idx < 1 || idx > orders.length) {
        await sendWhatsApp(from, `❌ No order #${idx}.`);
      } else {
        const order = orders[idx - 1];
        await serveOrder(order.id);
        await sendWhatsApp(order.from, `🍸 Your "${order.display_name}" is ready!`);
        await sendWhatsApp(from, `✅ Order #${idx} served.`);
      }
      return res.sendStatus(200);
    }

    // Unknown admin command
    return next();
  } catch (err) {
    console.error('Admin handler error:', err);
    return res.sendStatus(500);
  }
}

// Webhook (main)
app.post('/webhook', adminHandler, async (req, res) => {
  const value = req.body.entry?.[0]?.changes?.[0]?.value;
  if (!value?.messages?.[0]) return res.sendStatus(200);

  const message = value.messages[0];
  const contact = value.contacts?.[0];
  const from = message.from;
  const fullName = contact?.profile?.name || '';
  const firstName = fullName.split(/\s+/)[0] || from;
  const rawText = (message.text?.body || '').trim();

  // Normalize input
  let stripped = rawText.replace(/^i['’]?d\s+like\s+to\s+order\s+the\s+/i, '').trim();
  let cleaned = stripped.replace(/['’]/g, '').replace(/[!?.。，,]+$/g, '').trim();

  // Map to drink
  const key = cleaned.toLowerCase();
  const mapping =
    DRINK_MAP[key] ||
    (await pool.query(`SELECT id, canonical FROM drinks WHERE LOWER(canonical)=LOWER($1)`, [cleaned]))
      .rows[0];
  if (!mapping) {
    await sendWhatsApp(
      from,
      `❌ Invalid order \"${stripped}\". Please check the menu at: https://tinyurl.com/53bmccax`
    );
    return res.sendStatus(200);
  }

  // Insert order into DB
  const { id } = await insertOrder({
    from,
    firstName,
    drinkId: mapping.id,
    displayName: stripped,
  });

  console.log(`✅ New order #${id} from ${from}: ${stripped}`);
  await sendWhatsApp(
    from,
    `👨‍🍳 Hi ${firstName}, we received your order for "${stripped}". We're preparing it now!`
  );

  return res.sendStatus(200);
});

// Protected API endpoints
app.get('/queue', verifyJWT, async (req, res) => {
  const orders = await listOrders();
  res.json(orders);
});

app.post('/clear', verifyJWT, async (req, res) => {
  await pool.query(`UPDATE orders SET status='cancelled' WHERE status='pending'`);
  res.send('Queue cleared');
});

app.post('/done', verifyJWT, async (req, res) => {
  const { id } = req.body;
  const order = await serveOrder(id);
  if (!order) return res.status(404).send('Order not found');
  await sendWhatsApp(order.from_number, `🍸 Your "${order.display_name}" is ready!`);
  res.send('Done');
});

const seedDrinks = require('./seedDrinks');

// Seed drinks then start server
(async () => {
  try {
    await seedDrinks();
  } catch (err) {
    console.error('Fatal error during drink-seeding:', err);
    process.exit(1);
  }

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();
