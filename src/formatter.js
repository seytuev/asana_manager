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
  // Добавляй новых сотрудников сюда:
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

// ── Дедупликация ─────────────────────────────────────────────────────────────
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
  const url = `/tasks/${gid}?opt_fields=name,assignee.name,assignee.email,due_on,permalink_url,projects.name,completed,parent.name,parent.gid,notes,custom_fields`;
  cache.delete(url);
  return get(url);
}

async function getStory(gid) {
  return get(`/stories/${gid}?opt_fields=text,resource_subtype,created_by.name,new_text_value,old_text_value,new_enum_value.name,old_enum_value.name,custom_field.name`);
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

// ─────────────────────────────────────────────────────────────────────────────

async function formatEvent(event) {
  const { action, resource, user, parent, change } = event;
  const type = resource?.resource_type;
  const gid  = resource?.gid;

  // ── ЗАДАЧА ──────────────────────────────────────────────────────────────────
  if (type === 'task') {
    const dedupKey = `task:${gid}:${action}:${change?.field || ''}`;
    if (isDuplicate(dedupKey)) return null;

    // Задержка 3 сек чтобы Asana успела сохранить полное название
    await new Promise(r => setTimeout(r, 3000));

    const task = await getTask(gid);
    if (!task) return null;

    const taskName = (task.name || '').trim();
    if (taskName.length < 2) return null;

    const name    = esc(taskName);
    const project = esc(task.projects?.[0]?.name || '');
    const due     = fmtDate(task.due_on);
    const url     = task.permalink_url;
    const actor   = user?.name ? `\n👁 ${LANG === 'ru' ? 'Кто' : 'By'}: ${esc(user.name)}` : '';
    const link    = url && action !== 'deleted' ? `\n\n<a href="${url}">🔗 ${LANG === 'ru' ? 'Открыть задачу' : 'Open task'}</a>` : '';

    // ── Новая задача ──
    if (action === 'added') {
      // Подзадача
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

      // Обычная задача
      let msg = `<b>➕ ${LANG === 'ru' ? 'Новая задача создана' : 'New task created'}</b>\n`;
      msg += `📋 <b>${name}</b>\n`;
      if (project) msg += `\n📁 ${LANG === 'ru' ? 'Проект' : 'Project'}: ${project}`;
      msg += `\n👤 ${LANG === 'ru' ? 'Исполнитель' : 'Assignee'}: ${assigneeBlock(task)}`;
      msg += `\n📅 ${LANG === 'ru' ? 'Срок' : 'Due'}: ${due}`;
      msg += actor + link + mentionLine(task);
      return msg;
    }

    // ── Удалена ──
    if (action === 'deleted') {
      return `<b>🗑 ${LANG === 'ru' ? 'Задача удалена' : 'Task deleted'}</b>\n📋 <b>${name}</b>${actor}`;
    }

    // ── Изменена ──
    if (action === 'changed') {
      const field = change?.field;

      // Завершена
      if (task.completed) {
        let msg = `<b>✅ ${LANG === 'ru' ? 'Задача выполнена' : 'Task completed'}</b>\n📋 <b>${name}</b>`;
        if (project) msg += `\n📁 ${project}`;
        msg += actor + link + mentionLine(task);
        return msg;
      }

      // Изменён исполнитель
      if (field === 'assignee') {
        const newAssignee = assigneeBlock(task);
        let msg = `<b>👤 ${LANG === 'ru' ? 'Изменён исполнитель' : 'Assignee changed'}</b>\n`;
        msg += `📋 <b>${name}</b>\n`;
        msg += `\n👤 ${LANG === 'ru' ? 'Новый исполнитель' : 'New assignee'}: ${newAssignee}`;
        msg += actor + link + mentionLine(task);
        return msg;
      }

      // Изменён срок
      if (field === 'due_on') {
        let msg = `<b>📅 ${LANG === 'ru' ? 'Изменён срок' : 'Due date changed'}</b>\n`;
        msg += `📋 <b>${name}</b>\n`;
        msg += `\n📅 ${LANG === 'ru' ? 'Новый срок' : 'New due date'}: ${due}`;
        msg += actor + link;
        return msg;
      }

      // Изменено описание
      if (field === 'notes') {
        const notes = (task.notes || '').slice(0, 200).trim();
        let msg = `<b>📝 ${LANG === 'ru' ? 'Изменено описание' : 'Description updated'}</b>\n`;
        msg += `📋 <b>${name}</b>`;
        if (notes) msg += `\n\n<i>${esc(notes)}${task.notes?.length > 200 ? '...' : ''}</i>`;
        msg += actor + link;
        return msg;
      }

      // Изменено название
      if (field === 'name') {
        const oldName = esc(change?.old_value || '');
        let msg = `<b>✏️ ${LANG === 'ru' ? 'Переименована задача' : 'Task renamed'}</b>\n`;
        if (oldName) msg += `<s>${oldName}</s> →\n`;
        msg += `📋 <b>${name}</b>`;
        msg += actor + link;
        return msg;
      }

      // Кастомные поля (статус, приоритет и др.)
      if (field === 'custom_fields' || field?.startsWith('custom_field')) {
        const fieldName = change?.field_name || (LANG === 'ru' ? 'Поле' : 'Field');
        const oldVal = change?.old_display_value || change?.old_value || '';
        const newVal = change?.new_display_value || change?.new_value || '';
        let msg = `<b>🔄 ${LANG === 'ru' ? 'Изменено поле' : 'Field updated'}: ${esc(fieldName)}</b>\n`;
        msg += `📋 <b>${name}</b>\n`;
        if (oldVal) msg += `\n${esc(String(oldVal))} → <b>${esc(String(newVal))}</b>`;
        else        msg += `\n<b>${esc(String(newVal))}</b>`;
        msg += actor + link;
        return msg;
      }

      // Любое другое изменение
      if (field) {
        const fieldLabels = {
          completed:   LANG === 'ru' ? 'Статус'      : 'Status',
          liked:       null, // игнорируем лайки
          memberships: null, // игнорируем перемещение между секциями
          tags:        LANG === 'ru' ? 'Теги'        : 'Tags',
          followers:   null, // игнорируем подписчиков
        };
        const label = fieldLabels[field];
        if (label === null) return null; // явно игнорируемые поля
        if (label) {
          let msg = `<b>🔄 ${LANG === 'ru' ? 'Изменено' : 'Updated'}: ${label}</b>\n📋 <b>${name}</b>`;
          msg += actor + link;
          return msg;
        }
      }

      return null;
    }
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
