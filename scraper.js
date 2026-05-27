const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const SESSION_FILE = path.join(__dirname, 'session.json');

let loginBrowser = null;   // visible — used only for login
let workBrowser = null;    // headless — used for all scraping
let sharedContext = null;

function parseEuropeanPrice(text) {
  if (!text) return null;
  let normalized = text.replace(/\.(\d{3})/g, '$1').replace(',', '.');
  const numbers = normalized.match(/\d+\.?\d*/g);
  if (!numbers) return null;
  const price = parseFloat(numbers[0]);
  return isNaN(price) ? null : price;
}

function extractUrlPrice(url) {
  try {
    const decoded = decodeURIComponent(url);
    const matches = [...decoded.matchAll(/EUR[\s+]([\d.]+)/g)];
    if (matches.length >= 2) return parseFloat(matches[1][1]);
  } catch(_) {}
  return null;
}

async function initialize() {
  if (sharedContext) return sharedContext;

  let storageState = null;
  if (fs.existsSync(SESSION_FILE)) {
    try {
      storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      log.info('Session loaded from disk');
    } catch(_) {}
  }

  // Check if saved session is valid using a quick headless test
  if (storageState) {
    const testBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'] });
    const testCtx = await testBrowser.newContext({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36', storageState });
    await testCtx.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
    const testPage = await testCtx.newPage();
    try {
      await testPage.goto('https://www.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 15000 });
      await testPage.waitForTimeout(2000);
      const loggedIn = await testPage.evaluate(() => {
        const html = document.body?.innerHTML || '';
        return html.includes('sign-out') || html.includes('signOut') || html.includes('myAliexpress') ||
               !!document.querySelector('[class*="account--menuItem"]') ||
               !!document.querySelector('[class*="UserModule--menuItem"]');
      });
      await testPage.close();
      await testCtx.close();
      await testBrowser.close();

      if (loggedIn) {
        log.success('Session valid — launching headless browser');
        workBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
        sharedContext = await workBrowser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          locale: 'it-IT',
          storageState,
        });
        await sharedContext.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
        return sharedContext;
      }
      log.warn('Saved session expired — need to re-login');
    } catch(e) {
      await testPage.close().catch(() => {});
      await testCtx.close().catch(() => {});
      await testBrowser.close().catch(() => {});
      log.warn('Session check failed — need to re-login');
    }
  }

  // Need manual login — open visible browser
  log.info('Opening browser for manual login…');
  console.log('\n  ╔══════════════════════════════════════════════════╗');
  console.log('  ║  Please log into AliExpress in the browser       ║');
  console.log('  ║  Solve any CAPTCHA, then log in normally.        ║');
  console.log('  ║  The window will close automatically once done.  ║');
  console.log('  ╚══════════════════════════════════════════════════╝\n');

  loginBrowser = await chromium.launch({ headless: false, args: ['--disable-blink-features=AutomationControlled', '--no-sandbox', '--start-maximized'] });
  const loginCtx = await loginBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
  });
  await loginCtx.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
  const loginPage = await loginCtx.newPage();
  await loginPage.goto('https://login.aliexpress.com/?return_url=https://www.aliexpress.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Wait up to 5 minutes for manual login
  await loginPage.waitForFunction(
    () => !window.location.href.includes('login.aliexpress') && !window.location.href.includes('/login'),
    { timeout: 300000, polling: 1000 }
  );
  await loginPage.waitForTimeout(2000);
  log.success('Logged in! Saving session…');

  // Save session state
  const newState = await loginCtx.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(newState));
  log.success('Session saved — future restarts will not require login');

  await loginPage.close();
  await loginCtx.close();
  await loginBrowser.close();
  loginBrowser = null;

  // Now launch headless work browser with the fresh session
  workBrowser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage'] });
  sharedContext = await workBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    storageState: newState,
  });
  await sharedContext.addInitScript("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})");
  return sharedContext;
}

async function scrapeProduct(url) {
  const ctx = await initialize();
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    try {
      await page.waitForSelector('[class*="price-default--current"], [class*="uniform-banner-box-price"]', { timeout: 10000 });
    } catch(_) {}
    await page.waitForTimeout(1500);

    // Dismiss popups
    for (const sel of ['[class*="newUser"] [class*="close"]', '[class*="coupon"] [class*="close"]', '[class*="popup"] [class*="close"]', 'button[class*="close"]']) {
      try { const btn = await page.$(sel); if (btn) { await btn.click(); await page.waitForTimeout(200); } } catch(_) {}
    }
    await page.keyboard.press('Escape');

    const data = await page.evaluate(() => {
      let priceText = '';
      const spans = document.querySelectorAll('span[class*="price-default--current"], span[class*="price--current"]');
      for (const el of spans) {
        if (/original|Wrap/i.test(el.className || '')) continue;
        const t = el.innerText?.trim();
        if (t && /\d+[.,]\d{2}/.test(t) && t.length < 20) { priceText = t; break; }
      }

      let title = '';
      for (const sel of ['h1[class*="title"]', '[class*="product-title-text"]', '[class*="title--wrap"]', 'h1']) {
        const el = document.querySelector(sel);
        if (el?.innerText?.trim()?.length > 5) { title = el.innerText.trim(); break; }
      }

      let imageUrl = '';
      for (const sel of ['[class*="magnifier--image"]', '[class*="magnifier"] img', 'img[src*="aliexpress-media"]', 'img[src*="alicdn"]']) {
        const el = document.querySelector(sel);
        if (el?.src && !el.src.startsWith('data:')) { imageUrl = el.src; break; }
      }

      const variants = [...new Set(
        [...document.querySelectorAll('[class*="sku-item"] span, [class*="skuProp"] span')]
          .map(el => el.innerText?.trim()).filter(t => t && t.length < 60)
      )];

      return { title, priceText, imageUrl, variants, available: !document.querySelector('[class*="sold-out"]') };
    });

    await page.close();

    const urlPrice = extractUrlPrice(url);
    const domPrice = parseEuropeanPrice(data.priceText);
    const price = urlPrice || domPrice;

    return { title: data.title, price, imageUrl: data.imageUrl, variants: data.variants, available: data.available };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function resetSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  if (sharedContext) { await sharedContext.close().catch(() => {}); sharedContext = null; }
  if (workBrowser) { await workBrowser.close().catch(() => {}); workBrowser = null; }
  log.info('Session reset — will re-login on next scrape');
}

async function closeBrowser() {
  if (workBrowser) await workBrowser.close().catch(() => {});
  workBrowser = null;
  sharedContext = null;
}

module.exports = { scrapeProduct, parseEuropeanPrice, initialize, closeBrowser, resetSession };
