// ============================================================
// Tareas — planificador personal sobre Supabase
// ============================================================

const SUPABASE_URL = 'https://zttdbsprkqconspnwzxx.supabase.co';
const SUPABASE_KEY = 'sb_publishable_EhqGSiQhnz0LdYst45viZg_H-J43bX3';
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

const APP_VERSION = '14';
const STALE_DAYS = 10;
const RECURRENCES = { daily: 'Cada día', weekdays: 'Días laborables', weekly: 'Cada semana' };
const BATCH_TEMPLATES = {
  Reel: ['Idea', 'Guion', 'Grabación', 'Edición', 'Programado'],
  Carrusel: ['Idea', 'Copy', 'Diseño', 'Programado'],
  Newsletter: ['Tema', 'Borrador', 'Revisión', 'Enviada'],
  'Post de comunidad': ['Idea', 'Redacción', 'Publicado']
};

const state = {
  view: localStorage.getItem('tareas_view') || 'hoy',
  columns: [],   // { id, title, position }
  tasks: [],     // ver fromRow()
  batches: [],   // { id, title, stages[], stageDates{}, position, items[] }
  hasNewSchema: true,
  hasBatches: true,
  hasEstimates: true,
  hasTrash: true,
  hasIdeas: true,
  ideas: [],
  trash: [],
  offline: false,
  detailId: null,
  addingIn: null,
  loadedAt: 0,
  agenda: { date: null, events: [], errors: [], configured: false }
};

// ===== Utilidades =====
const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(kid));
  }
  return el;
}

const icon = (name) => h('i', { class: 'ti ti-' + name, 'aria-hidden': 'true' });
const ESTIMATES = [15, 30, 60, 90, 120];

function fmtMin(n) {
  if (!n) return '';
  if (n < 60) return n + ' min';
  const hours = Math.floor(n / 60), rest = n % 60;
  return hours + ' h' + (rest ? ' ' + rest : '');
}

// Recordatorio: hora local del día en que toca la tarea
function remindTime(t) {
  if (!t.remindAt) return '';
  const d = new Date(t.remindAt);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

function setRemind(t, hhmm) {
  if (!hhmm) { t.remindAt = null; return; }
  const [hh, mm] = hhmm.split(':').map(Number);
  const base = parseISO(t.scheduledOn && t.scheduledOn >= today() ? t.scheduledOn : today());
  base.setHours(hh, mm, 0, 0);
  t.remindAt = base.toISOString();
}

const sumMinutes = (list) => list.reduce((total, t) => total + (t.estimateMin || 0), 0);

// Próximo día de la semana (1 = lunes), siempre en el futuro
function nextWeekday(target) {
  let d = addDays(today(), 1);
  while (parseISO(d).getDay() !== target) d = addDays(d, 1);
  return d;
}

const emptyState = (ic, title, text) => h('div', { class: 'empty-state' }, icon(ic), h('strong', {}, title), text);
const uuid = () => crypto.randomUUID();
const pad = (n) => String(n).padStart(2, '0');
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const parseISO = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (s, n) => { const d = parseISO(s); d.setDate(d.getDate() + n); return iso(d); };
const daysBetween = (a, b) => Math.round((parseISO(b) - parseISO(a)) / 86400000);

function fmtDate(s) {
  const diff = daysBetween(today(), s);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === -1) return 'ayer';
  const opts = { weekday: 'short', day: 'numeric', month: 'short' };
  return parseISO(s).toLocaleDateString('es-ES', opts).replace(/\./g, '');
}

