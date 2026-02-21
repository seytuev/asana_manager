const axios = require('axios');

const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const LANG = process.env.NOTIFICATION_LANGUAGE || 'ru';

const api = axios.create({
  baseURL: 'https://app.asana.com/api/1.0',
  headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  timeout: 8000,
});

// ── Маппинг исполнителей Asana → Telegram username ───────────────────────────
const ASSIGNEE_MENTIONS = {
  'Мустафа Сейтуев': '@seytuev',
  'Amina Mamm':      '@amina_mamm',
  'bagdasarovartur05@gmail.com': '@artb93',
  // Добавляй новых сотрудников сюда в формате:
  // 'Имя в Asana': '@telegram_username',
};

function getMention(assigneeName) {
  return ASSIGNEE_MENTIONS[assigneeName] || null;
}

// ── Кэш данных на 5 минут ────────────────────────────────────────────────────
const cache = new Map();
async function get(url) {
  if (cache.has(url)) return cache.get(url);
  try {
    const r = await api.get(url);
    const d = r.data?.data;
    cache.set(url, d);
    setTimeout(() => cache.delete(url), 5 * 60 * 1000);
    return d;
  } catch { return null; }
}

// ── Дедупликация — не отправлять одно и то же дважды за 10 секунд ────────────
const recentEvents = new Map();
function isDuplicate(key) {
  if (recentEvents.has(key)) return true;
  recentEvents.set(key, true);
  setTimeout(() => recentEvents.delete(key), 10 * 1000);
  return false;
}

function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(s) {
  if (!s) return LANG === 'ru' ? 'не указан' : 'not set';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

async function getTask(gid) {
  // Не кэшируем задачи чтобы всегда получать актуальное название
  const url = `/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,due_on,permalink_url,projects.name,completed`;
  cache.delete(url);
  return get(url);
}

async function getStory(gid) {
  return get(`/stories/${gid}?opt_fields=text,resource_subtype,created_by.name`);
}

// ─────────────────────────────────────────────────────────────────────────────

async function formatEvent(event) {
  const { action, resource, user, parent } = event;
  const type = resource?.resource_type;
  const gid  = resource?.gid;

  // ── ЗАДАЧА ──────────────────────────────────────────────────────────────────
  if (type === 'task') {
    const dedupKey = `task:${gid}:${action}`;
    if (isDuplicate(dedupKey)) return null;

    // Задержка 3 сек чтобы Asana успела сохранить полное название
    await new Promise(r => setTimeout(r, 3000));

    const task = await getTask(gid);
    if (!task) return null;

    // Пропускаем задачи с пустым названием (нажатие Enter в Asana)
    const taskName = (task.name || '').trim();
    if (taskName.length < 2) return null;

    // Пропускаем changed если задача не завершена — слишком шумно
    if (action === 'changed' && !task.completed) return null;

    const name    = esc(taskName);
    const project = esc(task.projects?.[0]?.name || '');
    const due     = fmtDate(task.due_on);
    const url     = task.permalink_url;

    // Исполнитель с упоминанием Telegram
    const assigneeName = task.assignee?.name || task.assignee?.email || null;
    const mention      = assigneeName ? getMention(assigneeName) : null;
    const assigneeStr  = mention
      ? `${esc(assigneeName)} (${mention})`
      : esc(assigneeName || (LANG === 'ru' ? 'не назначен' : 'unassigned'));

    const actor = user?.name ? `\n👁 ${LANG === 'ru' ? 'Изменил' : 'By'}: ${esc(user.name)}` : '';
    const link  = url && action !== 'deleted' ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

    let header;
    if (action === 'added')        header = LANG === 'ru' ? '➕ Новая задача создана' : '➕ New task created';
    else if (action === 'deleted') header = LANG === 'ru' ? '🗑 Задача удалена'       : '🗑 Task deleted';
    else if (task.completed)       header = LANG === 'ru' ? '✅ Задача выполнена'     : '✅ Task completed';
    else return null;

    let msg = `<b>${header}</b>\n📋 <b>${name}</b>\n`;
    if (project) msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
    msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeStr}`;
    msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
    msg += actor + link;

    // Упоминание отдельной строкой чтобы точно сработало в Telegram
    if (mention) msg += `\n\n${mention}`;

    return msg;
  }

  // ── КОММЕНТАРИЙ ─────────────────────────────────────────────────────────────
  if (type === 'story' && action === 'added') {
    const dedupKey = `story:${gid}`;
    if (isDuplicate(dedupKey)) return null;

    const story = await getStory(gid);
    if (!story || story.resource_subtype !== 'comment_added') return null;

    const task   = parent?.gid ? await getTask(parent.gid) : null;
    const author = esc(story.created_by?.name || '');
    const text   = esc((story.text || '').slice(0, 400));
    const more   = (story.text || '').length > 400 ? '...' : '';
    const url    = task?.permalink_url;
    const link   = url ? `\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

    let msg = `<b>💬 ${LANG === 'ru' ? 'Новый комментарий' : 'New comment'}</b>\n`;
    if (task?.name) msg += `📋 <b>${esc(task.name)}</b>\n`;
    msg += `\n<i>${text}${more}</i>\n\n👤 ${author}${link}`;
    return msg;
  }

  // ── СЕКЦИЯ ──────────────────────────────────────────────────────────────────
  if (type === 'section' && action === 'added') {
    const dedupKey = `section:${gid}`;
    if (isDuplicate(dedupKey)) return null;
    const name = esc(resource?.name || '');
    return `<b>📂 ${LANG === 'ru' ? 'Новая секция создана' : 'New section created'}</b>\n${name}`;
  }

  // ── ВЛОЖЕНИЕ ─────────────────────────────────────────────────────────────────
  if (type === 'attachment' && action === 'added') {
    const dedupKey = `attachment:${gid}`;
    if (isDuplicate(dedupKey)) return null;
    const task = parent?.gid ? await getTask(parent.gid) : null;
    const file = esc(resource?.name || (LANG === 'ru' ? 'файл' : 'file'));
    let msg = `<b>📎 ${LANG === 'ru' ? 'Файл прикреплён' : 'File attached'}</b>\n${file}`;
    if (task?.name) msg += `\n📋 ${esc(task.name)}`;
    if (task?.permalink_url) msg += `\n<a href="${task.permalink_url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>`;
    return msg;
  }

  return null;
}

module.exports = { formatEvent };
