require('dotenv').config();
const path = require('path');
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const jwt = require('jsonwebtoken');

// Twilio SDK for outbound SMS
let twilioClient = null;
try {
  const twilio = require('twilio');
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  }
} catch (e) {
  // Allow server to boot even if twilio isn't installed yet
}

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
const port = process.env.SMS_PORT || process.env.PORT || 3001; // default to 3001 to avoid clash
const DEBUG = /^true$/i.test(process.env.DEBUG || 'true');

/* ------------------------------------------------------------------
 * In-memory state (shared semantics with WhatsApp server)
 * ------------------------------------------------------------------*/
let queue = [];
const optOutNumbers = new Set(); // in-memory opt-out registry (consider DB for production)

// Campaign configuration and helpers
const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || '';
const SUPPORT_PHONE = process.env.SUPPORT_PHONE || '';
const MENU_URL = process.env.MENU_URL || '';
const PRIVACY_URL = process.env.PRIVACY_URL || '';

const STOP_KEYWORDS = ['stop','stopall','unsubscribe','cancel','end','quit'];
const HELP_KEYWORDS = ['help','info','support'];
const OPTIN_KEYWORDS = ['start','yes','subscribe','join','unstop'];

function hasKeyword(text, list){
  const t = (text || '').trim().toLowerCase();
  return list.includes(t);
}

function footer(){
  return ' Reply STOP to opt out or HELP for help.';
}

function helpMessage(){
  const parts = [];
  parts.push('Support:');
  if (SUPPORT_EMAIL) parts.push(SUPPORT_EMAIL);
  if (SUPPORT_PHONE) parts.push(SUPPORT_PHONE);
  if (PRIVACY_URL) parts.push(`Privacy: ${PRIVACY_URL}`);
  return `${parts.join(' ')}${footer()}`.trim();
}

/* ------------------------------------------------------------------
 * Express setup
 * ------------------------------------------------------------------*/
app.use(cors());
// Twilio posts application/x-www-form-urlencoded by default
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

/* ------------------------------------------------------------------
 * Auth helpers for dashboard endpoints
 * ------------------------------------------------------------------*/
const JWT_SECRET = process.env.JWT_SECRET || 'change_me';
const DASHBOARD_PASS = process.env.DASHBOARD_PASS;
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
 * Helpers
 * ------------------------------------------------------------------*/
async function sendSMS(to, text) {
  if (!twilioClient) {
    if (DEBUG) console.log('⚠️ Twilio client not configured. SMS to', to, 'would say:', text);
    return;
  }
  const from = process.env.TWILIO_FROM_NUMBER;
  if (!from) throw new Error('Missing TWILIO_FROM_NUMBER');
  return twilioClient.messages.create({ to, from, body: text });
}

