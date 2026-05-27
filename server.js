require('dotenv').config();
const log = require('./logger');
const express = require('express');
const cors = require('cors');
const db = require('./db');
const { scrapeProduct } = require('./scraper');
const { startScheduler, runAllChecks, checkProduct } = require('./worker');
const { resetSession, initialize } = require('./scraper');

const app = express();
app.use(cors());
app.use(express.json());

// ── GET /api/products ─────────────────────────────────────────────────────────
app.get('/api/products', (req, res) => {
  const products = db.prepare(`
    SELECT p.*,
      (SELECT price FROM price_history WHERE product_id = p.id ORDER BY checked_at ASC LIMIT 1) as lowest_price,
      (SELECT COUNT(*) FROM price_history WHERE product_id = p.id) as check_count
    FROM products p
    ORDER BY p.created_at DESC
  `).all();
  res.json(products);
});

// ── GET /api/products/:id/history ─────────────────────────────────────────────
app.get('/api/products/:id/history', (req, res) => {
  const history = db.prepare(`
    SELECT price, checked_at FROM price_history
    WHERE product_id = ?
    ORDER BY checked_at ASC
    LIMIT 100
  `).all(req.params.id);
  res.json(history);
});

// ── POST /api/products/preview ────────────────────────────────────────────────
// Fetch product info + variants before adding
app.post('/api/products/preview', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  try {
    const data = await scrapeProduct(url);
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Failed to fetch product: ${err.message}` });
  }
});

// ── POST /api/products ────────────────────────────────────────────────────────
app.post('/api/products', async (req, res) => {
  const { url, variantLabel, targetPrice } = req.body;
  if (!url) return res.status(400).json({ error: 'URL required' });

  // Check for duplicate
  const existing = db.prepare('SELECT id FROM products WHERE url = ?').get(url);
  if (existing) return res.status(409).json({ error: 'Product already being tracked' });

  try {
    const data = await scrapeProduct(url);
    const cleanUrl = url.split('?')[0].split('#')[0];

    const result = db.prepare(`
      INSERT INTO products (url, clean_url, title, image_url, variant_label, current_price, target_price, last_checked)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `).run(url, cleanUrl, data.title, data.imageUrl, variantLabel || null, data.price, targetPrice || null);

    if (data.price) {
      db.prepare('INSERT INTO price_history (product_id, price) VALUES (?, ?)').run(result.lastInsertRowid, data.price);
    }

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
    log.success(`Product added: ${product.title?.slice(0,45)}`);
    res.json(product);
  } catch (err) {
    res.status(500).json({ error: `Failed to add product: ${err.message}` });
  }
});

// ── PATCH /api/products/:id ───────────────────────────────────────────────────
app.patch('/api/products/:id', (req, res) => {
  const { targetPrice, active, variantLabel } = req.body;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE products SET
      target_price = COALESCE(?, target_price),
      active = COALESCE(?, active),
      variant_label = COALESCE(?, variant_label)
    WHERE id = ?
  `).run(targetPrice ?? null, active ?? null, variantLabel ?? null, req.params.id);

  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

// ── DELETE /api/products/:id ──────────────────────────────────────────────────
app.delete('/api/products/:id', (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  db.prepare('DELETE FROM price_history WHERE product_id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── POST /api/products/:id/refresh ───────────────────────────────────────────
app.post('/api/products/:id/refresh', async (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
  if (!product) return res.status(404).json({ error: 'Not found' });

  try {
    await checkProduct(product);
    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id);
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/refresh-all ─────────────────────────────────────────────────────
app.post('/api/refresh-all', async (req, res) => {
  res.json({ message: 'Refresh started' });
  runAllChecks(); // run async, don't await
});

// ── POST /api/reset-session ──────────────────────────────────────────────────
app.post('/api/reset-session', async (req, res) => {
  await resetSession();
  res.json({ message: 'Session reset — will re-login on next scrape' });
});

// ── GET /api/stats ────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as n FROM products WHERE active=1').get().n;
  const drops = db.prepare(`
    SELECT COUNT(*) as n FROM products
    WHERE active=1 AND previous_price IS NOT NULL AND current_price < previous_price
  `).get().n;
  const checks = db.prepare('SELECT COUNT(*) as n FROM price_history').get().n;
  const lastCheck = db.prepare('SELECT MAX(last_checked) as t FROM products').get().t;
  res.json({ total, drops, checks, lastCheck });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, async () => {
  log.success(`AliTracker API running on http://localhost:${PORT}`);
  // Initialize browser and login before starting scheduler
  await initialize();
  startScheduler();
});
