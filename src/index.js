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
    // Детальный лог каждого события
    console.log(`[EVT] action=${event.action} | type=${event.resource?.resource_type} | gid=${event.resource?.gid} | parent=${event.parent?.resource_type}:${event.parent?.gid} | field=${event.change?.field} | user=${event.user?.name || '-'}`);

    // Для story — логируем subtype через API
    if (event.resource?.resource_type === 'story') {
      const axios = require('axios');
      try {
        const r = await axios.get(`https://app.asana.com/api/1.0/stories/${event.resource.gid}?opt_fields=resource_subtype,text,type`, {
          headers: { Authorization: `Bearer ${process.env.ASANA_ACCESS_TOKEN}` }
        });
        const s = r.data?.data;
        // Прикрепляем данные story к событию чтобы formatter мог использовать их
        event._storyData = s;
        console.log(`  └─ story subtype=${s?.resource_subtype} | type=${s?.type} | text="${(s?.text||'').slice(0,80)}"`);
      } catch(e) {
        console.log(`  └─ story fetch error: ${e.message}`);
      }
    }

    try {
      const text = await formatEvent(event);
      if (text) {
        await sendTelegram(text);
        console.log(`  └─ [SENT]`);
      } else {
        console.log(`  └─ [SKIPPED]`);
      }
    } catch (err) {
      console.error(`  └─ [ERR] ${err.message}`);
    }
  }
});

app.listen(PORT, () => {
  console.log(`\n🚀 Порт ${PORT} | Webhook: ${process.env.PUBLIC_URL}/webhook\n`);
});
