const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const SESSION_FILE = path.join(__dirname, 'session.json');

let loginBrowser = null;
let workBrowser = null;
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
  } catch (_) {}
  return null;
}

async function initialize() {
  if (sharedContext) return sharedContext;

  let storageState = null;
  if (fs.existsSync(SESSION_FILE)) {
    try {
      storageState = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
      log.info('Session loaded from disk');
    } catch (_) {}
  }

  // session validation
  if (storageState) {
    const testBrowser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });

    const testCtx = await testBrowser.newContext({
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      storageState
    });

    const testPage = await testCtx.newPage();

    try {
      await testPage.goto('https://www.aliexpress.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 15000
      });

      const loggedIn = await testPage.evaluate(() => {
        const html = document.body?.innerHTML || '';
        return (
          html.includes('sign-out') ||
          html.includes('myAliexpress') ||
          !!document.querySelector('[class*="account"]')
        );
      });

      await testBrowser.close();

      if (loggedIn) {
        log.success('Session valid — launching headless browser');

        workBrowser = await chromium.launch({
          headless: true,
          args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage"
          ]
        });

        sharedContext = await workBrowser.newContext({
          viewport: { width: 1280, height: 900 },
          userAgent:
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          locale: 'it-IT',
          storageState
        });

        return sharedContext;
      }
    } catch (e) {
      await testBrowser.close().catch(() => {});
    }
  }

  // LOGIN MODE (Render-safe fallback note)
  log.info('Opening browser for manual login…');

  loginBrowser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled"
    ]
  });

  const loginCtx = await loginBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT'
  });

  const loginPage = await loginCtx.newPage();

  await loginPage.goto(
    'https://login.aliexpress.com/?return_url=https://www.aliexpress.com/',
    { waitUntil: 'domcontentloaded', timeout: 20000 }
  );

  await loginPage.waitForFunction(
    () =>
      !window.location.href.includes('login.aliexpress') &&
      !window.location.href.includes('/login'),
    { timeout: 300000 }
  );

  const newState = await loginCtx.storageState();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(newState));

  await loginBrowser.close();

  // headless runtime
  workBrowser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  sharedContext = await workBrowser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    locale: 'it-IT',
    storageState: newState
  });

  return sharedContext;
}

async function scrapeProduct(url) {
  const ctx = await initialize();
  const page = await ctx.newPage();

  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 25000
    });

    await page.waitForTimeout(1500);

    const data = await page.evaluate(() => {
      let priceText = '';

      const spans = document.querySelectorAll(
        'span[class*="price-default--current"], span[class*="price--current"]'
      );

      for (const el of spans) {
        const t = el.innerText?.trim();
        if (t && /\d+[.,]\d{2}/.test(t)) {
          priceText = t;
          break;
        }
      }

      let title =
        document.querySelector('h1')?.innerText?.trim() || '';

      let imageUrl =
        document.querySelector('img')?.src || '';

      return {
        title,
        priceText,
        imageUrl,
        available: true
      };
    });

    await page.close();

    const price =
      extractUrlPrice(url) || parseEuropeanPrice(data.priceText);

    return {
      title: data.title,
      price,
      imageUrl: data.imageUrl,
      available: data.available
    };
  } catch (err) {
    await page.close().catch(() => {});
    throw err;
  }
}

async function resetSession() {
  if (fs.existsSync(SESSION_FILE)) fs.unlinkSync(SESSION_FILE);
  if (sharedContext) await sharedContext.close();
  if (workBrowser) await workBrowser.close();
  sharedContext = null;
  workBrowser = null;
}

async function closeBrowser() {
  if (workBrowser) await workBrowser.close();
  sharedContext = null;
  workBrowser = null;
}

module.exports = {
  scrapeProduct,
  parseEuropeanPrice,
  initialize,
  closeBrowser,
  resetSession
};