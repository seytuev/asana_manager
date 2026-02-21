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

// ── Кэш имён задач (для удалённых задач) ─────────────────────────────────────
const taskNameCache = new Map();

// ── Кэш данных ───────────────────────────────────────────────────────────────
const cache = new Map();
async function cachedGet(url) {
  if (cache.has(url)) return cache.get(url);
  try {
    const r = await api.get(url);
    const d = r.data?.data;
    cache.set(url, d);
    setTimeout(() => cache.delete(url), 3 * 60 * 1000);
    return d;
  } catch { return null; }
}

async function getTask(gid) {
  const url = `/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,due_on,permalink_url,projects.name,completed,parent.name,parent.gid,notes`;
  cache.delete(url);
  const task = await cachedGet(url);
  // Кэшируем имя задачи на случай удаления
  if (task?.name) taskNameCache.set(gid, task.name);
  return task;
}

async function getStory(gid) {
  const url = `/stories/${gid}?opt_fields=text,type,resource_subtype,created_by.name,new_text_value,old_text_value,new_enum_value.name,old_enum_value.name,new_name,old_name,assignee.name,custom_field.name`;
  cache.delete(url);
  try {
    const r = await api.get(url);
    return r.data?.data || null;
  } catch(e) {
    // Story недоступна — возвращаем минимальный объект с данными из события если есть
    console.log(`  [WARN] story ${gid} not accessible: ${e.response?.status}`);
    return null;
  }
}

// ── Дедупликация ─────────────────────────────────────────────────────────────
const sentEvents = new Map();
function isDuplicate(key) {
  if (sentEvents.has(key)) return true;
  sentEvents.set(key, true);
  setTimeout(() => sentEvents.delete(key), 5 * 1000);
  return false;
}

// ── Debounce для новых задач ──────────────────────────────────────────────────
const NEW_TASK_DEBOUNCE_MS = 4000;
const pendingNewTasks = new Map();

function scheduleNewTask(gid, userName, sendFn) {
  if (pendingNewTasks.has(gid)) {
    const p = pendingNewTasks.get(gid);
    clearTimeout(p.timer);
    if (userName) p.user = userName;
  } else {
    pendingNewTasks.set(gid, { user: userName, timer: null });
  }
  const p = pendingNewTasks.get(gid);
  p.timer = setTimeout(async () => {
    pendingNewTasks.delete(gid);
    await sendFn(gid, p.user);
  }, NEW_TASK_DEBOUNCE_MS);
}