function slug(name) {
  return (name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

let toastTimer = null;
function toast(msg, ms = 2400, action) {
  const el = $('#toast');
  el.replaceChildren(msg);
  if (action) {
    el.append(h('button', { class: 'toast-action', onclick: () => { el.classList.remove('on'); action.onclick(); } }, action.label));
  }
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

// ===== Columnas especiales =====
const colBySlug = (s) => state.columns.find(c => slug(c.title) === s);
const hoyCol = () => colBySlug('hoy');
const hechoCol = () => colBySlug('hecho');
const somedayCol = () => colBySlug('algun-dia');
const firstOpenCol = () => state.columns.find(c => c !== hechoCol());
const colTasks = (colId) => state.tasks.filter(t => t.columnId === colId).sort((a, b) => a.position - b.position);

// ===== Guardado: cola de operaciones que sobrevive a quedarse sin conexión =====
// Cada cambio se convierte en una operación serializable. Si no hay red, la operación
// espera en el dispositivo y se reintenta al volver la conexión.
const OPS_KEY = 'tareas_ops';
const SNAPSHOT_KEY = 'tareas_datos';
let ops = [];
try { ops = JSON.parse(localStorage.getItem(OPS_KEY) || '[]'); } catch (e) { ops = []; }
let flushing = false;

const persistOps = () => { try { localStorage.setItem(OPS_KEY, JSON.stringify(ops)); } catch (e) { /* sin espacio */ } };
const isNetworkError = (e) => !navigator.onLine || e instanceof TypeError ||
  /fetch|network|failed to|timeout|conexi/i.test(String(e && e.message));

function setSaveState(kind, msg) {
  const el = $('#saveState');
  el.className = 'save-state' + (kind === 'saved' ? '' : ' ' + kind);
  const pend = ops.length;
  $('#saveText').textContent = kind === 'saving' ? 'Guardando…'
    : kind === 'offline' ? (pend === 1 ? '1 cambio sin enviar' : pend + ' cambios sin enviar')
    : kind === 'error' ? 'Sin guardar' : 'Guardado';
  if (kind === 'error') toast('No se ha podido guardar: ' + (msg || 'error de Supabase'), 5000);
}

async function run(query) {
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

function addOp(op) {
  op.tries = 0;
  ops.push(op);
  persistOps();
  saveSnapshot();
  flushOps();
}

function applyOp(op) {
  const q = sb.from(op.table);
  if (op.action === 'upsert') return run(q.upsert(op.rows));
  if (op.action === 'deleteIn') return run(q.delete().in('id', op.ids));
  return Promise.reject(new Error('Operación desconocida: ' + op.action));
}

async function flushOps() {
  if (flushing) return;
  if (!ops.length) { setSaveState('saved'); return; }
  flushing = true;
  setSaveState('saving');
  while (ops.length) {
    const op = ops[0];
    try {
      await applyOp(op);
      ops.shift();
      persistOps();
    } catch (e) {
      flushing = false;
      if (isNetworkError(e)) { setSaveState('offline'); return; }
      op.tries = (op.tries || 0) + 1;
      console.error('Error de Supabase:', e);
      if (op.tries >= 3) { ops.shift(); persistOps(); }
      setSaveState('error', e && e.message);
      return;
    }
  }
  flushing = false;
  setSaveState('saved');
  state.offline = false;
}

// Copia local de los datos: permite abrir la app sin conexión
function saveSnapshot() {
  try {
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({
      at: Date.now(), columns: state.columns, tasks: state.tasks, trash: state.trash, batches: state.batches, ideas: state.ideas
    }));
  } catch (e) { /* sin espacio */ }
}

function loadSnapshot() {
  try {
    const raw = JSON.parse(localStorage.getItem(SNAPSHOT_KEY) || 'null');
    if (!raw || !raw.columns) return false;
    state.columns = raw.columns; state.tasks = raw.tasks || []; state.trash = raw.trash || []; state.batches = raw.batches || []; state.ideas = raw.ideas || [];
    state.loadedAt = raw.at || 0;
    return true;
  } catch (e) { return false; }
}

window.addEventListener('online', () => { flushOps(); });
window.addEventListener('offline', () => { if (ops.length) setSaveState('offline'); });

function taskRow(t) {
  const row = {
    id: t.id,
    title: t.title,
    description: t.note || null,
    column_id: t.columnId,
    position: t.position,
    priority: t.checked ? 'done' : (t.urgent ? 'urgent' : null),
    subtasks_data: t.subtasks.length ? JSON.stringify(t.subtasks) : null
  };
  if (state.hasNewSchema) {
    row.scheduled_on = t.scheduledOn;
    row.deadline_on = t.deadlineOn;
    row.recurrence = t.recurrence;
    row.last_done_on = t.lastDoneOn;
    row.completed_at = t.completedAt;
  }
  if (state.hasEstimates) row.estimate_min = t.estimateMin;
  if (state.hasTrash) { row.deleted_at = t.deletedAt; row.remind_at = t.remindAt; }
  return row;
}

function saveTasks(list) {
  const rows = [...new Set(list)].map(taskRow);
  if (rows.length) addOp({ table: 'tasks', action: 'upsert', rows });
}

function saveColumns() {
  addOp({ table: 'columns', action: 'upsert', rows: state.columns.map(c => ({ id: c.id, title: c.title, position: c.position })) });
}

function deleteTasks(ids) {
  for (let i = 0; i < ids.length; i += 50) addOp({ table: 'tasks', action: 'deleteIn', ids: ids.slice(i, i + 50) });
}

const saveIdea = (i) => addOp({ table: 'ideas', action: 'upsert', rows: [{ id: i.id, text: i.text, note: i.note || null, source: i.source || 'app', archived_at: i.archivedAt || null }] });
const saveBatch = (b) => addOp({ table: 'batches', action: 'upsert', rows: [{ id: b.id, title: b.title, stages: b.stages, stage_dates: b.stageDates, position: b.position }] });
const saveItems = (items) => addOp({ table: 'batch_items', action: 'upsert', rows: items.map(i => ({ id: i.id, batch_id: i.batchId, title: i.title, stage: i.stage, position: i.position })) });

// Renumera una columna y devuelve las tareas cuya posición ha cambiado
function renumber(colId) {
  const changed = [];
  colTasks(colId).forEach((t, i) => { if (t.position !== i) { t.position = i; changed.push(t); } });
  return changed;
}

// ===== Carga =====
function fromRow(r, migrated) {
  let subtasks = [];
  try { subtasks = r.subtasks_data ? JSON.parse(r.subtasks_data) : []; } catch (e) { subtasks = []; }
  const t = {
    id: r.id,
    title: r.title || '',
    note: r.description || '',
    columnId: r.column_id,
    position: r.position || 0,
    checked: r.priority === 'done' || !!r.completed_at,
    urgent: r.priority === 'urgent',
    subtasks,
    scheduledOn: r.scheduled_on || null,
    deadlineOn: r.deadline_on || null,
    recurrence: r.recurrence || null,
    lastDoneOn: r.last_done_on || null,
    completedAt: r.completed_at || null,
    estimateMin: r.estimate_min || null,
    deletedAt: r.deleted_at || null,
    remindAt: r.remind_at || null,
    createdAt: r.created_at || null
  };
  // Prefijos antiguos (!!! urgente, >>> recurrente): se convierten en campos reales
  if (state.hasNewSchema) {
    const urgent = t.title.match(/^(🔴|!!!)\s*/);
    if (urgent) { t.title = t.title.slice(urgent[0].length); t.urgent = true; migrated.push(t); }
    const recur = t.title.match(/^>>>\s*/);
    if (recur) {
      t.title = t.title.slice(recur[0].length);
      t.recurrence = t.recurrence || 'daily';
      if (t.checked) { t.checked = false; t.completedAt = null; t.lastDoneOn = today(); t.scheduledOn = nextOccurrence(t); }
      migrated.push(t);
    }
  }
  return t;
}

async function loadAll() {
  const probeTasks = await sb.from('tasks').select('scheduled_on').limit(1);
  state.hasNewSchema = !probeTasks.error;
  const probeBatches = await sb.from('batches').select('id').limit(1);
  state.hasBatches = !probeBatches.error;
  const probeEstimate = await sb.from('tasks').select('estimate_min').limit(1);
  state.hasEstimates = !probeEstimate.error;
  const probeTrash = await sb.from('tasks').select('deleted_at').limit(1);
  state.hasTrash = !probeTrash.error;
  const probeIdeas = await sb.from('ideas').select('id').limit(1);
  state.hasIdeas = !probeIdeas.error;

  const cols = await run(sb.from('columns').select('*').order('position'));
  const rows = await run(sb.from('tasks').select('*').order('position'));

  state.columns = cols.map(c => ({ id: c.id, title: c.title, position: c.position || 0 }));
  const migrated = [];
  const all = rows.filter(r => state.columns.some(c => c.id === r.column_id)).map(r => fromRow(r, migrated));
  state.tasks = all.filter(t => !t.deletedAt);
  state.trash = all.filter(t => t.deletedAt).sort((a, b) => (b.deletedAt || '').localeCompare(a.deletedAt || ''));

  // Las recurrentes que estaban en Hecho vuelven a la primera lista
  const hecho = hechoCol(), first = firstOpenCol();
  if (hecho && first) {
    let moved = false;
    for (const t of state.tasks) {
      if (t.recurrence && t.columnId === hecho.id) { t.columnId = first.id; t.position = 9999; migrated.push(t); moved = true; }
    }
    if (moved) migrated.push(...renumber(first.id));
  }
  if (migrated.length) saveTasks(migrated);

  state.ideas = [];
  if (state.hasIdeas) {
    const rows = await run(sb.from('ideas').select('*').is('archived_at', null).order('created_at', { ascending: false }));
    state.ideas = rows.map(r => ({ id: r.id, text: r.text, note: r.note || '', source: r.source || 'app', createdAt: r.created_at }));
  }

  state.batches = [];
  if (state.hasBatches) {
    const bs = await run(sb.from('batches').select('*').order('position'));
    const items = await run(sb.from('batch_items').select('*').order('position'));
    state.batches = bs.map(b => ({
      id: b.id, title: b.title, stages: b.stages || [], stageDates: b.stage_dates || {}, position: b.position || 0,
      items: items.filter(i => i.batch_id === b.id).map(i => ({ id: i.id, batchId: b.id, title: i.title, stage: i.stage || 0, position: i.position || 0 }))
    }));
  }
  state.loadedAt = Date.now();
}

// ===== Agenda: eventos de los calendarios externos, leídos por la función tareas-api =====
const FUNCTION_URL = SUPABASE_URL + '/functions/v1/tareas-api';

async function callFunction(path) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) throw new Error('Sin sesión');
  const res = await fetch(FUNCTION_URL + path, { headers: { Authorization: 'Bearer ' + session.access_token } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Error ' + res.status);
  return body;
}

async function loadAgenda() {
  try {
    const day = today();
    const r = await callFunction('/calendar?from=' + day + '&to=' + day);
    state.agenda = { date: day, events: r.events || [], errors: r.errors || [], configured: !!r.configured };
  } catch (e) {
    console.error('No se ha podido leer la agenda:', e);
    state.agenda = { date: today(), events: [], errors: [e.message], configured: state.agenda.configured };
  }
  if (state.view === 'hoy' && !state.detailId) render();
}

// ===== Reglas de negocio =====
// La próxima vez que toca. Semanal se ancla al día que tenía puesto (los lunes siguen siendo lunes)
function nextOccurrence(t) {
  if (t.recurrence === 'weekly') {
    let next = addDays(t.scheduledOn || today(), 7);
    while (next <= today()) next = addDays(next, 7);
    return next;
  }
  let next = addDays(today(), 1);
  if (t.recurrence === 'weekdays') {
    while ([0, 6].includes(parseISO(next).getDay())) next = addDays(next, 1);
  }
  return next;
}

const isDoneToday = (t) => (t.recurrence && t.lastDoneOn === today()) ||
  (t.checked && t.completedAt && iso(new Date(t.completedAt)) === today());

function isToday(t) {
  if (t.checked) return false;
  const now = today();
  if (t.scheduledOn && t.scheduledOn <= now) return true;
  if (t.deadlineOn && t.deadlineOn <= now) return true;
  const hoy = hoyCol();
  return !!hoy && t.columnId === hoy.id && !(t.scheduledOn && t.scheduledOn > now);
}

const isUpcoming = (t) => !t.checked && !isToday(t) &&
  ((t.scheduledOn && t.scheduledOn > today()) || (t.deadlineOn && t.deadlineOn > today()));

function ageDays(t) { return t.createdAt ? daysBetween(iso(new Date(t.createdAt)), today()) : 0; }

function isStale(t) {
  const hecho = hechoCol(), someday = somedayCol();
  return !t.checked && !t.recurrence && !isToday(t) && !isUpcoming(t) &&
    !(hecho && t.columnId === hecho.id) && !(someday && t.columnId === someday.id) &&
    ageDays(t) >= STALE_DAYS;
}

function toggleTask(t) {
  const touched = [t];
  if (!t.checked && t.recurrence && t.lastDoneOn === today()) {
    // Deshacer una recurrente marcada hoy
    t.lastDoneOn = null;
    t.scheduledOn = today();
  } else if (!t.checked && t.recurrence && state.hasNewSchema) {
    // Una recurrente no se archiva: se marca como hecha hoy y vuelve en su próxima fecha
    t.lastDoneOn = today();
    t.scheduledOn = nextOccurrence(t);
    t.subtasks.forEach(s => { s.checked = false; });
    toast('Hecha. Vuelve ' + fmtDate(t.scheduledOn));
  } else {
    t.checked = !t.checked;
    t.completedAt = t.checked ? new Date().toISOString() : null;
    const hecho = hechoCol();
    const from = t.columnId;
    if (t.checked && hecho && t.columnId !== hecho.id) {
      colTasks(hecho.id).forEach(o => { o.position += 1; touched.push(o); });
      t.columnId = hecho.id; t.position = 0;
      touched.push(...renumber(from));
    } else if (!t.checked && hecho && t.columnId === hecho.id) {
      const dest = hoyCol() || firstOpenCol();
      if (dest) { t.columnId = dest.id; t.position = colTasks(dest.id).length; touched.push(...renumber(from)); }
    }
  }
  saveTasks(touched);
  render();
}

function moveTask(t, colId, index) {
  const from = t.columnId;
  const dest = colTasks(colId).filter(o => o !== t);
  dest.splice(index == null ? dest.length : index, 0, t);
  t.columnId = colId;
  dest.forEach((o, i) => { o.position = i; });
  const hecho = hechoCol();
  if (hecho) {
    if (colId === hecho.id && !t.checked && !t.recurrence) { t.checked = true; t.completedAt = new Date().toISOString(); }
    if (colId !== hecho.id && from === hecho.id && t.checked) { t.checked = false; t.completedAt = null; }
  }
  saveTasks([...dest, ...(from !== colId ? renumber(from) : [])]);
  render();
}

function createTask(fields) {
  const colId = fields.columnId || (firstOpenCol() || {}).id;
  if (!colId) { toast('Crea primero una lista en el tablero'); return null; }
  const t = {
    id: uuid(), title: fields.title, note: '', columnId: colId, position: colTasks(colId).length,
    checked: false, urgent: !!fields.urgent, subtasks: [],
    scheduledOn: fields.scheduledOn || null, deadlineOn: null, recurrence: fields.recurrence || null,
    lastDoneOn: null, completedAt: null, estimateMin: fields.estimateMin || null,
    deletedAt: null, remindAt: fields.remindAt || null, createdAt: new Date().toISOString()
  };
  state.tasks.push(t);
  saveTasks([t]);
  return t;
}

// Borrar aparta la tarea a la papelera; se vacía sola a los 30 días
function trashTasks(list, mensaje) {
  const ids = new Set(list.map(t => t.id));
  const cols = new Set(list.map(t => t.columnId));
  const stamp = new Date().toISOString();
  list.forEach(t => { t.deletedAt = stamp; });
  state.tasks = state.tasks.filter(t => !ids.has(t.id));
  state.trash = [...list, ...state.trash];
  const moved = [];
  cols.forEach(id => moved.push(...renumber(id)));
  if (state.hasTrash) saveTasks([...list, ...moved]);
  else { deleteTasks([...ids]); saveTasks(moved); }
  render();
  toast(mensaje, 7000, state.hasTrash ? { label: 'Deshacer', onclick: () => restoreTasks(list) } : null);
}

function restoreTasks(list) {
  const ids = new Set(list.map(t => t.id));
  state.trash = state.trash.filter(t => !ids.has(t.id));
  list.forEach(t => {
    t.deletedAt = null;
    if (!state.columns.some(c => c.id === t.columnId)) t.columnId = (firstOpenCol() || state.columns[0]).id;
    t.position = colTasks(t.columnId).length;
    state.tasks.push(t);
  });
  saveTasks(list);
  render();
  toast(list.length === 1 ? 'Tarea recuperada' : list.length + ' tareas recuperadas');
}

function purgeTasks(list) {
  const ids = new Set(list.map(t => t.id));
  state.trash = state.trash.filter(t => !ids.has(t.id));
  deleteTasks([...ids]);
  render();
}

function removeTask(t) {
  trashTasks([t], 'Tarea borrada');
}

async function clearDone() {
  const hecho = hechoCol();
  const done = state.tasks.filter(t => (t.checked || (hecho && t.columnId === hecho.id)) && !t.recurrence);
  if (!done.length) { toast('No hay tareas completadas que borrar'); return; }
  const label = done.length === 1 ? '1 tarea completada' : done.length + ' tareas completadas';
  if (!await confirmModal('¿Borrar ' + label + '?', state.hasTrash ? 'Van a la papelera y se borran solas a los 30 días.' : 'No se puede deshacer.', 'Borrar')) return;
  trashTasks(done, 'Borradas ' + label);
}

// ===== Alta rápida en lenguaje natural =====
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

function parseQuick(text) {
  let t = ' ' + text.trim() + ' ';
  const out = {};
  const take = (re, fn) => {
    const m = t.match(re);
    if (m && fn(m) !== false) t = t.replace(m[0], ' ');
  };
  take(/\s(!{1,3}|urgente)(?=\s)/i, () => { out.urgent = true; });
  take(/\scada d[ií]a(?=\s)/i, () => { out.recurrence = 'daily'; });
  take(/\scada semana(?=\s)/i, () => { out.recurrence = 'weekly'; });
  take(/\s(d[ií]as )?laborables(?=\s)/i, () => { out.recurrence = 'weekdays'; });
  take(/\spasado ma[ñn]ana(?=\s)/i, () => { out.scheduledOn = addDays(today(), 2); });
  take(/\sma[ñn]ana(?=\s)/i, () => { if (out.scheduledOn) return false; out.scheduledOn = addDays(today(), 1); });
  take(/\shoy(?=\s)/i, () => { if (out.scheduledOn) return false; out.scheduledOn = today(); });
  take(/\s(?:el )?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(?=\s)/i, (m) => {
    if (out.scheduledOn) return false;
    const target = WEEKDAYS.indexOf(slug(m[1]));
    let d = addDays(today(), 1);
    while (parseISO(d).getDay() !== target) d = addDays(d, 1);
    out.scheduledOn = d;
  });
  take(/\s(?:el )?(\d{1,2})\/(\d{1,2})(?=\s)/, (m) => {
    if (out.scheduledOn) return false;
    const now = new Date();
    let d = new Date(now.getFullYear(), Number(m[2]) - 1, Number(m[1]));
    if (iso(d) < today()) d = new Date(now.getFullYear() + 1, Number(m[2]) - 1, Number(m[1]));
    out.scheduledOn = iso(d);
  });
  take(/\s(?:a las\s)?(\d{1,2})[:.](\d{2})(?=\s)/, (m) => {
    const hh = Number(m[1]), mm = Number(m[2]);
    if (hh > 23 || mm > 59) return false;
    out.remindHM = String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0');
  });
  take(/\s#([\p{L}\d-]+)(?=\s)/u, (m) => {
    const tag = slug(m[1]);
    const col = state.columns.find(c => slug(c.title).startsWith(tag)) || state.columns.find(c => slug(c.title).includes(tag));
    if (!col) return false;
    out.columnId = col.id;
  });
  out.title = t.replace(/\s+/g, ' ').trim();
  return out;
}

function quickAdd(text, defaults) {
  const p = parseQuick(text);
  if (!p.title) return;
  if (p.recurrence && !p.scheduledOn) p.scheduledOn = today();
  if (!p.scheduledOn && defaults.scheduledOn) p.scheduledOn = defaults.scheduledOn;
  if (!state.hasNewSchema) { p.scheduledOn = null; p.recurrence = null; }
  if (!p.columnId) {
    const future = p.scheduledOn && p.scheduledOn > today();
    const col = future ? (colBySlug('esta-semana') || firstOpenCol()) : (hoyCol() || firstOpenCol());
    p.columnId = col && col.id;
  }
  const t = createTask(p);
  if (!t) return;
  if (p.remindHM && state.hasTrash) { setRemind(t, p.remindHM); saveTasks([t]); }
  const col = state.columns.find(c => c.id === t.columnId);
  toast('Añadida a ' + col.title + (t.scheduledOn ? ' · ' + fmtDate(t.scheduledOn) : '') + (t.remindAt ? ' · aviso a las ' + remindTime(t) : ''));
  render();
  const input = $('#quickInput');
  if (input) input.focus();
}

// ===== Componentes =====
function checkBtn(on, onclick, square) {
  return h('button', { class: 'check' + (square ? ' sq' : '') + (on ? ' on' : ''), 'aria-label': on ? 'Desmarcar' : 'Completar', onclick: (e) => { e.stopPropagation(); onclick(); } }, icon('check'));
}

function taskChips(t, opts = {}) {
  const chips = [];
  const now = today();
  if (t.urgent) chips.push(h('span', { class: 'chip urgent' }, 'Urgente'));
  if (t.deadlineOn) chips.push(h('span', { class: 'chip ' + (t.deadlineOn <= now && !t.checked ? 'late' : 'date') }, icon('flag'), 'Vence ' + fmtDate(t.deadlineOn)));
  if (t.scheduledOn && !opts.hideDate && !(t.recurrence && t.lastDoneOn === now)) {
    chips.push(h('span', { class: 'chip ' + (t.scheduledOn < now && !t.checked ? 'late' : 'date') }, icon('calendar'), fmtDate(t.scheduledOn)));
  }
  if (t.recurrence) chips.push(h('span', { class: 'chip recur' }, icon('repeat'), RECURRENCES[t.recurrence] || t.recurrence));
  if (t.estimateMin) chips.push(h('span', { class: 'chip' }, icon('clock'), fmtMin(t.estimateMin)));
  if (t.remindAt && !t.checked) chips.push(h('span', { class: 'chip recur' }, icon('bell'), remindTime(t)));
  if (t.subtasks.length) chips.push(h('span', { class: 'chip' }, icon('list-check'), t.subtasks.filter(s => s.checked).length + '/' + t.subtasks.length));
  if (opts.showList) {
    const col = state.columns.find(c => c.id === t.columnId);
    if (col) chips.push(h('span', { class: 'chip' }, col.title));
  }
  if (opts.showAge && ageDays(t) >= STALE_DAYS) chips.push(h('span', { class: 'chip' }, 'Lleva ' + ageDays(t) + ' días'));
  return chips;
}

function taskRowEl(t, opts = {}) {
  const done = t.checked || (t.recurrence && t.lastDoneOn === today());
  return h('div', { class: 'row' + (done ? ' done' : '') },
    checkBtn(done, () => toggleTask(t)),
    h('div', { class: 'row-main', onclick: () => openDetail(t.id) },
      h('div', { class: 'row-title' }, t.title),
      t.note && !done ? h('div', { class: 'row-note' }, t.note) : null,
      h('div', { class: 'row-meta' }, done ? [] : taskChips(t, opts))
    ),
    opts.actions ? h('div', { class: 'row-actions' }, opts.actions(t)) : null
  );
}

function quickBar(placeholder, defaults) {
  const input = h('input', { id: 'quickInput', type: 'text', placeholder, autocomplete: 'off', onkeydown: (e) => {
    if (e.key === 'Enter' && input.value.trim()) { quickAdd(input.value, defaults); }
    if (e.key === 'Escape') input.blur();
  } });
  return [
    h('div', { class: 'quick' }, icon('plus'), input, h('kbd', {}, 'N')),
    h('p', { class: 'quick-hint' }, state.hasNewSchema
      ? 'Entiende fechas y listas: “Grabar reel mañana”, “Facturación viernes !”, “Revisar DMs cada día”, “#espera”.'
      : 'Escribe y pulsa Enter.')
  ];
}

// ===== Aplazar rápido =====
function closePopMenu() {
  const el = $('.popmenu');
  if (el) el.remove();
}

function popMenu(anchor, items) {
  closePopMenu();
  const menu = h('div', { class: 'popmenu' }, items.map(it =>
    h('button', { onclick: () => { closePopMenu(); it.onclick(); } }, it.icon ? icon(it.icon) : null, it.label,
      it.hint ? h('span', { class: 'hint' }, it.hint) : null)));
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const box = menu.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 6, window.innerHeight - box.height - 8) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - box.width, window.innerWidth - box.width - 8)) + 'px';
  setTimeout(() => {
    const close = (e) => { if (!menu.contains(e.target)) { closePopMenu(); document.removeEventListener('click', close); } };
    document.addEventListener('click', close);
  }, 10);
}

