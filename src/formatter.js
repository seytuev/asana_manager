const axios = require('axios');

const ASANA_TOKEN = process.env.ASANA_ACCESS_TOKEN;
const LANG = process.env.NOTIFICATION_LANGUAGE || 'ru';

const api = axios.create({
  baseURL: 'https://app.asana.com/api/1.0',
  headers: { Authorization: `Bearer ${ASANA_TOKEN}` },
  timeout: 8000,
});

// Кэш данных на 5 минут
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

// Дедупликация — не отправлять одно и то же дважды за 10 секунд
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
  return get(`/tasks/${gid}?opt_fields=name,assignee.name,due_on,permalink_url,projects.name,completed`);
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

    const task = await getTask(gid);
    if (!task) return null;

    // Пропускаем changed если задача не завершена — слишком шумно
    if (action === 'changed' && !task.completed) return null;

    const name     = esc(task.name);
    const project  = esc(task.projects?.[0]?.name || '');
    const assignee = esc(task.assignee?.name || (LANG === 'ru' ? 'не назначен' : 'unassigned'));
    const due      = fmtDate(task.due_on);
    const url      = task.permalink_url;
    const actor    = user?.name ? `\n👁 ${LANG === 'ru' ? 'Изменил' : 'By'}: ${esc(user.name)}` : '';
    const link     = url && action !== 'deleted' ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

    let header;
    if (action === 'added')   header = LANG === 'ru' ? '➕ Новая задача создана'  : '➕ New task created';
    else if (action === 'deleted') header = LANG === 'ru' ? '🗑 Задача удалена'   : '🗑 Task deleted';
    else if (task.completed)  header = LANG === 'ru' ? '✅ Задача выполнена'      : '✅ Task completed';
    else                      header = LANG === 'ru' ? '✏️ Задача изменена'       : '✏️ Task updated';

    let msg = `<b>${header}</b>\n📋 <b>${name}</b>\n`;
    if (project)  msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
    msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assignee}`;
    msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
    msg += actor + link;
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
    const file = esc(resource?.name || LANG === 'ru' ? 'файл' : 'file');
    let msg = `<b>📎 ${LANG === 'ru' ? 'Файл прикреплён' : 'File attached'}</b>\n${file}`;
    if (task?.name) msg += `\n📋 ${esc(task.name)}`;
    if (task?.permalink_url) msg += `\n<a href="${task.permalink_url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>`;
    return msg;
  }

  return null;
}

module.exports = { formatEvent };
