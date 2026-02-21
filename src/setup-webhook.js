require('dotenv').config();
const axios = require('axios');

const TOKEN      = process.env.ASANA_ACCESS_TOKEN;
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
  // Сначала удаляем все старые webhook'и для этого проекта
  console.log('\n🔍 Проверяю существующие webhook\'и...');
  try {
    const { data } = await api.get(`/webhooks?workspace=${GIDS[0]}`);
    const existing = (data.data || []).filter(w => w.target?.includes(PUBLIC_URL));
    for (const wh of existing) {
      await api.delete(`/webhooks/${wh.gid}`);
      console.log(`🗑 Удалён старый webhook: ${wh.gid}`);
    }
  } catch (e) {
    console.warn('⚠️ Не удалось получить список webhook\'ов:', e.message);
  }

  for (const gid of GIDS) {
    console.log(`\n📁 Регистрирую webhook для проекта ${gid}...`);
    try {
      const { data } = await api.post('/webhooks', {
        data: {
          resource: gid,
          target: `${PUBLIC_URL}/webhook`,
          filters: [
            { resource_type: 'task',       action: 'added'   },
            { resource_type: 'task',       action: 'deleted' },
            { resource_type: 'story',      action: 'added'   }, // все изменения полей
            { resource_type: 'section',    action: 'added'   },
            { resource_type: 'attachment', action: 'added'   },
          ],
        },
      });
      console.log(`✅ Webhook создан! ID: ${data.data?.gid}`);
    } catch (err) {
      const msg = err.response?.data?.errors?.[0]?.message || err.message;
      console.error(`❌ Ошибка: ${msg}`);
    }
  }
}

run();
