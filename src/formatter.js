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
  // 'Имя в Asana': '@telegram_username',
};

function getMention(name) {
  return ASSIGNEE_MENTIONS[name] || null;
}

// ── Кэш данных ───────────────────────────────────────────────────────────────
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

async function getTask(gid) {
  const url = `/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,due_on,permalink_url,projects.name,completed,parent.name,parent.gid,notes,custom_fields`;
  cache.delete(url);
  return get(url);
}

async function getStory(gid) {
  return get(`/stories/${gid}?opt_fields=text,resource_subtype,created_by.name`);
}

// ── Debounce по задаче ────────────────────────────────────────────────────────
// Копит все изменения задачи за DEBOUNCE_MS миллисекунд,
// потом отправляет одно итоговое уведомление.
const DEBOUNCE_MS = 30000; // 30 секунд тишины = финальное состояние
const pendingTasks = new Map(); // gid -> { timer, actions: Set, user }

function scheduleTaskNotification(gid, actionType, userName, sendFn) {
  if (pendingTasks.has(gid)) {
    const pending = pendingTasks.get(gid);
    clearTimeout(pending.timer);
    pending.actions.add(actionType);
    if (userName) pending.user = userName;
  } else {
    pendingTasks.set(gid, { actions: new Set([actionType]), user: userName, timer: null });
  }

  const pending = pendingTasks.get(gid);
  pending.timer = setTimeout(async () => {
    pendingTasks.delete(gid);
    await sendFn(gid, pending.actions, pending.user);
  }, DEBOUNCE_MS);
}