function setWhen(t, value, label) {
  t.scheduledOn = value;
  if (value && t.checked) { t.checked = false; t.completedAt = null; }
  saveTasks([t]);
  render();
  toast(value ? label + ' · ' + fmtDate(value) : 'Sin fecha');
}

function snoozeButton(t) {
  return h('button', { class: 'icon-btn', title: 'Aplazar', 'aria-label': 'Aplazar', onclick: (e) => {
    e.stopPropagation();
    const someday = somedayCol();
    popMenu(e.currentTarget, [
      { label: 'Hoy', icon: 'sun', hint: fmtDate(today()), onclick: () => setWhen(t, today(), 'Para hoy') },
      { label: 'Mañana', icon: 'arrow-right', hint: fmtDate(addDays(today(), 1)), onclick: () => setWhen(t, addDays(today(), 1), 'Aplazada') },
      nextWeekday(1) !== addDays(today(), 1) ? { label: 'El lunes', icon: 'calendar', hint: fmtDate(nextWeekday(1)), onclick: () => setWhen(t, nextWeekday(1), 'Aplazada') } : null,
      { label: 'En una semana', icon: 'calendar-plus', hint: fmtDate(addDays(today(), 7)), onclick: () => setWhen(t, addDays(today(), 7), 'Aplazada') },
      someday ? { label: 'Algún día', icon: 'bulb', onclick: () => { t.scheduledOn = null; moveTask(t, someday.id); toast('A Algún día'); } } : null,
      t.scheduledOn ? { label: 'Quitar la fecha', icon: 'x', onclick: () => setWhen(t, null) } : null
    ].filter(Boolean));
  } }, icon('clock'));
}

// ===== Planificador del día =====
function plannerCandidates() {
  const now = today();
  const hecho = hechoCol(), hoy = hoyCol(), someday = somedayCol();
  const open = state.tasks.filter(t => !t.checked && !isDoneToday(t) && !(hecho && t.columnId === hecho.id));
  const score = (t) => {
    if (t.deadlineOn && t.deadlineOn <= now) return 0;            // vence o ha vencido
    if (t.scheduledOn && t.scheduledOn < now) return 1;           // atrasada
    if (t.scheduledOn === now) return 2;                          // ya era para hoy
    if (hoy && t.columnId === hoy.id) return 3;                   // está en la lista Hoy
    return 4;                                                      // parada en otra lista
  };
  return open.filter(t => {
    if (t.scheduledOn && t.scheduledOn > now) return false;        // ya tiene día futuro
    if (someday && t.columnId === someday.id) return false;        // Algún día no entra en el plan
    return score(t) < 4 || ageDays(t) >= STALE_DAYS;
  }).sort((a, b) => score(a) - score(b) || ageDays(b) - ageDays(a));
}

