const log = require('./logger');
const axios = require('axios');

async function sendDiscordAlert({ product, oldPrice, newPrice, changeType }) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || webhookUrl.includes('YOUR_WEBHOOK')) return;

  const isDropped = newPrice < (oldPrice || newPrice);
  const direction = oldPrice === null ? '📌 Now tracking' : isDropped ? '🔻 Price dropped' : '🔺 Price increased';
  const color = oldPrice === null ? 0x3498DB : isDropped ? 0x2ECC71 : 0xE74C3C;

  let changeStr = '';
  if (oldPrice !== null) {
    const diff = newPrice - oldPrice;
    const pct = ((diff / oldPrice) * 100).toFixed(1);
    changeStr = ` (${diff > 0 ? '+' : ''}€${Math.abs(diff).toFixed(2)} / ${pct}%)`;
  }

  const variantLabel = product.variant_label ? ` — ${product.variant_label}` : '';

  const embed = {
    embeds: [{
      title: `${direction}${changeStr}`,
      description: `**${product.title}${variantLabel}**`,
      color,
      fields: [
        oldPrice !== null ? { name: 'Before', value: `~~€${oldPrice.toFixed(2)}~~`, inline: true } : null,
        { name: 'After', value: `**€${newPrice.toFixed(2)}**`, inline: true },
        { name: 'Link', value: product.url, inline: false },
      ].filter(Boolean),
      thumbnail: product.image_url ? { url: product.image_url } : undefined,
      footer: { text: `AliTracker • ${new Date().toLocaleString('it-IT')}` },
    }]
  };

  try {
    await axios.post(webhookUrl, embed, { timeout: 10000 });
    log.discord(`Notification sent: ${product.title?.slice(0,45)}`);
  } catch (err) {
    log.error(`Discord failed: ${err.message}`);
  }
}

module.exports = { sendDiscordAlert };