// ── Дедупликация уже отправленных уведомлений ─────────────────────────────────
const sentEvents = new Map();
function isDuplicate(key) {
  if (sentEvents.has(key)) return true;
  sentEvents.set(key, true);
  setTimeout(() => sentEvents.delete(key), 30 * 1000);
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

function assigneeBlock(task) {
  const name = task.assignee?.name || task.assignee?.email || null;
  if (!name) return LANG === 'ru' ? 'не назначен' : 'unassigned';
  const mention = getMention(name);
  return mention ? `${esc(name)} (${mention})` : esc(name);
}

function mentionLine(task) {
  const name = task.assignee?.name || task.assignee?.email || null;
  if (!name) return '';
  const mention = getMention(name);
  return mention ? `\n\n${mention}` : '';
}

// ── Формирует финальное сообщение об изменениях задачи ───────────────────────
async function buildChangedMessage(gid, actions, userName) {
  const task = await getTask(gid);
  if (!task) return null;

  const taskName = (task.name || '').trim();
  if (taskName.length < 2) return null;

  const name    = esc(taskName);
  const project = esc(task.projects?.[0]?.name || '');
  const due     = fmtDate(task.due_on);
  const url     = task.permalink_url;
  const actor   = userName ? `\n👁 ${LANG === 'ru' ? 'Кто' : 'By'}: ${esc(userName)}` : '';
  const link    = url ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

  // Завершение задачи — приоритет над всем
  if (task.completed) {
    let msg = `<b>✅ ${LANG === 'ru' ? 'Задача выполнена' : 'Task completed'}</b>\n📋 <b>${name}</b>`;
    if (project) msg += `\n📁 ${project}`;
    msg += actor + link + mentionLine(task);
    return msg;
  }

  // Новая задача или подзадача
  if (actions.has('added')) {
    if (task.parent?.gid) {
      let msg = `<b>🔸 ${LANG === 'ru' ? 'Новая подзадача создана' : 'New subtask created'}</b>\n`;
      msg += `📋 <b>${name}</b>\n`;
      msg += `\n↖️ ${LANG === 'ru' ? 'Задача' : 'Parent'}: ${esc(task.parent.name)}`;
      if (project) msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
      msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeBlock(task)}`;
      msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
      msg += actor + link + mentionLine(task);
      return msg;
    }

    let msg = `<b>➕ ${LANG === 'ru' ? 'Новая задача создана' : 'New task created'}</b>\n`;
    msg += `📋 <b>${name}</b>\n`;
    if (project) msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
    msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeBlock(task)}`;
    msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
    msg += actor + link + mentionLine(task);
    return msg;
  }

  // Одно или несколько изменений — показываем итоговое состояние задачи
  const changedFields = [];
  if (actions.has('assignee'))     changedFields.push(LANG === 'ru' ? '👤 исполнитель'  : '👤 assignee');
  if (actions.has('due_on'))       changedFields.push(LANG === 'ru' ? '📅 срок'         : '📅 due date');
  if (actions.has('notes'))        changedFields.push(LANG === 'ru' ? '📝 описание'     : '📝 description');
  if (actions.has('name'))         changedFields.push(LANG === 'ru' ? '✏️ название'     : '✏️ name');
  if (actions.has('custom_field')) changedFields.push(LANG === 'ru' ? '🔄 поле'         : '🔄 field');

  if (changedFields.length === 0) return null;

  let msg = `<b>✏️ ${LANG === 'ru' ? 'Задача изменена' : 'Task updated'}</b>\n`;
  msg += `📋 <b>${name}</b>\n`;
  msg += `\n${LANG === 'ru' ? 'Что изменено' : 'Changed'}: ${changedFields.join(', ')}`;
  if (project)  msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
  msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeBlock(task)}`;
  msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;

  // Показываем описание если оно было изменено
  if (actions.has('notes') && task.notes) {
    const notes = task.notes.slice(0, 300).trim();
    msg += `\n\n📝 <i>${esc(notes)}${task.notes.length > 300 ? '...' : ''}</i>`;
  }

  msg += actor + link + mentionLine(task);
  return msg;
}

// ─────────────────────────────────────────────────────────────────────────────
// Внешний колбэк для отправки — устанавливается из index.js
let _sendTelegram = null;
function setSendFunction(fn) { _sendTelegram = fn; }

async function formatEvent(event) {
  const { action, resource, user, parent, change } = event;
  const type = resource?.resource_type;
  const gid  = resource?.gid;

  // ── ЗАДАЧА ──────────────────────────────────────────────────────────────────
  if (type === 'task') {
    // Удаление — сразу без debounce
    if (action === 'deleted') {
      if (isDuplicate(`deleted:${gid}`)) return null;
      const task = await getTask(gid);
      const name = esc((task?.name || '').trim());
      if (!name) return null;
      const actor = user?.name ? `\n👁 ${esc(user.name)}` : '';
      return `<b>🗑 ${LANG === 'ru' ? 'Задача удалена' : 'Task deleted'}</b>\n📋 <b>${name}</b>${actor}`;
    }

    // Определяем тип изменения
    let actionType = action; // 'added' или название поля
    if (action === 'changed' && change?.field) {
      actionType = change.field; // 'assignee', 'due_on', 'notes', 'name', 'custom_fields'...
    }

    // Игнорируем несущественные поля
    const ignoredFields = ['liked', 'followers', 'memberships'];
    if (ignoredFields.includes(actionType)) return null;

    // Нормализуем название поля
    if (actionType === 'due_on') actionType = 'due_on';
    if (actionType === 'custom_fields' || actionType?.startsWith('custom_field')) actionType = 'custom_field';

    // Накапливаем через debounce, отправляем одно итоговое сообщение
    scheduleTaskNotification(gid, actionType, user?.name, async (taskGid, actions, userName) => {
      const dedupKey = `task:${taskGid}:${[...actions].sort().join(',')}`;
      if (isDuplicate(dedupKey)) return;

      const msg = await buildChangedMessage(taskGid, actions, userName);
      if (msg && _sendTelegram) {
        await _sendTelegram(msg).catch(e => console.error('[ERR] Telegram:', e.message));
      }
    });

    return null; // отправка идёт через debounce, не через return
  }

  // ── КОММЕНТАРИЙ ─────────────────────────────────────────────────────────────
  if (type === 'story' && action === 'added') {
    if (isDuplicate(`story:${gid}`)) return null;

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
    if (isDuplicate(`section:${gid}`)) return null;
    const name = esc(resource?.name || '');
    return `<b>📂 ${LANG === 'ru' ? 'Новая секция создана' : 'New section created'}</b>\n${name}`;
  }

  // ── ВЛОЖЕНИЕ ─────────────────────────────────────────────────────────────────
  if (type === 'attachment' && action === 'added') {
    if (isDuplicate(`attachment:${gid}`)) return null;
    const task = parent?.gid ? await getTask(parent.gid) : null;
    const file = esc(resource?.name || (LANG === 'ru' ? 'файл' : 'file'));
    let msg = `<b>📎 ${LANG === 'ru' ? 'Файл прикреплён' : 'File attached'}</b>\n${file}`;
    if (task?.name) msg += `\n📋 ${esc(task.name)}`;
    if (task?.permalink_url) msg += `\n<a href="${task.permalink_url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>`;
    return msg;
  }

  return null;
}

module.exports = { formatEvent, setSendFunction };