function plannerModal() {
  const queue = plannerCandidates();
  if (!queue.length) { toast('No hay nada que planificar: Hoy ya está decidido'); return; }
  let i = 0;
  const box = h('div', {});
  openModal(box);

  const planned = () => state.tasks.filter(isToday);

  const decide = (fn) => { fn(); saveTasks([queue[i]]); i++; draw(); };

  const draw = () => {
    const chosen = planned();
    const mins = sumMinutes(chosen);
    const resumen = chosen.length + (chosen.length === 1 ? ' tarea' : ' tareas') + (mins ? ' · ' + fmtMin(mins) : '');

    if (i >= queue.length) {
      box.replaceChildren(
        h('h3', {}, 'Plan listo'),
        h('p', {}, 'Hoy tienes ' + resumen + '.'),
        chosen.length > 5 ? h('p', { style: 'color: var(--warn-text); margin-top: 8px;' }, 'Son bastantes para un día. Puedes aplazar alguna desde la lista con el reloj.') : null,
        h('div', { class: 'modal-foot' }, h('button', { class: 'btn primary', onclick: () => { closeModal(); render(); } }, 'Ver mi día')));
      return;
    }

    const t = queue[i];
    box.replaceChildren(
      h('div', { class: 'plan-head' },
        h('h3', {}, 'Planear el día'),
        h('span', {}, (i + 1) + ' de ' + queue.length)),
      h('div', { class: 'plan-card' },
        h('div', { class: 'plan-title' }, t.title),
        t.note ? h('div', { class: 'row-note' }, t.note) : null,
        h('div', { class: 'row-meta' }, taskChips(t, { showList: true, showAge: true }))),
      h('h4', {}, '¿Cuánto te llevará?'),
      h('div', { class: 'inline' }, ESTIMATES.map(m =>
        h('button', { class: 'btn small' + (t.estimateMin === m ? ' on' : ''), onclick: () => { t.estimateMin = t.estimateMin === m ? null : m; draw(); } }, fmtMin(m)))),
      h('h4', {}, '¿Cuándo?'),
      h('div', { class: 'plan-actions' },
        h('button', { class: 'btn primary', onclick: () => decide(() => { t.scheduledOn = today(); }) }, icon('sun'), 'Hoy'),
        h('button', { class: 'btn', onclick: () => decide(() => { t.scheduledOn = addDays(today(), 1); }) }, 'Mañana'),
        nextWeekday(1) !== addDays(today(), 1)
          ? h('button', { class: 'btn', onclick: () => decide(() => { t.scheduledOn = nextWeekday(1); }) }, 'El lunes')
          : h('button', { class: 'btn', onclick: () => decide(() => { t.scheduledOn = addDays(today(), 7); }) }, 'En una semana'),
        somedayCol() ? h('button', { class: 'btn', onclick: () => decide(() => { t.scheduledOn = null; t.columnId = somedayCol().id; t.position = colTasks(somedayCol().id).length; }) }, 'Algún día') : null,
        h('button', { class: 'btn', onclick: () => { i++; draw(); } }, 'Saltar'),
        h('button', { class: 'btn danger', onclick: async () => {
          if (!await confirmModal('¿Borrar esta tarea?', t.title, 'Borrar')) { openModal(box); draw(); return; }
          removeTask(t); i++; openModal(box); draw();
        } }, icon('trash'))),
      h('p', { class: 'plan-foot' }, 'En el plan de hoy: ' + resumen));
  };
  draw();
}

// ===== Vistas =====
const VIEWS = {
  hoy: { title: 'Hoy', icon: 'sun' },
  proximo: { title: 'Próximo', icon: 'calendar' },
  tablero: { title: 'Tablero', icon: 'layout-kanban' },
  lotes: { title: 'Lotes', icon: 'stack-2' },
  ideas: { title: 'Ideas', icon: 'bulb' },
  revision: { title: 'Revisión', icon: 'eye-check', hidden: true },
  hecho: { title: 'Hecho', icon: 'archive' },
  papelera: { title: 'Papelera', icon: 'trash', hidden: true }
};

function batchDueToday() {
  const out = [];
  for (const b of state.batches) {
    b.stages.forEach((name, k) => {
      const date = b.stageDates[k];
      const n = b.items.filter(i => i.stage === k).length;
      if (date && date <= today() && n) out.push({ batch: b, name, n, date });
    });
  }
  return out;
}

function renderHoy(view) {
  // Orden del día: urgente, lo que vence o está atrasado, recurrente y el resto como lo tengas puesto
  const rank = (t) => t.urgent ? 0
    : (t.deadlineOn && t.deadlineOn <= today()) || (t.scheduledOn && t.scheduledOn < today()) ? 1
    : t.recurrence ? 2 : 3;
  const active = state.tasks.filter(isToday).sort((a, b) => rank(a) - rank(b) || a.position - b.position);
  const doneToday = state.tasks.filter(isDoneToday);
  const stale = state.tasks.filter(isStale);
  const batchRows = batchDueToday();

  const total = active.length + doneToday.length;
  const mins = sumMinutes(active);
  $('#viewSub').textContent = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long' }) +
    (total ? ' · ' + doneToday.length + ' de ' + total + ' hechas' : '') + (mins ? ' · quedan ' + fmtMin(mins) : '');
  $('#viewActions').append(h('button', { class: 'btn', onclick: plannerModal }, icon('wand'), 'Planear el día'));

  const box = h('div', { class: 'narrow' }, quickBar('Añadir una tarea para hoy…', { scheduledOn: today() }));
  if (stale.length) {
    box.append(h('button', { class: 'side-note', style: 'margin: 0 0 8px; width: 100%;', onclick: () => setView('revision') },
      stale.length === 1 ? 'Hay 1 tarea parada desde hace más de ' + STALE_DAYS + ' días. Revísala.' :
        'Hay ' + stale.length + ' tareas paradas desde hace más de ' + STALE_DAYS + ' días. Revísalas.'));
  }
  const agenda = state.agenda.date === today() ? state.agenda : { events: [], errors: [], configured: false };
  if (agenda.events.length || (agenda.configured && agenda.errors.length)) {
    box.append(h('div', { class: 'group-title', style: 'margin-top: 10px;' }, 'Agenda'));
    const nowTime = new Date().toTimeString().slice(0, 5);
    agenda.events.forEach(ev => box.append(h('div', { class: 'agenda-row' + (!ev.allDay && ev.end && ev.end < nowTime ? ' past' : '') },
      h('span', { class: 'agenda-time' }, ev.allDay ? 'Todo el día' : ev.time + (ev.end ? '–' + ev.end : '')),
      h('span', { class: 'agenda-title' }, ev.title))));
    agenda.errors.forEach(msg => box.append(h('div', { class: 'agenda-row past' }, h('span', { class: 'agenda-time' }, icon('alert-triangle')), h('span', {}, 'No se ha podido leer un calendario (' + msg + ')'))));
    box.append(h('div', { class: 'group-title' }, 'Tareas'));
  }
  for (const r of batchRows) {
    box.append(h('div', { class: 'row' }, h('span', { class: 'check', style: 'border-style: dashed;' }),
      h('div', { class: 'row-main', onclick: () => setView('lotes') },
        h('div', { class: 'row-title' }, r.name + ' · ' + r.batch.title),
        h('div', { class: 'row-meta' }, h('span', { class: 'chip recur' }, icon('stack-2'), r.n === 1 ? '1 pieza' : r.n + ' piezas'),
          r.date < today() ? h('span', { class: 'chip late' }, 'Era ' + fmtDate(r.date)) : null))));
  }
  if (active.length > 5 || mins > 240) {
    box.append(h('button', { class: 'note', onclick: plannerModal },
      icon('alert-triangle'),
      h('span', {}, 'Hoy va cargado: ' + active.length + ' tareas' + (mins ? ' y ' + fmtMin(mins) : '') + '. Planea el día y aplaza lo que no sea de hoy.')));
  }
  active.forEach(t => box.append(taskRowEl(t, { hideDate: t.scheduledOn === today(), actions: (task) => [snoozeButton(task)] })));
  if (!active.length && !batchRows.length) {
    box.append(doneToday.length ? emptyState('circle-check', 'Todo hecho por hoy', 'Lo que completes mañana volverá a empezar de cero.')
      : emptyState('sun', 'Nada planificado para hoy', 'Escribe una tarea arriba o abre una del tablero y ponle fecha de hoy.'));
  }
  if (doneToday.length) {
    box.append(h('div', { class: 'group-title' }, 'Hechas hoy'));
    doneToday.forEach(t => box.append(taskRowEl(t)));
  }
  view.append(box);
}

function renderProximo(view) {
  const list = state.tasks.filter(isUpcoming);
  const keyOf = (t) => (t.scheduledOn && t.scheduledOn > today()) ? t.scheduledOn : t.deadlineOn;
  list.sort((a, b) => keyOf(a).localeCompare(keyOf(b)) || a.position - b.position);
  $('#viewSub').textContent = list.length ? list.length + (list.length === 1 ? ' tarea con fecha' : ' tareas con fecha') : '';

  const box = h('div', { class: 'narrow' }, quickBar('Añadir con fecha: “Llamar al gestor el 25/9”…', { scheduledOn: addDays(today(), 1) }));
  if (!state.hasNewSchema) box.append(h('p', { class: 'empty' }, 'Las fechas estarán disponibles cuando se actualice la base de datos.'));
  else if (!list.length) box.append(emptyState('calendar', 'Sin tareas con fecha', 'Ponle fecha a una tarea y aparecerá aquí, ordenada por día.'));
  let last = null;
  for (const t of list) {
    const key = keyOf(t);
    if (key !== last) { box.append(h('div', { class: 'group-title' }, fmtDate(key))); last = key; }
    box.append(taskRowEl(t, { hideDate: true, actions: (task) => [snoozeButton(task)] }));
  }
  view.append(box);
}

