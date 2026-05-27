const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const log = require('./logger');

const SESSION_FILE = path.join(__dirname, 'session.json');

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

  // ❌ IMPORTANT RULE:
  // Render cannot do manual login.
  // If no session exists → fail fast instead of crashing server.
  if (!storageState) {
    throw new Error(
      "No session found. Run login locally and upload session.json."
    );
  }

  // Create headless browser ONLY (Render safe)
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

      const title =
        document.querySelector('h1')?.innerText?.trim() || '';

      const imageUrl =
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
  if (sharedContext) await sharedContext.close().catch(() => {});
  if (workBrowser) await workBrowser.close().catch(() => {});
  sharedContext = null;
  workBrowser = null;
  log.info('Session reset');
}

async function closeBrowser() {
  if (workBrowser) await workBrowser.close().catch(() => {});
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