function normalizeIncomingText(raw) {
  // 1) Strip polite prefix used by frontend buttons
  let stripped = (raw || '').trim().replace(/^i['’]?d\s+like\s+to\s+order\s+the\s+/i, '').trim();
  // 2) Normalize and clean input (remove apostrophes, emojis, punctuation)
  let cleaned = stripped.replace(/['’]/g, '').trim();
  cleaned = cleaned.replace(/[^\w\s]/g, '').trim();
  return { stripped, cleaned };
}

function resolveDrink(cleanedKey) {
  const DM = readDrinkMap();
  const key = cleanedKey.toLowerCase();
  const mapping = DM[key]
    || Object.values(DM).find(e =>
         key.includes(e.canonical.toLowerCase())
      || key.includes(e.display.toLowerCase())
    );
  return mapping || null;
}

/* ------------------------------------------------------------------
 * Health & menu
 * ------------------------------------------------------------------*/
app.get('/ping', (req, res) => res.send('✅ SMS Server is alive'));

// Login route so dashboard can obtain a JWT
app.post('/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== DASHBOARD_PASS) {
    if (DEBUG) console.log('❌ SMS server login failed');
    return res.status(401).send('Unauthorized');
  }
  const token = signToken();
  if (DEBUG) console.log('✅ SMS server login success – JWT issued');
  return res.json({ token });
});

app.get('/menu', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, canonical, display_name, stock_count
         FROM drinks
        ORDER BY display_name`
    );
    res.json(rows);
  } catch (err) {
    console.error('❌ /menu error:', err);
    res.status(500).send(err.message);
  }
});

/* ------------------------------------------------------------------
 * SMS Webhook (e.g., Twilio)
 * - Expects application/x-www-form-urlencoded with fields like From, Body
 * ------------------------------------------------------------------*/
app.post('/sms-webhook', async (req, res) => {
  try {
    const from = (req.body.From || req.body.from || '').trim();
    const body = (req.body.Body || req.body.body || '').trim();

    if (DEBUG) console.log('📩 Incoming SMS from', from, 'text=', body);

    // 0) Keyword handling (STOP/HELP/OPT-IN)
    const lower = (body || '').trim().toLowerCase();
    if (hasKeyword(lower, STOP_KEYWORDS)) {
      optOutNumbers.add(from);
      try { await sendSMS(from, 'You have opted out and will no longer receive messages.'); } catch {}
      return res.sendStatus(200);
    }
    if (hasKeyword(lower, HELP_KEYWORDS)) {
      try { await sendSMS(from, helpMessage()); } catch {}
      return res.sendStatus(200);
    }
    if (hasKeyword(lower, OPTIN_KEYWORDS)) {
      if (optOutNumbers.has(from)) optOutNumbers.delete(from);
      const optInMsg = 'You are opted in to Evening Bar SMS Ordering for order updates only. Message frequency varies.' + footer();
      try { await sendSMS(from, optInMsg); } catch {}
      return res.sendStatus(200);
    }

    // If opted out and message is not an opt-in keyword, do not respond
    if (optOutNumbers.has(from)) {
      if (DEBUG) console.log('⚠️ Message from opted-out number ignored:', from);
      return res.sendStatus(200);
    }

    const { stripped, cleaned } = normalizeIncomingText(body);
    const mapping = resolveDrink(cleaned);
    if (!mapping) {
      if (DEBUG) console.log(`❌ Invalid SMS order from ${from}: "${cleaned}"`);
      const menuLine = MENU_URL ? ` Please check the menu: ${MENU_URL}` : '';
      await sendSMS(from, `Invalid order "${stripped}".${menuLine}` + footer());
      // For Twilio, respond with 200 OK (no TwiML needed if using Messaging Service Webhook)
      return res.sendStatus(200);
    }

    const canonical = mapping.canonical;

    // Stock check
    const stockRes = await pool.query(
      'SELECT id, stock_count FROM drinks WHERE canonical = $1',
      [canonical]
    );
    const drinkRecord = stockRes.rows[0] || {};
    if ((drinkRecord.stock_count || 0) <= 0) {
      await sendSMS(from, `Sorry, "${stripped}" is sold out.` + footer());
      return res.sendStatus(200);
    }

    // Enqueue and decrement stock
    queue.push({ id: Date.now(), from, name: from, cocktail: canonical, displayName: stripped, createdAt: Date.now() });
    await pool.query(
      'UPDATE drinks SET stock_count = GREATEST(stock_count - 1, 0) WHERE id = $1',
      [drinkRecord.id]
    );
    queue.sort((a, b) => a.createdAt - b.createdAt);

    await sendSMS(from, `We received your order for "${stripped}". We are preparing it now.` + footer());
    return res.sendStatus(200);
  } catch (err) {
    console.error('❌ /sms-webhook error:', err);
    return res.sendStatus(200); // Avoid retries storm; log for investigation
  }
});

/* ------------------------------------------------------------------
 * Queue API (protected by JWT) for dashboard reuse
 * ------------------------------------------------------------------*/
app.get('/queue', verifyJWT, (req, res) => {
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
  // optional: notify via SMS that drink is ready
  try { await sendSMS(order.from, `🍸 Your "${order.displayName}" is ready!`); } catch {}
  return res.send('Done');
});

/* ------------------------------------------------------------------
 * Seed drinks, then start server
 * ------------------------------------------------------------------*/
(async () => {
  try {
    await seedDrinks();
  } catch (err) {
    console.error('Fatal error during drink-seeding (SMS server):', err);
    process.exit(1);
  }
  app.listen(port, () => {
    console.log(`🚀 SMS Server running on port ${port}`);
    if (DEBUG) console.log('🛠️ Debugging enabled');
  });
})();
