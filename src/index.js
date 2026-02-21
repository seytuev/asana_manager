require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { sendTelegram } = require('./telegram');
const { formatEvent } = require('./formatter');

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.ASANA_WEBHOOK_SECRET || '';

// ── Проверка подписи ──────────────────────────────────────────────────────────
function checkSignature(req) {
  if (!SECRET) return true;
  const sig = req.headers['x-hook-signature'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
  return hmac === sig;
}

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Asana→Telegram Bot', uptime: Math.floor(process.uptime()) + 's' });
});

// ── Webhook ───────────────────────────────────────────────────────────────────
app.post('/webhook', async (req, res) => {
  // Asana handshake при создании вебхука
  const handshake = req.headers['x-hook-secret'];
  if (handshake) {
    console.log('[HANDSHAKE] Asana webhook подтверждён');
    return res.set('x-hook-secret', handshake).status(200).send();
  }

  // Проверка подписи
  if (!checkSignature(req)) {
    console.warn('[WARN] Неверная подпись запроса');
    return res.status(401).send('Unauthorized');
  }

  const events = req.body?.events || [];
  console.log(`[INFO] Получено событий: ${events.length}`);

  // Отвечаем Asana немедленно, обрабатываем в фоне
  res.status(200).send();

  for (const event of events) {
    try {
      const text = await formatEvent(event);
      if (text) {
        await sendTelegram(text);
        console.log(`[OK] Отправлено: [${event.action}] ${event.resource?.resource_type}`);
      }
    } catch (err) {
      console.error(`[ERR] Ошибка обработки события: ${err.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 Webhook URL: ${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/webhook\n`);

  const vars = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'ASANA_ACCESS_TOKEN', 'ASANA_PROJECT_GID', 'ASANA_WEBHOOK_SECRET', 'PUBLIC_URL'];
  const missing = vars.filter(v => !process.env[v] || process.env[v].startsWith('your_'));
  if (missing.length) {
    console.warn('⚠️  Не заполнены переменные окружения:', missing.join(', '));
  } else {
    console.log('✅ Все переменные окружения заданы');
  }
});
