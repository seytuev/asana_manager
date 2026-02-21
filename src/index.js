require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { sendTelegram } = require('./telegram');
const { formatEvent, setSendFunction } = require('./formatter');

setSendFunction(sendTelegram);

const app = express();

app.use(express.json({
  verify: (req, res, buf) => { req.rawBody = buf; }
}));

const PORT = process.env.PORT || 3000;
const SECRET = process.env.ASANA_WEBHOOK_SECRET || '';

function checkSignature(req) {
  if (!SECRET) return true;
  const sig = req.headers['x-hook-signature'];
  if (!sig) return false;
  const hmac = crypto.createHmac('sha256', SECRET).update(req.rawBody).digest('hex');
  return hmac === sig;
}

app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'Asana→Telegram Bot', uptime: Math.floor(process.uptime()) + 's' });
});

app.post('/webhook', async (req, res) => {
  const handshake = req.headers['x-hook-secret'];
  if (handshake) {
    console.log('[HANDSHAKE] Asana webhook подтверждён');
    return res.set('x-hook-secret', handshake).status(200).send();
  }

  if (!checkSignature(req)) {
    console.warn('[WARN] Неверная подпись запроса');
    return res.status(401).send('Unauthorized');
  }

  const events = req.body?.events || [];
  console.log(`\n[INFO] ===== Получено событий: ${events.length} =====`);

  // Логируем каждое событие полностью
  events.forEach((e, i) => {
    console.log(`[EVENT ${i+1}] action=${e.action} type=${e.resource?.resource_type} gid=${e.resource?.gid} parent_type=${e.parent?.resource_type} parent_gid=${e.parent?.gid} change_field=${e.change?.field} user=${e.user?.name}`);
  });

  res.status(200).send();

  for (const event of events) {
    try {
      const text = await formatEvent(event);
      if (text) {
        await sendTelegram(text);
        console.log(`[OK] Отправлено: [${event.action}] ${event.resource?.resource_type}`);
      }
    } catch (err) {
      console.error(`[ERR] Ошибка: ${err.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Сервер запущен на порту ${PORT}`);
  console.log(`📡 Webhook: ${process.env.PUBLIC_URL || 'http://localhost:' + PORT}/webhook\n`);
});