function renderRevision(view) {
  const list = state.tasks.filter(isStale).sort((a, b) => ageDays(b) - ageDays(a));
  $('#viewSub').textContent = 'Decide qué haces con cada tarea parada: hacerla, ponerle fecha, aparcarla o borrarla';
  const box = h('div', { class: 'narrow' });
  if (!list.length) box.append(emptyState('eye-check', 'Nada parado', 'Ninguna tarea lleva más de ' + STALE_DAYS + ' días sin moverse.'));
  const someday = somedayCol();
  const act = (label, fn) => h('button', { class: 'btn small', onclick: (e) => { e.stopPropagation(); fn(); } }, label);
  list.forEach(t => box.append(taskRowEl(t, { showList: true, showAge: true, actions: () => [
    state.hasNewSchema ? act('Hoy', () => { t.scheduledOn = today(); saveTasks([t]); render(); }) : null,
    state.hasNewSchema ? act('+1 semana', () => { t.scheduledOn = addDays(today(), 7); saveTasks([t]); render(); }) : null,
    someday ? act('Algún día', () => moveTask(t, someday.id)) : null,
    h('button', { class: 'btn small danger', onclick: (e) => { e.stopPropagation(); removeTask(t); } }, 'Borrar')
  ] })));
  view.append(box);
}

function renderHecho(view) {
  const hecho = hechoCol();
  const list = state.tasks.filter(t => t.checked || (hecho && t.columnId === hecho.id));
  list.sort((a, b) => (b.completedAt || '').localeCompare(a.completedAt || '') || a.position - b.position);
  $('#viewSub').textContent = list.length ? list.length + ' completadas' : '';
  if (list.length) $('#viewActions').append(h('button', { class: 'btn', onclick: clearDone }, icon('trash'), 'Borrar completadas'));
  const box = h('div', { class: 'narrow' });
  if (!list.length) box.append(emptyState('archive', 'Todavía no hay nada hecho', 'Lo que completes se guarda aquí hasta que lo borres.'));
  list.forEach(t => box.append(taskRowEl(t)));
  view.append(box);
}

function archiveIdea(idea, mensaje, deshacerExtra) {
  state.ideas = state.ideas.filter(i => i !== idea);
  idea.archivedAt = new Date().toISOString();
  saveIdea(idea);
  render();
  toast(mensaje, 6000, { label: 'Deshacer', onclick: () => {
    idea.archivedAt = null;
    state.ideas = [idea, ...state.ideas];
    saveIdea(idea);
    if (deshacerExtra) deshacerExtra();
    render();
  } });
}

function renderIdeas(view) {
  const list = state.ideas;
  $('#viewSub').textContent = list.length
    ? list.length + (list.length === 1 ? ' idea sin decidir' : ' ideas sin decidir')
    : 'Apunta aquí lo que se te ocurra; decidir qué hacer con ello es otro momento';
  if (!state.hasIdeas) { view.append(h('p', { class: 'empty' }, 'Las ideas estarán disponibles cuando se actualice la base de datos.')); return; }

  const box = h('div', { class: 'narrow' });
  const input = h('input', { id: 'quickInput', type: 'text', placeholder: '¿Qué se te ha ocurrido?', autocomplete: 'off' });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !input.value.trim()) return;
    const idea = { id: uuid(), text: input.value.trim(), note: '', source: 'app', createdAt: new Date().toISOString() };
    state.ideas = [idea, ...state.ideas];
    saveIdea(idea);
    input.value = '';
    render();
    setTimeout(() => $('#quickInput') && $('#quickInput').focus(), 10);
  });
  box.append(h('div', { class: 'quick' }, icon('bulb'), input),
    h('p', { class: 'quick-hint' }, 'También puedes mandárselas al bot de Telegram escribiendo “idea …”, o pedírselo a Claude.'));

  if (!list.length) box.append(emptyState('bulb', 'Sin ideas pendientes', 'Todo lo que has apuntado ya está convertido en tarea, en pieza de un lote o descartado.'));

  const FUENTES = { telegram: 'Telegram', claude: 'Claude', chatgpt: 'ChatGPT', app: 'App' };
  list.forEach(idea => {
    const dias = idea.createdAt ? daysBetween(iso(new Date(idea.createdAt)), today()) : 0;
    box.append(h('div', { class: 'row' },
      h('span', { class: 'check', style: 'border-style: dashed;' }),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, idea.text),
        h('div', { class: 'row-meta' },
          h('span', { class: 'chip' }, FUENTES[idea.source] || idea.source),
          h('span', { class: 'chip' }, dias === 0 ? 'hoy' : 'hace ' + dias + (dias === 1 ? ' día' : ' días')))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', title: 'Convertir en tarea', onclick: () => {
          const t = createTask({ title: idea.text, columnId: (somedayCol() || firstOpenCol() || {}).id });
          if (t) archiveIdea(idea, 'Ahora es una tarea en ' + state.columns.find(c => c.id === t.columnId).title,
            () => { state.tasks = state.tasks.filter(x => x !== t); deleteTasks([t.id]); });
        } }, 'A tarea'),
        state.batches.length ? h('button', { class: 'btn small', title: 'Mandar a un lote', onclick: (e) => {
          popMenu(e.currentTarget, state.batches.map(b => ({
            label: b.title, icon: 'stack-2', onclick: () => {
              const item = { id: uuid(), batchId: b.id, title: idea.text, stage: 0, position: b.items.length };
              b.items.push(item);
              saveItems([item]);
              archiveIdea(idea, 'A ' + b.title,
                () => { b.items = b.items.filter(x => x !== item); addOp({ table: 'batch_items', action: 'deleteIn', ids: [item.id] }); });
            }
          })));
        } }, 'A lote') : null,
        h('button', { class: 'btn small danger', title: 'Descartar', onclick: () => archiveIdea(idea, 'Idea descartada') }, 'Descartar'))));
  });
  view.append(box);
}

function renderPapelera(view) {
  const list = state.trash;
  $('#viewSub').textContent = list.length
    ? list.length + (list.length === 1 ? ' tarea borrada' : ' tareas borradas') + ' · se vacía sola a los 30 días'
    : 'Lo que borres se guarda aquí 30 días por si te arrepientes';
  if (list.length) {
    $('#viewActions').append(h('button', { class: 'btn danger', onclick: async () => {
      if (!await confirmModal('¿Vaciar la papelera?', list.length + ' tareas se borrarán para siempre.', 'Vaciar')) return;
      purgeTasks([...list]);
      toast('Papelera vacía');
    } }, icon('trash'), 'Vaciar papelera'));
  }
  const box = h('div', { class: 'narrow' });
  if (!list.length) box.append(emptyState('trash', 'La papelera está vacía', 'Nada que recuperar.'));
  list.forEach(t => {
    const dias = t.deletedAt ? Math.max(0, 30 - daysBetween(iso(new Date(t.deletedAt)), today())) : 30;
    box.append(h('div', { class: 'row' },
      h('span', { class: 'check', style: 'border-style: dashed;' }),
      h('div', { class: 'row-main' },
        h('div', { class: 'row-title' }, t.title),
        h('div', { class: 'row-meta' }, h('span', { class: 'chip' }, 'quedan ' + dias + ' días'))),
      h('div', { class: 'row-actions' },
        h('button', { class: 'btn small', onclick: () => restoreTasks([t]) }, 'Recuperar'),
        h('button', { class: 'btn small danger', onclick: () => { purgeTasks([t]); toast('Borrada para siempre'); } }, 'Borrar'))));
  });
  view.append(box);
}

// ----- Tablero -----
let dragTaskId = null;
let dragColId = null;

function cardEl(t) {
  const done = t.checked || (t.recurrence && t.lastDoneOn === today());
  const card = h('div', { class: 'card' + (t.urgent && !done ? ' urgent' : '') + (done ? ' row done' : ''), draggable: true, dataset: { id: t.id },
    ondragstart: (e) => { dragTaskId = t.id; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', t.id); e.stopPropagation(); },
    ondragend: () => { dragTaskId = null; card.classList.remove('dragging'); document.querySelectorAll('.drop-line').forEach(el => el.remove()); } },
    checkBtn(done, () => toggleTask(t)),
    h('div', { class: 'row-main', onclick: () => openDetail(t.id) },
      h('div', { class: 'row-title' }, t.title),
      t.note && !done ? h('div', { class: 'row-note' }, t.note) : null,
      h('div', { class: 'row-meta' }, done ? [] : taskChips(t)))
  );
  return card;
}

function columnEl(c) {
  const list = colTasks(c.id);
  const cards = h('div', { class: 'cards' }, list.map(cardEl));

  const dropIndex = (e) => {
    const els = [...cards.querySelectorAll('.card:not(.dragging)')];
    const i = els.findIndex(el => { const r = el.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
    return { index: i === -1 ? els.length : i, before: i === -1 ? null : els[i] };
  };

  const titleEl = h('span', { class: 'col-title', title: 'Clic para renombrar', onclick: () => {
    const input = h('input', { type: 'text', value: c.title });
    let closed = false;
    const close = (save) => {
      if (closed) return; closed = true;
      const name = input.value.trim();
      if (save && name && name !== c.title) { c.title = name; saveColumns(); }
      render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); });
    input.addEventListener('blur', () => close(true));
    titleEl.replaceWith(input); input.focus(); input.select();
  } }, c.title);

  const head = h('div', { class: 'col-head', draggable: true,
    ondragstart: (e) => { dragColId = c.id; col.classList.add('drag-col'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', 'col'); },
    ondragend: () => { dragColId = null; col.classList.remove('drag-col'); } },
    titleEl, h('span', { class: 'count' }, list.length),
    !list.length ? h('button', { class: 'icon-btn', style: 'width: 22px; height: 22px; font-size: 14px;', title: 'Eliminar lista vacía', onclick: async () => {
      if (!await confirmModal('¿Eliminar la lista “' + c.title + '”?', 'Está vacía.', 'Eliminar')) return;
      state.columns = state.columns.filter(o => o !== c);
      state.columns.forEach((o, i) => { o.position = i; });
      addOp({ table: 'columns', action: 'deleteIn', ids: [c.id] });
      saveColumns(); render();
    } }, icon('x')) : null
  );

  let adder;
  if (state.addingIn === c.id) {
    const ta = h('textarea', { rows: 2, placeholder: '¿Qué hay que hacer?' });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const title = ta.value.trim();
        if (title) { createTask({ title, columnId: c.id }); render(); }
      } else if (e.key === 'Escape') { state.addingIn = null; render(); }
    });
    ta.addEventListener('blur', () => setTimeout(() => { if (state.addingIn === c.id && document.activeElement !== ta) { state.addingIn = null; render(); } }, 120));
    adder = h('div', { class: 'col-add' }, ta);
    setTimeout(() => ta.focus(), 0);
  } else {
    adder = h('div', { class: 'col-add' }, h('button', { onclick: () => { state.addingIn = c.id; render(); } }, '+ Añadir tarea'));
  }

  const col = h('div', { class: 'col',
    ondragover: (e) => {
      e.preventDefault();
      if (!dragTaskId) return;
      cards.classList.add('over');
      cards.querySelectorAll('.drop-line').forEach(el => el.remove());
      const { before } = dropIndex(e);
      const line = h('div', { class: 'drop-line' });
      if (before) cards.insertBefore(line, before); else cards.append(line);
    },
    ondragleave: (e) => { if (!col.contains(e.relatedTarget)) { cards.classList.remove('over'); cards.querySelectorAll('.drop-line').forEach(el => el.remove()); } },
    ondrop: (e) => {
      e.preventDefault();
      cards.classList.remove('over');
      if (dragTaskId) {
        const t = state.tasks.find(o => o.id === dragTaskId);
        const { index } = dropIndex(e);
        dragTaskId = null;
        if (t) moveTask(t, c.id, index);
      } else if (dragColId && dragColId !== c.id) {
        const moving = state.columns.find(o => o.id === dragColId);
        const r = col.getBoundingClientRect();
        state.columns = state.columns.filter(o => o !== moving);
        let at = state.columns.indexOf(c);
        if (e.clientX > r.left + r.width / 2) at++;
        state.columns.splice(at, 0, moving);
        state.columns.forEach((o, i) => { o.position = i; });
        dragColId = null;
        saveColumns(); render();
      }
    } }, head, cards, adder);
  return col;
}

