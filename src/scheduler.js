const axios = require('axios');
const { sendTelegram } = require('./telegram');

const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const PROJECT_GID = process.env.ASANA_PROJECT_GID;

const api = axios.create({
  baseURL: 'https://app.asana.com/api/1.0',
  headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  timeout: 10000,
});

// ── Маппинг исполнителей (дублируем из formatter) ─────────────────────────────
const ASSIGNEE_MENTIONS = {
  'Мустафа Сейтуев': '@seytuev',
  'Amina Mamm':      '@amina_mamm',
  'bagdasarovartur05@gmail.com': '@artb93',
};

function getMention(name) {
  return ASSIGNEE_MENTIONS[name] || null;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(s) {
  if (!s) return '—';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

function assigneeStr(task) {
  const name = task.assignee?.name || task.assignee?.email || null;
  if (!name) return 'не назначен';
  const mention = getMention(name);
  return mention ? `${esc(name)} (${mention})` : esc(name);
}

// ── Получить все задачи проекта ───────────────────────────────────────────────
async function fetchTasks() {
  const projects = PROJECT_GID.split(',').map(s => s.trim());
  const allTasks = [];

  for (const gid of projects) {
    try {
      const res = await api.get(`/projects/${gid}/tasks?opt_fields=name,due_on,completed,completed_at,assignee.name,assignee.email,permalink_url&limit=100`);
      allTasks.push(...(res.data?.data || []));
    } catch (e) {
      console.error(`[SCHEDULER] Ошибка получения задач проекта ${gid}: ${e.message}`);
    }
  }

  return allTasks;
}

// ── Получить задачи выполненные за последнюю неделю ───────────────────────────
async function fetchCompletedThisWeek() {
  const projects = PROJECT_GID.split(',').map(s => s.trim());
  const allTasks = [];
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);

  for (const gid of projects) {
    try {
      const res = await api.get(`/projects/${gid}/tasks?opt_fields=name,due_on,completed,completed_at,assignee.name,assignee.email&limit=100`);
      const tasks = res.data?.data || [];
      const completed = tasks.filter(t => {
        if (!t.completed || !t.completed_at) return false;
        return new Date(t.completed_at) >= weekAgo;
      });
      allTasks.push(...completed);
    } catch (e) {
      console.error(`[SCHEDULER] Ошибка: ${e.message}`);
    }
  }

  return allTasks;
}

// ─────────────────────────────────────────────────────────────────────────────
// 09:00 — Просроченные задачи
// ─────────────────────────────────────────────────────────────────────────────
async function sendOverdueReport() {
  console.log('[SCHEDULER] Отправка отчёта о просроченных задачах...');
  const tasks = await fetchTasks();
  const today = new Date().toISOString().split('T')[0];

  const overdue = tasks.filter(t =>
    !t.completed &&
    t.due_on &&
    t.due_on < today
  );

  if (overdue.length === 0) {
    await sendTelegram('✅ <b>Просроченных задач нет!</b>\nВсе задачи в срок.');
    return;
  }

  let msg = `🚨 <b>Просроченные задачи (${overdue.length})</b>\n`;
  msg += `📅 На ${fmtDate(today)}\n`;
  msg += '─────────────────\n';

  for (const t of overdue) {
    const daysOverdue = Math.floor((new Date(today) - new Date(t.due_on)) / 86400000);
    msg += `\n📋 <b>${esc(t.name)}</b>`;
    msg += `\n👤 ${assigneeStr(t)}`;
    msg += `\n⏰ Срок: ${fmtDate(t.due_on)} (<b>просрочено на ${daysOverdue} дн.</b>)`;
    if (t.permalink_url) msg += `\n<a href="${t.permalink_url}">🔗 Открыть</a>`;
    msg += '\n';
  }

  // Упоминаем всех исполнителей просроченных задач
  const mentions = new Set();
  overdue.forEach(t => {
    const name = t.assignee?.name || t.assignee?.email;
    const mention = name ? getMention(name) : null;
    if (mention) mentions.add(mention);
  });
  if (mentions.size > 0) msg += `\n${[...mentions].join(' ')}`;

  await sendTelegram(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10:00 — Дедлайны сегодня и завтра
// ─────────────────────────────────────────────────────────────────────────────
async function sendDailyDeadlines() {
  console.log('[SCHEDULER] Отправка ежедневной сводки дедлайнов...');
  const tasks = await fetchTasks();

  const today = new Date().toISOString().split('T')[0];
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const tomorrowStr = tomorrow.toISOString().split('T')[0];

  const todayTasks    = tasks.filter(t => !t.completed && t.due_on === today);
  const tomorrowTasks = tasks.filter(t => !t.completed && t.due_on === tomorrowStr);

  if (todayTasks.length === 0 && tomorrowTasks.length === 0) {
    console.log('[SCHEDULER] Нет дедлайнов сегодня и завтра');
    return;
  }

  let msg = `📅 <b>Дедлайны на сегодня и завтра</b>\n`;

  if (todayTasks.length > 0) {
    msg += `\n🔴 <b>Сегодня (${fmtDate(today)}) — ${todayTasks.length} задач:</b>\n`;
    for (const t of todayTasks) {
      msg += `\n📋 <b>${esc(t.name)}</b>`;
      msg += `\n👤 ${assigneeStr(t)}`;
      if (t.permalink_url) msg += `\n<a href="${t.permalink_url}">🔗 Открыть</a>`;
      msg += '\n';
    }
  }

  if (tomorrowTasks.length > 0) {
    msg += `\n🟡 <b>Завтра (${fmtDate(tomorrowStr)}) — ${tomorrowTasks.length} задач:</b>\n`;
    for (const t of tomorrowTasks) {
      msg += `\n📋 <b>${esc(t.name)}</b>`;
      msg += `\n👤 ${assigneeStr(t)}`;
      if (t.permalink_url) msg += `\n<a href="${t.permalink_url}">🔗 Открыть</a>`;
      msg += '\n';
    }
  }

  // Упоминаем исполнителей
  const mentions = new Set();
  [...todayTasks, ...tomorrowTasks].forEach(t => {
    const name = t.assignee?.name || t.assignee?.email;
    const mention = name ? getMention(name) : null;
    if (mention) mentions.add(mention);
  });
  if (mentions.size > 0) msg += `\n${[...mentions].join(' ')}`;

  await sendTelegram(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Воскресенье — Еженедельный дайджест
// ─────────────────────────────────────────────────────────────────────────────
async function sendWeeklyDigest() {
  console.log('[SCHEDULER] Отправка еженедельного дайджеста...');
  const allTasks    = await fetchTasks();
  const completed   = await fetchCompletedThisWeek();
  const today       = new Date().toISOString().split('T')[0];

  const overdue     = allTasks.filter(t => !t.completed && t.due_on && t.due_on < today);
  const inProgress  = allTasks.filter(t => !t.completed);

  let msg = `📊 <b>Еженедельный дайджест</b>\n`;
  const weekStart = new Date();
  weekStart.setDate(weekStart.getDate() - 6);
  msg += `📅 ${fmtDate(weekStart.toISOString().split('T')[0])} — ${fmtDate(today)}\n`;
  msg += '─────────────────\n';
  msg += `\n✅ Выполнено за неделю: <b>${completed.length}</b>`;
  msg += `\n🔄 В работе: <b>${inProgress.length}</b>`;
  msg += `\n🚨 Просрочено: <b>${overdue.length}</b>`;

  if (completed.length > 0) {
    msg += `\n\n<b>✅ Выполненные задачи:</b>\n`;
    for (const t of completed.slice(0, 10)) {
      msg += `• ${esc(t.name)}\n`;
    }
    if (completed.length > 10) msg += `  <i>...и ещё ${completed.length - 10}</i>\n`;
  }

  if (overdue.length > 0) {
    msg += `\n<b>🚨 Просроченные:</b>\n`;
    for (const t of overdue.slice(0, 10)) {
      msg += `• ${esc(t.name)} — ${assigneeStr(t)} (${fmtDate(t.due_on)})\n`;
    }
    if (overdue.length > 10) msg += `  <i>...и ещё ${overdue.length - 10}</i>\n`;
  }

  await sendTelegram(msg);
}

// ─────────────────────────────────────────────────────────────────────────────
// Планировщик — проверяет время каждую минуту
// ─────────────────────────────────────────────────────────────────────────────
function getMoscowTime() {
  // UTC+3
  const now = new Date();
  const moscow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return {
    hour:    moscow.getUTCHours(),
    minute:  moscow.getUTCMinutes(),
    weekday: moscow.getUTCDay(), // 0=вс, 1=пн, ..., 6=сб
    dateStr: moscow.toISOString().split('T')[0],
  };
}

let lastRun = {}; // dateStr+job -> true

function startScheduler() {
  console.log('[SCHEDULER] Запущен. Проверка каждую минуту (МСК UTC+3)');

  setInterval(async () => {
    const { hour, minute, weekday, dateStr } = getMoscowTime();
    if (minute !== 0) return; // срабатываем только в начале часа

    const key09 = `${dateStr}_overdue`;
    const key10 = `${dateStr}_deadlines`;
    const keyWk = `${dateStr}_weekly`;

    // 09:00 — просроченные задачи (каждый день)
    if (hour === 9 && !lastRun[key09]) {
      lastRun[key09] = true;
      await sendOverdueReport().catch(e => console.error('[SCHEDULER] overdue error:', e.message));
    }

    // 10:00 — дедлайны (каждый день)
    if (hour === 10 && !lastRun[key10]) {
      lastRun[key10] = true;
      await sendDailyDeadlines().catch(e => console.error('[SCHEDULER] deadlines error:', e.message));
    }

    // 10:00 воскресенье — еженедельный дайджест
    if (hour === 10 && weekday === 0 && !lastRun[keyWk]) {
      lastRun[keyWk] = true;
      await sendWeeklyDigest().catch(e => console.error('[SCHEDULER] weekly error:', e.message));
    }

    // Чистим старые записи lastRun (оставляем только сегодняшние)
    Object.keys(lastRun).forEach(k => {
      if (!k.startsWith(dateStr)) delete lastRun[k];
    });

  }, 60 * 1000); // каждую минуту
}

module.exports = { startScheduler };