// ── Вспомогательные функции ───────────────────────────────────────────────────
function esc(s) {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtDate(s) {
  if (!s) return LANG === 'ru' ? 'не указан' : 'not set';
  const [y, m, d] = s.split('-');
  return `${d}.${m}.${y}`;
}

function assigneeBlock(task) {
  const name = task?.assignee?.name || task?.assignee?.email || null;
  if (!name) return LANG === 'ru' ? 'не назначен' : 'unassigned';
  const mention = getMention(name);
  return mention ? `${esc(name)} (${mention})` : esc(name);
}

function mentionLine(task) {
  const name = task?.assignee?.name || task?.assignee?.email || null;
  if (!name) return '';
  const mention = getMention(name);
  return mention ? `\n\n${mention}` : '';
}

// Извлекаем имя исполнителя из текста story (например "Мустафа assigned to you")
function extractActorFromText(text) {
  if (!text) return null;
  const match = text.match(/^([^а-яёa-z]+?)\s+(added|changed|moved|assigned|marked|removed)/i);
  return match ? match[1].trim() : null;
}

// ── Внешний колбэк для отправки ───────────────────────────────────────────────
let _sendTelegram = null;
function setSendFunction(fn) { _sendTelegram = fn; }

// ─────────────────────────────────────────────────────────────────────────────

async function formatEvent(event) {
  const { action, resource, user, parent, _storyData } = event;
  const type = resource?.resource_type;
  const gid  = resource?.gid;

  // ── ЗАДАЧА: создание ──────────────────────────────────────────────────────────
  if (type === 'task' && action === 'added') {
    // Игнорируем события "задача добавлена в секцию/проект" для существующих задач
    // Новая задача определяется по parent=project (первое событие при создании)
    if (parent?.resource_type !== 'project' && parent?.resource_type !== 'task') return null;

    scheduleNewTask(gid, user?.name, async (taskGid, userName) => {
      if (isDuplicate(`new_task:${taskGid}`)) return;

      const task = await getTask(taskGid);
      if (!task) return;
      const taskName = (task.name || '').trim();
      if (taskName.length < 2) return;

      const name    = esc(taskName);
      const project = esc(task.projects?.[0]?.name || '');
      const due     = fmtDate(task.due_on);
      const url     = task.permalink_url;
      const actor   = userName ? `\n👁 ${esc(userName)}` : '';
      const link    = url ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

      let msg;
      if (task.parent?.gid) {
        msg = `<b>🔸 ${LANG === 'ru' ? 'Новая подзадача создана' : 'New subtask created'}</b>\n`;
        msg += `📋 <b>${name}</b>\n`;
        msg += `\n↖️ ${LANG === 'ru' ? 'Задача' : 'Parent'}: ${esc(task.parent.name)}`;
      } else {
        msg = `<b>➕ ${LANG === 'ru' ? 'Новая задача создана' : 'New task created'}</b>\n`;
        msg += `📋 <b>${name}</b>\n`;
      }
      if (project) msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
      msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeBlock(task)}`;
      msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
      msg += actor + link + mentionLine(task);

      if (_sendTelegram) await _sendTelegram(msg).catch(e => console.error('[ERR]', e.message));
    });
    return null;
  }

  // ── ЗАДАЧА: удаление ──────────────────────────────────────────────────────────
  if (type === 'task' && action === 'deleted') {
    if (isDuplicate(`deleted:${gid}`)) return null;
    // Задача уже удалена — берём имя из кэша
    const cachedName = taskNameCache.get(gid);
    // Если имени нет в кэше — задача была пустой (случайное нажатие), игнорируем
    if (!cachedName || cachedName.trim().length < 2) return null;
    // Если задача ещё в pending (не успела сохраниться) — тоже игнорируем
    if (pendingNewTasks.has(gid)) {
      pendingNewTasks.get(gid) && clearTimeout(pendingNewTasks.get(gid).timer);
      pendingNewTasks.delete(gid);
      return null;
    }
    const name = esc(cachedName);
    const actor = user?.name ? `\n👁 ${esc(user.name)}` : '';
    return `<b>🗑 ${LANG === 'ru' ? 'Задача удалена' : 'Task deleted'}</b>\n📋 <b>${name}</b>${actor}`;
  }

  // ── ЗАДАЧА: changed — игнорируем, всё через story ─────────────────────────────
  if (type === 'task' && action === 'changed') return null;

  // ── STORY ─────────────────────────────────────────────────────────────────────
  if (type === 'story' && action === 'added') {
    if (isDuplicate(`story:${gid}`)) return null;

    // Используем предзагруженные данные из index.js или запрашиваем напрямую
    const story = _storyData || await getStory(gid);
    if (!story) return null;

    const subtype = story.resource_subtype;
    const taskGid = parent?.gid;

    // Если задача в процессе создания — пропускаем story
    if (taskGid && pendingNewTasks.has(taskGid)) return null;

    const task     = taskGid ? await getTask(taskGid) : null;
    // Если задача недоступна через API — берём имя из кэша
    const rawName  = task?.name || (taskGid ? taskNameCache.get(taskGid) : null) || '';
    const taskName = rawName.trim() ? esc(rawName.trim()) : null;
    const url      = task?.permalink_url;
    const link     = url ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';
    const actor    = story.created_by?.name ? `\n👁 ${esc(story.created_by.name)}` : '';
    console.log(`  [FMT] subtype=${subtype} taskName="${rawName}" task=${!!task}`);

    // ── Комментарий ──
    if (subtype === 'comment_added') {
      const author = esc(story.created_by?.name || '');
      const text   = esc((story.text || '').slice(0, 400));
      const more   = (story.text || '').length > 400 ? '...' : '';
      let msg = `<b>💬 ${LANG === 'ru' ? 'Новый комментарий' : 'New comment'}</b>\n`;
      if (taskName) msg += `📋 <b>${taskName}</b>\n`;
      msg += `\n<i>${text}${more}</i>\n\n👤 ${author}${link}`;
      return msg;
    }

    // ── Задача выполнена ──
    if (subtype === 'marked_complete') {
      if (!taskName) return null;
      let msg = `<b>✅ ${LANG === 'ru' ? 'Задача выполнена' : 'Task completed'}</b>\n`;
      msg += `📋 <b>${taskName}</b>`;
      if (task?.projects?.[0]?.name) msg += `\n📁 ${esc(task.projects[0].name)}`;
      msg += actor + link + mentionLine(task);
      return msg;
    }

    // ── Задача переоткрыта ──
    if (subtype === 'marked_incomplete') {
      if (!taskName) return null;
      return `<b>🔄 ${LANG === 'ru' ? 'Задача переоткрыта' : 'Task reopened'}</b>\n📋 <b>${taskName}</b>${actor}${link}`;
    }

    // ── Перенос между секциями (статус) ──
    if (subtype === 'section_changed') {
      if (!taskName) return null;
      // Извлекаем из текста: "moved from "А" to "Б""
      const text = story.text || '';
      const match = text.match(/from "(.+?)" to "(.+?)"/);
      const from  = match ? esc(match[1]) : null;
      const to    = match ? esc(match[2]) : null;
      // Пропускаем перемещение в "Готово" — об этом сообщит marked_complete
      const DONE_SECTIONS = ['готово', 'done', 'completed', 'завершено', 'выполнено'];
      if (to && DONE_SECTIONS.some(s => to.toLowerCase().includes(s))) return null;
      let msg = `<b>🔀 ${LANG === 'ru' ? 'Задача перемещена' : 'Task moved'}</b>\n`;
      msg += `📋 <b>${taskName}</b>\n`;
      if (from && to) msg += `\n${from} → <b>${to}</b>`;
      msg += actor + link + mentionLine(task);
      return msg;
    }

    // ── Изменён исполнитель ──
    if (subtype === 'assigned' || subtype === 'unassigned') {
      if (!taskName) return null;
      // Пропускаем автоназначения от Asana (системные, без реального пользователя)
      const storyText = story.text || '';
      const isAutoAssign = storyText.toLowerCase().startsWith('asana ');
      if (isAutoAssign) return null;
      const newAssignee = assigneeBlock(task);
      let msg = `<b>👤 ${LANG === 'ru' ? 'Изменён исполнитель' : 'Assignee changed'}</b>\n`;
      msg += `📋 <b>${taskName}</b>\n`;
      msg += `\n👤 ${LANG === 'ru' ? 'Новый исполнитель' : 'New assignee'}: ${newAssignee}`;
      msg += actor + link + mentionLine(task);
      return msg;
    }

    // ── Изменён срок ──
    if (subtype === 'due_date_changed' || subtype === 'due_today') {
      if (!taskName) return null;
      const due = fmtDate(task?.due_on);
      let msg = `<b>📅 ${LANG === 'ru' ? 'Изменён срок' : 'Due date changed'}</b>\n`;
      msg += `📋 <b>${taskName}</b>\n`;
      msg += `\n📅 ${LANG === 'ru' ? 'Новый срок' : 'New due date'}: ${due}`;
      msg += actor + link;
      return msg;
    }

    // ── Изменено описание ──
    if (subtype === 'notes_changed') {
      if (!taskName) return null;
      const notes = (task?.notes || '').slice(0, 300).trim();
      let msg = `<b>📝 ${LANG === 'ru' ? 'Изменено описание' : 'Description updated'}</b>\n`;
      msg += `📋 <b>${taskName}</b>`;
      if (notes) msg += `\n\n<i>${esc(notes)}${(task?.notes || '').length > 300 ? '...' : ''}</i>`;
      msg += actor + link;
      return msg;
    }

    // ── Переименована задача ──
    if (subtype === 'name_changed') {
      // Пропускаем если задача только создаётся (первое добавление имени)
      const text = story.text || '';
      if (text.includes('added the name')) return null;
      const oldName = esc(story.old_name || '');
      const newName = esc(story.new_name || taskName || '');
      let msg = `<b>✏️ ${LANG === 'ru' ? 'Переименована задача' : 'Task renamed'}</b>\n`;
      if (oldName) msg += `<s>${oldName}</s> →\n`;
      msg += `📋 <b>${newName}</b>`;
      msg += actor + link;
      return msg;
    }

    // ── Кастомные поля (статус, приоритет) ──
    if (subtype === 'enum_custom_field_changed' || subtype === 'text_custom_field_changed' || subtype === 'number_custom_field_changed') {
      if (!taskName) return null;
      const fieldName = esc(story.custom_field?.name || (LANG === 'ru' ? 'Поле' : 'Field'));
      const oldVal    = esc(story.old_enum_value?.name || story.old_text_value || '');
      const newVal    = esc(story.new_enum_value?.name || story.new_text_value || '');
      let msg = `<b>🔄 ${fieldName}</b>\n`;
      msg += `📋 <b>${taskName}</b>\n`;
      if (oldVal) msg += `\n${oldVal} → <b>${newVal}</b>`;
      else        msg += `\n<b>${newVal}</b>`;
      msg += actor + link;
      return msg;
    }

    // Всё остальное — игнорируем
    return null;
  }

  // ── СЕКЦИЯ ───────────────────────────────────────────────────────────────────
  if (type === 'section' && action === 'added') {
    if (isDuplicate(`section:${gid}`)) return null;
    const name = esc(resource?.name || '');
    return `<b>📂 ${LANG === 'ru' ? 'Новая секция создана' : 'New section created'}</b>\n${name}`;
  }

  // ── ВЛОЖЕНИЕ ──────────────────────────────────────────────────────────────────
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