function renderTablero(view) {
  view.classList.add('board-mode');
  const open = state.tasks.filter(t => !t.checked).length;
  $('#viewSub').textContent = open + ' tareas abiertas en ' + state.columns.length + ' listas';
  const board = h('div', { class: 'board' }, state.columns.map(columnEl));

  const adder = h('div', { class: 'col new', onclick: () => {
    if (adder.querySelector('input')) return;
    const input = h('input', { type: 'text', placeholder: 'Nombre de la lista…' });
    let closed = false;
    const close = (save) => {
      if (closed) return; closed = true;
      const name = input.value.trim();
      if (save && name) { state.columns.push({ id: uuid(), title: name, position: state.columns.length }); saveColumns(); }
      render();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); });
    input.addEventListener('blur', () => close(true));
    adder.replaceChildren(input); input.focus();
  } }, '+ Añadir lista');
  board.append(adder);
  view.append(board);
}

// ----- Lotes -----
function renderLotes(view) {
  $('#viewSub').textContent = 'Agrupa piezas de contenido y avanza todas por la misma etapa en una sesión';
  if (!state.hasBatches) {
    view.append(h('p', { class: 'empty' }, 'Los lotes estarán disponibles cuando se actualice la base de datos.'));
    return;
  }
  $('#viewActions').append(h('button', { class: 'btn primary', onclick: newBatchModal }, icon('plus'), 'Nuevo lote'));
  if (!state.batches.length) {
    view.append(emptyState('stack-2', 'Todavía no hay lotes', 'Crea uno, por ejemplo “Reels · semana 39”, y avanza todas sus piezas etapa a etapa.'));
    return;
  }
  state.batches.forEach(b => view.append(batchEl(b)));
}

function inlineEdit(el, value, onsave) {
  const input = h('input', { type: 'text', value, style: 'font: inherit; padding: 2px 6px; border: 1.5px solid var(--accent); border-radius: 6px; outline: none; background: var(--bg); min-width: 0; width: 100%;' });
  let closed = false;
  const close = (save) => {
    if (closed) return; closed = true;
    const v = input.value.trim();
    if (save && v && v !== value) onsave(v);
    render();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); });
  input.addEventListener('blur', () => close(true));
  el.replaceWith(input); input.focus(); input.select();
}

function batchEl(b) {
  const n = b.stages.length;
  const finished = b.items.filter(i => i.stage >= n).length;
  const grid = h('div', { class: 'batch-grid', style: `grid-template-columns: minmax(150px, 1.6fr) repeat(${n}, minmax(74px, 1fr));` });

  grid.append(h('span'));
  b.stages.forEach((name, k) => {
    grid.append(h('div', { class: 'stage-head' }, name,
      h('input', { type: 'date', value: b.stageDates[k] || '', title: 'Día previsto para esta etapa', onchange: (e) => {
        if (e.target.value) b.stageDates[k] = e.target.value; else delete b.stageDates[k];
        saveBatch(b); render();
      } })));
  });

  b.items.slice().sort((a, c) => a.position - c.position).forEach(item => {
    const label = h('span', { title: item.title, onclick: () => inlineEdit(label, item.title, (v) => { item.title = v; saveItems([item]); }) }, item.title);
    grid.append(h('div', { class: 'piece' }, label,
      h('button', { class: 'icon-btn', title: 'Quitar pieza', onclick: () => {
        b.items = b.items.filter(o => o !== item);
        addOp({ table: 'batch_items', action: 'deleteIn', ids: [item.id] });
        render();
      } }, icon('x'))));
    b.stages.forEach((name, k) => {
      const done = k < item.stage, now = k === item.stage;
      const date = b.stageDates[k];
      grid.append(h('button', { class: 'cell' + (done ? ' done' : now ? ' now' : ''), title: name + ' · ' + item.title,
        onclick: () => { item.stage = done ? k : k + 1; saveItems([item]); render(); } },
        done ? icon('check') : now ? (date ? fmtDate(date) : 'pendiente') : ''));
    });
  });

  const titleEl = h('h3', { onclick: () => inlineEdit(titleEl, b.title, (v) => { b.title = v; saveBatch(b); }) }, b.title);
  const adder = h('input', { class: 'batch-add', type: 'text', placeholder: '+ Añadir pieza', onkeydown: (e) => {
    if (e.key !== 'Enter' || !adder.value.trim()) return;
    const item = { id: uuid(), batchId: b.id, title: adder.value.trim(), stage: 0, position: b.items.length };
    b.items.push(item); saveItems([item]); state.focusBatch = b.id; render();
  } });
  if (state.focusBatch === b.id) { state.focusBatch = null; setTimeout(() => adder.focus(), 0); }

  return h('div', { class: 'batch' },
    h('div', { class: 'batch-head' }, titleEl,
      h('span', { class: 'muted' }, b.items.length + (b.items.length === 1 ? ' pieza' : ' piezas') + ' · ' + finished + ' terminadas'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Eliminar lote', onclick: async () => {
        if (!await confirmModal('¿Eliminar el lote “' + b.title + '”?', 'Se borran también sus piezas. No se puede deshacer.', 'Eliminar')) return;
        state.batches = state.batches.filter(o => o !== b);
        addOp({ table: 'batches', action: 'deleteIn', ids: [b.id] });
        render();
      } }, icon('trash'))),
    h('div', { class: 'batch-scroll' }, grid),
    adder);
}

function newBatchModal() {
  const title = h('input', { type: 'text', placeholder: 'Reels · semana 39' });
  const template = h('select', {}, Object.keys(BATCH_TEMPLATES).map(k => h('option', { value: k }, k)));
  const stages = h('input', { type: 'text', value: BATCH_TEMPLATES.Reel.join(', ') });
  const pieces = h('textarea', { placeholder: 'Una pieza por línea\nDokie para presentaciones\nGPT vs Claude vs Grok' });
  template.addEventListener('change', () => { stages.value = BATCH_TEMPLATES[template.value].join(', '); });

  openModal(h('div', {},
    h('h3', {}, 'Nuevo lote'),
    h('label', {}, 'Nombre'), title,
    h('label', {}, 'Plantilla'), template,
    h('label', {}, 'Etapas, separadas por comas'), stages,
    h('label', {}, 'Piezas'), pieces,
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: closeModal }, 'Cancelar'),
      h('button', { class: 'btn primary', onclick: () => {
        const name = title.value.trim();
        const stageList = stages.value.split(',').map(s => s.trim()).filter(Boolean);
        if (!name) { title.focus(); toast('Ponle un nombre al lote'); return; }
        if (!stageList.length) { stages.focus(); toast('Añade al menos una etapa'); return; }
        const b = { id: uuid(), title: name, stages: stageList, stageDates: {}, position: state.batches.length, items: [] };
        b.items = pieces.value.split('\n').map(s => s.trim()).filter(Boolean)
          .map((t, i) => ({ id: uuid(), batchId: b.id, title: t, stage: 0, position: i }));
        state.batches.push(b);
        saveBatch(b);
        if (b.items.length) saveItems(b.items);
        closeModal(); render();
      } }, 'Crear lote'))));
  title.focus();
}

// ===== Panel de detalle =====
function openDetail(id) { state.detailId = id; renderDetail(); }

function closeDetail() {
  state.detailId = null;
  $('#drawer').hidden = true;
  $('#overlay').hidden = true;
  render();
}

