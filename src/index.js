require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const { sendTelegram } = require('./telegram');
const { formatEvent, setSendFunction } = require('./formatter');

setSendFunction(sendTelegram);

const { startScheduler } = require('./scheduler');
startScheduler();

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
    console.log('[HANDSHAKE] подтверждён');
    return res.set('x-hook-secret', handshake).status(200).send();
  }

  if (!checkSignature(req)) {
    console.warn('[WARN] Неверная подпись');
    return res.status(401).send('Unauthorized');
  }

  const events = req.body?.events || [];

  res.status(200).send();

  for (const event of events) {
    // Для story — предзагружаем данные чтобы избежать 404 при повторном запросе
    if (event.resource?.resource_type === 'story') {
      const axios = require('axios');
      try {
        const r = await axios.get(`https://app.asana.com/api/1.0/stories/${event.resource.gid}?opt_fields=resource_subtype,text,type,created_by.name,new_name,old_name,new_text_value,old_text_value,new_enum_value.name,old_enum_value.name,custom_field.name`, {
          headers: { Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}` }
        });
        event._storyData = r.data?.data;
      } catch(e) {
        // story временно недоступна, formatter попробует сам
      }
    }

    try {
      const text = await formatEvent(event);
      if (text) {
        await sendTelegram(text);
        console.log(`[OK] ${event.action} ${event.resource?.resource_type}`);
      }
    } catch (err) {
      console.error(`[ERR] ${err.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Порт ${PORT} | Webhook: ${process.env.PUBLIC_URL}/webhook\n`);
});
