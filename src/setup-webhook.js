/**
 * Запуск: node src/setup-webhook.js
 * После деплоя на Railway — запусти один раз из Railway Shell или локально с заполненным .env
 */
require('dotenv').config();
const axios = require('axios');

const TOKEN      = process.env.ASANA_ACCESS_TOKEN;
const SECRET     = process.env.ASANA_WEBHOOK_SECRET;
const GIDS       = (process.env.ASANA_PROJECT_GID || '').split(',').map(s => s.trim()).filter(Boolean);
const PUBLIC_URL = process.env.PUBLIC_URL;

if (!TOKEN || !GIDS.length || !PUBLIC_URL) {
  console.error('❌ Заполни ASANA_ACCESS_TOKEN, ASANA_PROJECT_GID и PUBLIC_URL в .env');
  process.exit(1);
}

const api = axios.create({
  baseURL: 'https://app.asana.com/api/1.0',
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
});

async function run() {
  for (const gid of GIDS) {
    console.log(`\n📁 Регистрирую webhook для проекта ${gid}...`);
    console.log(`   Target: ${PUBLIC_URL}/webhook`);
    try {
      const { data } = await api.post('/webhooks', {
        data: {
          resource: gid,
          target: `${PUBLIC_URL}/webhook`,
          filters: [
            { resource_type: 'task',       action: 'added'   },
            { resource_type: 'task',       action: 'changed' },
            { resource_type: 'task',       action: 'deleted' },
            { resource_type: 'story',      action: 'added'   },
            { resource_type: 'section',    action: 'added'   },
            { resource_type: 'attachment', action: 'added'   },
          ],
        },
      });
      console.log(`✅ Webhook создан! ID: ${data.data?.gid}`);
    } catch (err) {
      const msg = err.response?.data?.errors?.[0]?.message || err.message;
      console.error(`❌ Ошибка: ${msg}`);
      if (err.response?.status === 400) {
        console.error('   → Возможно, webhook с таким URL уже существует');
      }
    }
  }
}

run();
