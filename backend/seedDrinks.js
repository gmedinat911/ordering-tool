require('dotenv').config();
const pool = require('./db');
const DRINK_MAP = require('./drinks.json');

const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
const FORCE = /^true$/i.test(process.env.FORCE_SEED || 'false');

async function seedDrinks() {
  const client = await pool.connect();
  try {
    // Step 1: Ensure the table exists
    await client.query(`
      CREATE TABLE IF NOT EXISTS drinks (
        id SERIAL PRIMARY KEY,
        canonical TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL
      )
    `);
    console.log('✅ drinks table ensured.');

    // Step 2: Check for existing data
    const { rows } = await client.query('SELECT COUNT(*) FROM drinks');
    const count = parseInt(rows[0].count, 10);

    if (!FORCE && count > 0) {
      console.log(`ℹ️  Drinks already seeded (${count} rows). Skipping.`);
      return;
    }

    console.log(FORCE ? '⚠️  Force seeding enabled. Updating all entries.' : 'Seeding drinks...');

    let successCount = 0;
    let failCount = 0;

    for (const { canonical, display } of Object.values(DRINK_MAP)) {
      try {
        await client.query(
          `INSERT INTO drinks (canonical, display_name)
           VALUES ($1, $2)
           ON CONFLICT (canonical) DO UPDATE
             SET display_name = EXCLUDED.display_name`,
          [canonical, display]
        );
        if (DEBUG) console.log(`  ✓ ${display}`);
        successCount++;
      } catch (err) {
        console.error(`  ✗ ${display}:`, err.message);
        failCount++;
      }
    }

    console.log(`✅ Seeding complete: ${successCount} inserted/updated, ${failCount} failed.`);
  } catch (err) {
    console.error('❌ Fatal error during seeding:', err);
    throw err;
  } finally {
    client.release();
  }
}

// Run manually: node seedDrinks.js
if (require.main === module) {
  seedDrinks()
    .then(() => {
      console.log('🌱 Done.');
      return pool.end();
    })
    .catch(err => {
      console.error('Seeding failed:', err);
      process.exit(1);
    });
}

module.exports = seedDrinks;