function renderDetail() {
  const t = state.tasks.find(o => o.id === state.detailId);
  const drawer = $('#drawer');
  if (!t) { drawer.hidden = true; $('#overlay').hidden = true; return; }
  const save = () => saveTasks([t]);
  const done = t.checked || (t.recurrence && t.lastDoneOn === today());

  const title = h('textarea', { class: 'd-title', rows: 1, value: t.title, placeholder: 'Título' });
  const grow = () => { title.style.height = 'auto'; title.style.height = title.scrollHeight + 'px'; };
  title.addEventListener('input', grow);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', () => { const v = title.value.trim(); if (v && v !== t.title) { t.title = v; save(); } });

  const note = h('textarea', { class: 'd-note', value: t.note, placeholder: 'Notas…' });
  note.addEventListener('blur', () => { if (note.value.trim() !== t.note) { t.note = note.value.trim(); save(); } });

  const listSel = h('select', { onchange: (e) => { moveTask(t, e.target.value); renderDetail(); } },
    state.columns.map(c => h('option', { value: c.id, selected: c.id === t.columnId }, c.title)));

  const fields = [h('div', { class: 'field' }, h('span', {}, icon('layout-kanban'), 'Lista'), listSel)];

  if (state.hasNewSchema) {
    const setWhen = (v) => { t.scheduledOn = v || null; save(); renderDetail(); };
    fields.push(
      h('div', { class: 'field' }, h('span', {}, icon('calendar'), 'Cuándo'),
        h('div', { class: 'inline' },
          h('input', { type: 'date', value: t.scheduledOn || '', onchange: (e) => setWhen(e.target.value) }),
          h('button', { class: 'btn small', onclick: () => setWhen(today()) }, 'Hoy'),
          h('button', { class: 'btn small', onclick: () => setWhen(addDays(today(), 1)) }, 'Mañana'),
          t.scheduledOn ? h('button', { class: 'btn small', onclick: () => setWhen(null) }, 'Quitar') : null)),
      h('div', { class: 'field' }, h('span', {}, icon('flag'), 'Fecha límite'),
        h('input', { type: 'date', value: t.deadlineOn || '', onchange: (e) => { t.deadlineOn = e.target.value || null; save(); } })),
      h('div', { class: 'field' }, h('span', {}, icon('repeat'), 'Repetir'),
        h('select', { onchange: (e) => {
          t.recurrence = e.target.value || null;
          if (t.recurrence && !t.scheduledOn) t.scheduledOn = today();
          save(); renderDetail();
        } }, h('option', { value: '' }, 'No se repite'),
          Object.entries(RECURRENCES).map(([k, v]) => h('option', { value: k, selected: t.recurrence === k }, v)))));
  }
  if (state.hasTrash) {
    fields.push(h('div', { class: 'field' }, h('span', {}, icon('bell'), 'Recordatorio'),
      h('div', { class: 'inline' },
        h('input', { type: 'time', value: remindTime(t), onchange: (e) => { setRemind(t, e.target.value); save(); renderDetail(); } }),
        t.remindAt ? h('button', { class: 'btn small', onclick: () => { t.remindAt = null; save(); renderDetail(); } }, 'Quitar') : null,
        h('span', { style: 'font-size: 12px; color: var(--text-3);' }, 'te avisa el bot de Telegram'))));
  }
  if (state.hasEstimates) {
    fields.push(h('div', { class: 'field' }, h('span', {}, icon('clock'), 'Duración'),
      h('div', { class: 'inline' }, ESTIMATES.map(m =>
        h('button', { class: 'btn small' + (t.estimateMin === m ? ' on' : ''), onclick: () => { t.estimateMin = t.estimateMin === m ? null : m; save(); renderDetail(); } }, fmtMin(m))))));
  }
  fields.push(h('div', { class: 'field' }, h('span', {}, icon('alert-triangle'), 'Urgente'),
    h('div', { class: 'inline' }, checkBtn(t.urgent, () => { t.urgent = !t.urgent; save(); renderDetail(); }, true))));

  const subs = h('div', {});
  t.subtasks.forEach((s, i) => {
    const input = h('input', { type: 'text', value: s.text });
    input.addEventListener('blur', () => {
      const v = input.value.trim();
      if (!v) { t.subtasks.splice(i, 1); save(); renderDetail(); }
      else if (v !== s.text) { s.text = v; save(); }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    subs.append(h('div', { class: 'sub' + (s.checked ? ' done' : '') },
      checkBtn(s.checked, () => { s.checked = !s.checked; save(); renderDetail(); }, true), input,
      h('button', { class: 'icon-btn', title: 'Quitar subtarea', onclick: () => { t.subtasks.splice(i, 1); save(); renderDetail(); } }, icon('x'))));
  });
  const newSub = h('input', { type: 'text', placeholder: 'Añadir subtarea…' });
  newSub.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && newSub.value.trim()) {
      t.subtasks.push({ text: newSub.value.trim(), checked: false }); save(); renderDetail();
      setTimeout(() => { const el = $('#newSub'); if (el) el.focus(); }, 0);
    }
  });
  newSub.id = 'newSub';
  subs.append(h('div', { class: 'sub' }, h('span', { class: 'check sq', style: 'border-style: dashed;' }), newSub));

  drawer.replaceChildren(
    h('div', { class: 'drawer-head' },
      checkBtn(done, () => { toggleTask(t); renderDetail(); }),
      h('span', { style: 'color: var(--text-3); font-size: 13px;' }, done ? 'Completada' : 'Marcar como hecha'),
      h('span', { class: 'spacer' }),
      h('button', { class: 'icon-btn', title: 'Borrar tarea', onclick: async () => {
        if (!await confirmModal('¿Borrar esta tarea?', t.title, 'Borrar')) return;
        removeTask(t); closeDetail();
      } }, icon('trash')),
      h('button', { class: 'icon-btn', title: 'Cerrar', onclick: closeDetail }, icon('x'))),
    h('div', { class: 'drawer-body' }, title, note, fields,
      h('div', { class: 'd-section' }, 'Subtareas'), subs,
      t.createdAt ? h('p', { class: 'd-foot' }, 'Creada ' + (ageDays(t) === 0 ? 'hoy' : 'hace ' + ageDays(t) + (ageDays(t) === 1 ? ' día' : ' días'))) : null)
  );
  drawer.hidden = false;
  $('#overlay').hidden = false;
  grow();
}

// ===== Modales =====
let modalResolve = null;

function openModal(content) {
  $('#modalWrap').replaceChildren(h('div', { class: 'modal' }, content));
  $('#modalWrap').hidden = false;
}

function closeModal(result) {
  $('#modalWrap').hidden = true;
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(result === true); }
}

function confirmModal(message, detail, okLabel) {
  const ok = h('button', { class: 'btn primary', onclick: () => closeModal(true) }, okLabel || 'Aceptar');
  openModal(h('div', {}, h('h3', {}, message), detail ? h('p', {}, detail) : null,
    h('div', { class: 'modal-foot' }, h('button', { class: 'btn', onclick: () => closeModal(false) }, 'Cancelar'), ok)));
  ok.focus();
  return new Promise(resolve => { modalResolve = resolve; });
}

// ===== Temas =====
// Colores de muestra de cada tema: [barra lateral, fondo, acento, línea de texto]
const THEMES = {
  clasico: { name: 'Clásico', desc: 'Crema y teja, el de siempre', mode: 'auto',
    preview: { light: ['#f3f2ec', '#faf9f5', '#d5714f', '#d2d1ca'], dark: ['#161513', '#1b1a18', '#e08a6c', '#45443f'] } },
  calma: { name: 'Calma', desc: 'Blanco y azul, como Things', mode: 'auto',
    preview: { light: ['#f5f6f8', '#ffffff', '#2f7cf6', '#d3d7dd'], dark: ['#18191c', '#1c1d21', '#4a90ff', '#3d4047'] } },
  papel: { name: 'Papel', desc: 'Barra oscura y rojo, como Bear', mode: 'auto',
    preview: { light: ['#2a2b2e', '#fbfaf7', '#d9473f', '#d8d3c9'], dark: ['#151618', '#1e1f21', '#ef6a62', '#404145'] } },
  foco: { name: 'Foco', desc: 'Oscuro y compacto, como Linear', mode: 'dark',
    preview: { light: ['#f3f4f6', '#fcfcfd', '#5e6ad2', '#d3d5da'], dark: ['#0b0c0e', '#101113', '#7c86e0', '#31343b'] } }
};

function readPref(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch (e) { return fallback; } }
function writePref(key, value) { try { localStorage.setItem(key, value); } catch (e) { /* sin almacenamiento: se aplica solo en esta sesión */ } }
const currentTheme = () => { const t = readPref('tareas_theme', 'clasico'); return THEMES[t] ? t : 'clasico'; };
const currentMode = (t) => readPref('tareas_mode_' + t, THEMES[t].mode);
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const t = currentTheme(), m = currentMode(t);
  const dark = m === 'dark' || (m === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = t;
  document.documentElement.dataset.mode = dark ? 'dark' : 'light';
  const meta = document.getElementById('themeColor');
  if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
}

darkQuery.addEventListener('change', applyTheme);
applyTheme();

function appearanceSection() {
  const wrap = h('div', {});
  const draw = () => {
    const t = currentTheme(), m = currentMode(t);
    const dark = document.documentElement.dataset.mode === 'dark';
    wrap.replaceChildren(
      h('h4', {}, 'Tema'),
      h('div', { class: 'theme-grid' }, Object.entries(THEMES).map(([key, th]) => {
        const [side, bg, accent, line] = th.preview[dark ? 'dark' : 'light'];
        return h('button', { class: 'theme-opt', 'aria-pressed': String(key === t), onclick: () => { writePref('tareas_theme', key); applyTheme(); draw(); } },
          h('span', { class: 'theme-prev', style: 'background: ' + bg },
            h('span', { style: 'background: ' + side }),
            h('span', { class: 'tp-main' },
              h('span', { class: 'tp-dot', style: 'background: ' + accent }),
              h('span', { class: 'tp-line', style: 'background: ' + line + '; width: 80%' }),
              h('span', { class: 'tp-line', style: 'background: ' + line + '; width: 55%' }))),
          h('span', { class: 'theme-name' }, th.name),
          h('span', { class: 'theme-desc' }, th.desc));
      })),
      h('h4', {}, 'Modo'),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Modo de color' },
        [['auto', 'Automático'], ['light', 'Claro'], ['dark', 'Oscuro']].map(([key, label]) =>
          h('button', { 'aria-pressed': String(m === key), onclick: () => { writePref('tareas_mode_' + t, key); applyTheme(); draw(); } }, label))),
      h('p', { style: 'margin-top: 8px; font-size: 12.5px;' }, 'Se guarda en este dispositivo. Automático sigue el modo claro u oscuro del sistema.'));
  };
  draw();
  return wrap;
}

// ===== Búsqueda =====
function searchModal() {
  const input = h('input', { type: 'text', placeholder: 'Buscar en tus tareas…', autocomplete: 'off' });
  const results = h('div', { class: 'search-results' });
  const box = h('div', {}, h('h3', {}, 'Buscar'), input, results);
  openModal(box);
  input.focus();

  const draw = () => {
    const q = slug(input.value.trim());
    if (!q) { results.replaceChildren(h('p', { class: 'search-hint' }, 'Escribe para buscar en el título, la nota y las subtareas. Busca también en lo hecho y en la papelera.')); return; }
    const match = (t) => slug([t.title, t.note, ...(t.subtasks || []).map(x => x.text)].join(' ')).includes(q);
    const ideasFound = state.ideas.filter(i => slug(i.text + ' ' + (i.note || '')).includes(q));
    const found = [...state.tasks.filter(match), ...state.trash.filter(match)].slice(0, 30);
    if (!found.length && !ideasFound.length) { results.replaceChildren(h('p', { class: 'search-hint' }, 'Nada coincide con “' + input.value.trim() + '”.')); return; }
    results.replaceChildren(...ideasFound.slice(0, 10).map(i =>
      h('button', { class: 'search-item', onclick: () => { closeModal(); setView('ideas'); } },
        h('span', { class: 'search-title' }, i.text),
        h('span', { class: 'search-meta' }, 'Idea'))),
      ...found.map(t => {
      const col = state.columns.find(c => c.id === t.columnId);
      const estado = t.deletedAt ? 'Papelera' : t.checked ? 'Hecho' : (col ? col.title : '');
      return h('button', { class: 'search-item', onclick: () => {
        closeModal();
        if (t.deletedAt) { setView('papelera'); return; }
        openDetail(t.id);
      } },
        h('span', { class: 'search-title' + (t.checked || t.deletedAt ? ' off' : '') }, t.title),
        h('span', { class: 'search-meta' }, [estado, t.scheduledOn ? fmtDate(t.scheduledOn) : ''].filter(Boolean).join(' · ')));
    }));
  };
  input.addEventListener('input', draw);
  draw();
}

