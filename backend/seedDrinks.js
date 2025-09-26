require('dotenv').config();
const pool = require('./db');
const DRINK_MAP = require('./drinks.json');

const DEBUG = /^true$/i.test(process.env.DEBUG || 'false');
const FORCE = /^true$/i.test(process.env.FORCE_SEED || 'false');

async function seedDrinks() {
  const client = await pool.connect();
  try {
    // At the top, add description and image_url columns
    await client.query(`
      ALTER TABLE drinks
        ADD COLUMN IF NOT EXISTS stock_count INTEGER NOT NULL DEFAULT 20,
        ADD COLUMN IF NOT EXISTS description TEXT,
        ADD COLUMN IF NOT EXISTS image_url TEXT;
    `);
    // Step 1: Ensure the table exists with description and image_url
    await client.query(`
      CREATE TABLE IF NOT EXISTS drinks (
        id SERIAL PRIMARY KEY,
        canonical TEXT UNIQUE NOT NULL,
        display_name TEXT NOT NULL,
        stock_count INTEGER NOT NULL DEFAULT 20,
        description TEXT,
        image_url TEXT
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

    console.log(FORCE ? '⚠️  Force seeding enabled. Updating display names only.' : 'Seeding drinks...');

    let successCount = 0;
    let failCount = 0;

    for (const { canonical, display } of Object.values(DRINK_MAP)) {
      try {
        const defaultDescription = `A signature cocktail: ${display}`;
        const defaultImage = `https://source.unsplash.com/600x400/?cocktail,${encodeURIComponent(display)}`;
        await client.query(
          `INSERT INTO drinks (canonical, display_name, stock_count, description, image_url)
           VALUES ($1, $2, 20, $3, $4)
           ON CONFLICT (canonical) DO UPDATE
             SET display_name = EXCLUDED.display_name,
                 description = EXCLUDED.description,
                 image_url = EXCLUDED.image_url`,
          [canonical, display, defaultDescription, defaultImage]
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