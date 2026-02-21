const axios = require('axios');

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

async function sendTelegram(text) {
  if (!TOKEN || !CHAT_ID) throw new Error('Telegram credentials not configured');

  const url = `https://api.telegram.org/bot${TOKEN}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (err) {
    const msg = err.response?.data?.description || err.message;
    throw new Error(`Telegram error: ${msg}`);
  }
}

module.exports = { sendTelegram };
