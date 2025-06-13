require('dotenv').config();
const pool = require('./db');
const DRINK_MAP = require('./drinks.json');

async function seedDrinks() {
  console.log('Seeding drinks…');
  const client = await pool.connect();
  try {
    for (let { canonical, display } of Object.values(DRINK_MAP)) {
      await client.query(
        `INSERT INTO drinks (canonical, display_name)
         VALUES ($1, $2)
         ON CONFLICT (canonical) DO UPDATE
           SET display_name = EXCLUDED.display_name`,
        [canonical, display]
      );
      console.log(`  ✓ ${display}`);
    }
  } finally {
    client.release();
  }
}

if (require.main === module) {
  seedDrinks()
    .then(() => {
      console.log('Seeding complete.');
      return pool.end();
    })
    .catch(err => {
      console.error('Seeding error:', err);
      process.exit(1);
    });
}

module.exports = seedDrinks;