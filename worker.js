const cron = require('node-cron');
const db = require('./db');
const { scrapeProduct } = require('./scraper');
const { sendDiscordAlert } = require('./discord');
const log = require('./logger');

let isRunning = false;

async function checkProduct(product) {
  try {
    const data = await scrapeProduct(product.url);
    if (!data.price) { log.warn(`Could not read price for: ${product.title || product.id}`); return; }

    const now = new Date().toISOString();
    const oldPrice = product.current_price;
    const newPrice = data.price;
    const priceChanged = oldPrice !== null && Math.abs(newPrice - oldPrice) > 0.001;
    const isFirst = oldPrice === null;
    const shortTitle = (data.title || product.title || '').slice(0, 45);

    db.prepare(`UPDATE products SET title=?, image_url=?, current_price=?, previous_price=?, available=?, last_checked=? WHERE id=?`)
      .run(data.title || product.title, data.imageUrl || product.image_url, newPrice, oldPrice, data.available ? 1 : 0, now, product.id);
    db.prepare(`INSERT INTO price_history (product_id, price, checked_at) VALUES (?, ?, ?)`)
      .run(product.id, newPrice, now);

    if (isFirst) {
      log.success(`Tracking started: ${shortTitle} — €${newPrice.toFixed(2)}`);
      await sendDiscordAlert({ product: { ...product, title: data.title, image_url: data.imageUrl }, oldPrice: null, newPrice });
    } else if (priceChanged) {
      const diff = newPrice - oldPrice;
      const pct = ((diff / oldPrice) * 100).toFixed(1);
      if (newPrice < oldPrice) {
        log.drop(`Price dropped: ${shortTitle} €${oldPrice.toFixed(2)} → €${newPrice.toFixed(2)} (${pct}%)`);
      } else {
        log.rise(`Price increased: ${shortTitle} €${oldPrice.toFixed(2)} → €${newPrice.toFixed(2)} (+${pct}%)`);
      }
      await sendDiscordAlert({ product: { ...product, title: data.title, image_url: data.imageUrl }, oldPrice, newPrice });
      db.prepare(`UPDATE products SET previous_price=? WHERE id=?`).run(oldPrice, product.id);
    } else {
      log.check(`No change: ${shortTitle} — €${newPrice.toFixed(2)}`);
    }

    // Target price alert
    if (product.target_price && newPrice <= product.target_price && (!oldPrice || oldPrice > product.target_price)) {
      log.price(`🎯 TARGET HIT: ${shortTitle} is now €${newPrice.toFixed(2)} (target: €${product.target_price.toFixed(2)})`);
    }
  } catch (err) {
    log.error(`Check failed for product ${product.id}: ${err.message}`);
  }
}

async function runAllChecks() {
  if (isRunning) { log.warn('Check already in progress, skipping'); return; }
  isRunning = true;
  log.divider();
  log.info(`Starting price checks — ${new Date().toLocaleString('it-IT')}`);
  const products = db.prepare('SELECT * FROM products WHERE active = 1').all();
  log.info(`${products.length} active product(s)`);
  for (const product of products) await checkProduct(product);
  isRunning = false;
  log.success('All checks complete');
}

function startScheduler() {
  const mins = parseInt(process.env.CHECK_INTERVAL_MINUTES || '60');
  log.info(`Scheduler started — checking every ${mins} minutes`);
  runAllChecks();
  cron.schedule(`*/${mins} * * * *`, runAllChecks);
}

module.exports = { startScheduler, runAllChecks, checkProduct };
