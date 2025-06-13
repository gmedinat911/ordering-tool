-- migrations/0002_seed_drinks.sql
-- Seed the drinks table with initial menu items from drinks.json

INSERT INTO drinks (canonical, display_name)
VALUES
  ('Tommys Margarita',   'Tommy’s Glow'),
  ('Regular Mojito',      'Mint Condition Mojito'),
  ('Blueberry Mojito',    'Blue Breeze Mojito'),
  ('Paloma',              'Paloma Paradise'),
  ('Cosmopolitan',        'Cosmo Crush'),
  ('Espresso Martini',    'Espresso Chilltini')
ON CONFLICT (canonical) DO NOTHING;