// ===== Ajustes =====
async function settingsModal() {
  const urls = h('textarea', { placeholder: 'https://calendar.google.com/calendar/ical/…/basic.ics', style: 'min-height: 90px; font-size: 12.5px;' });
  const feedInfo = h('p', { style: 'margin-top: 8px;' }, 'Preparando la dirección…');
  const status = h('p', { style: 'margin-top: 8px; min-height: 18px;' });

  openModal(h('div', {},
    h('h3', {}, 'Ajustes'),
    appearanceSection(),
    h('h4', {}, 'Aplicación'),
    h('div', { style: 'display: flex; align-items: center; gap: 10px; flex-wrap: wrap;' },
      h('button', { class: 'btn', onclick: async () => {
        // Tira la copia local de la app y vuelve a pedirla entera
        try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch (e) { /* da igual */ }
        location.replace(location.pathname + '?v=' + Date.now());
      } }, icon('refresh'), 'Buscar actualizaciones'),
      h('span', { style: 'font-size: 12.5px; color: var(--text-3);' }, 'Versión ' + APP_VERSION)),
    h('h4', {}, 'Calendario'),
    h('label', {}, 'Ver mi agenda en la vista Hoy'),
    h('p', {}, 'Pega la dirección privada en formato iCal de cada calendario, una por línea. En Google Calendar está en Configuración del calendario → “Dirección secreta en formato iCal”.'),
    h('div', { style: 'height: 8px;' }), urls, status,
    h('label', {}, 'Ver mis tareas con fecha en el calendario'),
    feedInfo,
    h('div', { class: 'modal-foot' },
      h('button', { class: 'btn', onclick: closeModal }, 'Cerrar'),
      h('button', { class: 'btn primary', onclick: async () => {
        status.textContent = 'Guardando…';
        const { error } = await sb.from('app_settings').upsert({ key: 'calendar_ics_urls', value: urls.value.trim(), updated_at: new Date().toISOString() });
        if (error) { status.textContent = 'No se ha podido guardar: ' + error.message; return; }
        status.textContent = 'Guardado. Leyendo calendarios…';
        await loadAgenda();
        status.textContent = state.agenda.errors.length ? 'Guardado, pero hay un problema: ' + state.agenda.errors.join(' · ')
          : state.agenda.configured ? 'Guardado. Hoy hay ' + state.agenda.events.length + (state.agenda.events.length === 1 ? ' evento.' : ' eventos.') : 'Guardado. No hay calendarios conectados.';
      } }, 'Guardar calendarios'))));

  const saved = await sb.from('app_settings').select('value').eq('key', 'calendar_ics_urls').maybeSingle();
  if (saved.error) status.textContent = 'No se han podido leer los ajustes: ' + saved.error.message;
  else if (saved.data) urls.value = saved.data.value || '';

  try {
    const { url } = await callFunction('/feed-url');
    feedInfo.replaceChildren(
      'Suscríbete una vez y las tareas con fecha, las fechas límite y las etapas de los lotes aparecerán en tu calendario. La dirección es privada: no la compartas.',
      h('div', { style: 'display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px;' },
        h('a', { class: 'btn', href: url.replace(/^https:/, 'webcal:') }, icon('calendar-plus'), 'Suscribirme en este dispositivo'),
        h('button', { class: 'btn', onclick: async () => {
          try { await navigator.clipboard.writeText(url); toast('Dirección copiada'); }
          catch (e) { prompt('Copia la dirección:', url); }
        } }, icon('copy'), 'Copiar dirección')));
  } catch (e) {
    feedInfo.textContent = 'No se ha podido obtener la dirección: ' + e.message;
  }
}

// ===== Navegación y render =====
function setView(v) {
  closePopMenu();
  state.view = v;
  state.addingIn = null;
  localStorage.setItem('tareas_view', v);
  render();
}

function renderNav() {
  const counts = {
    hoy: state.tasks.filter(isToday).length + batchDueToday().length,
    proximo: state.tasks.filter(isUpcoming).length,
    lotes: state.batches.length,
    ideas: state.ideas.length
  };
  const stale = state.tasks.filter(isStale).length;
  const item = (key) => h('button', { class: 'nav-item' + (state.view === key ? ' on' : ''), dataset: { view: key }, onclick: () => setView(key) },
    icon(VIEWS[key].icon), VIEWS[key].title, counts[key] ? h('span', { class: 'count' }, counts[key]) : null);

  $('#sidebar').replaceChildren(...[
    h('div', { class: 'brand' }, icon('checkbox'), 'Tareas'),
    item('hoy'), item('proximo'), item('tablero'), item('lotes'), item('ideas'),
    h('div', { class: 'nav-sep' }),
    item('hecho'),
    state.trash.length ? h('button', { class: 'nav-item' + (state.view === 'papelera' ? ' on' : ''), onclick: () => setView('papelera') },
      icon('trash'), 'Papelera', h('span', { class: 'count' }, state.trash.length)) : null,
    stale ? h('button', { class: 'side-note', onclick: () => setView('revision') },
      'Revisión: ' + (stale === 1 ? '1 tarea lleva' : stale + ' tareas llevan') + ' más de ' + STALE_DAYS + ' días parada' + (stale === 1 ? '' : 's')) : null,
    h('div', { class: 'side-foot' },
      h('button', { class: 'nav-item', onclick: settingsModal }, icon('settings'), 'Ajustes'),
      h('button', { class: 'nav-item', onclick: async () => { await sb.auth.signOut(); location.reload(); } }, icon('logout'), 'Cerrar sesión'))
  ].filter(Boolean));

  $('#bottomnav').replaceChildren(...['hoy', 'proximo', 'tablero', 'lotes', 'ideas', 'hecho'].map(key =>
    h('button', { class: state.view === key ? 'on' : '', onclick: () => setView(key) }, icon(VIEWS[key].icon), VIEWS[key].title)));
}

function render() {
  if (!VIEWS[state.view]) state.view = 'hoy';
  const view = $('#view');
  const scroll = view.scrollTop;
  const boardScroll = view.querySelector('.board') ? view.querySelector('.board').scrollLeft : 0;
  view.className = 'view';
  view.replaceChildren();
  $('#viewTitle').textContent = VIEWS[state.view].title;
  $('#viewSub').textContent = '';
  $('#viewActions').replaceChildren();

  const banner = $('#schemaBanner');
  const faltaEsquema = !(state.hasNewSchema && state.hasBatches && state.hasTrash);
  banner.hidden = !state.offline && !faltaEsquema;
  banner.textContent = state.offline
    ? 'Sin conexión. Puedes seguir trabajando: los cambios se guardan aquí y se envían solos al volver la red.'
    : 'Falta actualizar la base de datos: hay campos nuevos que todavía no se guardan.';

  $('#viewActions').append(h('button', { class: 'icon-btn', title: 'Buscar (/)', 'aria-label': 'Buscar', onclick: searchModal }, icon('search')));
  $('#viewActions').append(h('button', { class: 'icon-btn only-mobile', title: 'Ajustes', 'aria-label': 'Ajustes', onclick: settingsModal }, icon('settings')));
  ({ hoy: renderHoy, proximo: renderProximo, tablero: renderTablero, lotes: renderLotes, ideas: renderIdeas, revision: renderRevision, hecho: renderHecho, papelera: renderPapelera })[state.view](view);
  renderNav();
  view.scrollTop = scroll;
  if (view.querySelector('.board')) view.querySelector('.board').scrollLeft = boardScroll;
}

// ===== Sesión =====
async function start() {
  try {
    await loadAll();
    state.offline = false;
    saveSnapshot();
    render();
    loadAgenda();
    flushOps();
  } catch (e) {
    console.error(e);
    if (loadSnapshot()) {
      // Sin conexión: se trabaja sobre la última copia y los cambios esperan en la cola
      state.offline = true;
      render();
      toast('Sin conexión. Estás viendo la última copia guardada.', 5000);
    } else {
      $('#view').replaceChildren(h('p', { class: 'empty' }, 'No se han podido cargar las tareas: ' + (e.message || 'error de conexión') + '. Recarga la página.'));
    }
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  btn.textContent = 'Entrando…'; btn.disabled = true;
  $('#loginError').hidden = true;
  const { error } = await sb.auth.signInWithPassword({ email: $('#loginEmail').value.trim(), password: $('#loginPassword').value });
  btn.textContent = 'Entrar'; btn.disabled = false;
  if (error) { $('#loginError').hidden = false; return; }
  $('#loginScreen').hidden = true;
  start();
});

$('#overlay').addEventListener('click', closeDetail);
$('#modalWrap').addEventListener('click', (e) => { if (e.target === $('#modalWrap')) closeModal(false); });

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if ($('.popmenu')) { closePopMenu(); return; }
    if (!$('#modalWrap').hidden) closeModal(false);
    else if (state.detailId) closeDetail();
    return;
  }
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName);
  if ((e.key === '/' || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k')) && !typing && $('#modalWrap').hidden) {
    e.preventDefault();
    searchModal();
    return;
  }
  if (e.key.toLowerCase() === 'n' && !typing && !e.metaKey && !e.ctrlKey && !e.altKey && $('#modalWrap').hidden && !state.detailId) {
    e.preventDefault();
    if (!$('#quickInput')) setView('hoy');
    $('#quickInput').focus();
  }
});

// Al volver a la app, recarga lo que haya cambiado fuera (otro dispositivo, Claude, ChatGPT)
document.addEventListener('visibilitychange', async () => {
  const idle = ops.length === 0 && !state.detailId && $('#modalWrap').hidden && !state.addingIn &&
    !/^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (document.visibilityState !== 'visible' || !idle || Date.now() - state.loadedAt < 30000) return;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  try { await loadAll(); render(); loadAgenda(); } catch (e) { console.error(e); }
});

window.addEventListener('beforeunload', (e) => { if (ops.length && navigator.onLine) { e.preventDefault(); e.returnValue = ''; } });

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('Sin copia local:', e)));
}

(async () => {
  const { data: { session } } = await sb.auth.getSession();
  if (session) start();
  else $('#loginScreen').hidden = false;
})();
