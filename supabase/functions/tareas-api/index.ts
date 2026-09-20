// Puerta de entrada al planificador para asistentes (Claude, ChatGPT) y atajos de iOS.
//
//   MCP (Claude):      POST /tareas-api/k/<clave>/mcp
//   REST (ChatGPT…):   /tareas-api/tasks…  con cabecera  Authorization: Bearer <clave>
//   Esquema OpenAPI:   GET  /tareas-api/openapi.json
//   Calendario (ICS):  GET  /tareas-api/k/<clave>/calendar.ics   (para suscribirse desde el iPhone o Google Calendar)
//   Agenda en la app:  GET  /tareas-api/calendar?from=&to=       (con la sesión de Supabase del usuario)
//
// Secretos necesarios: TAREAS_API_KEY. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';
import IcalExpander from 'npm:ical-expander@3.1.0';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const API_KEY = Deno.env.get('TAREAS_API_KEY') ?? '';
const OWNER_ID = Deno.env.get('TAREAS_OWNER_ID') ?? '';
const TIMEZONE = 'Europe/Madrid';
const FUNCTION_NAME = 'tareas-api';

// ===== Fechas =====
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];

const slug = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Acepta AAAA-MM-DD, "hoy", "mañana", "pasado mañana" o un día de la semana
function parseDate(value?: string | null): string | null {
  if (!value) return null;
  const v = slug(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value.trim())) return value.trim();
  if (v === 'hoy') return today();
  if (v === 'manana') return addDays(today(), 1);
  if (v === 'pasado-manana') return addDays(today(), 2);
  const target = WEEKDAYS.indexOf(v);
  if (target >= 0) {
    let d = addDays(today(), 1);
    while (weekday(d) !== target) d = addDays(d, 1);
    return d;
  }
  throw new Error(`Fecha no reconocida: "${value}". Usa AAAA-MM-DD, hoy, mañana o un día de la semana.`);
}

function nextOccurrence(recurrence: string): string {
  if (recurrence === 'weekly') return addDays(today(), 7);
  let next = addDays(today(), 1);
  if (recurrence === 'weekdays') while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
  return next;
}

// ===== Datos =====
type Column = { id: string; title: string; position: number };

async function getColumns(): Promise<Column[]> {
  const { data, error } = await db.from('columns').select('id,title,position').order('position');
  if (error) throw new Error(error.message);
  return data as Column[];
}

function findColumn(cols: Column[], name?: string | null): Column | undefined {
  if (!name) return undefined;
  const s = slug(name);
  return cols.find((c) => slug(c.title) === s) || cols.find((c) => slug(c.title).includes(s));
}

const RECURRENCES = ['daily', 'weekdays', 'weekly'];

function present(t: Record<string, unknown>, cols: Column[]) {
  const col = cols.find((c) => c.id === t.column_id);
  let subtasks: unknown[] = [];
  try { subtasks = t.subtasks_data ? JSON.parse(t.subtasks_data as string) : []; } catch { /* sin subtareas */ }
  return {
    id: t.id,
    title: t.title,
    note: t.description || undefined,
    list: col?.title,
    when: t.scheduled_on || undefined,
    deadline: t.deadline_on || undefined,
    recurrence: t.recurrence || undefined,
    urgent: t.priority === 'urgent' || undefined,
    done: t.priority === 'done' || !!t.completed_at || (t.recurrence && t.last_done_on === today()) || undefined,
    subtasks: subtasks.length ? subtasks : undefined,
  };
}

async function addTask(a: Record<string, any>) {
  const title = String(a.title || '').trim();
  if (!title) throw new Error('Falta el título de la tarea.');
  if (a.recurrence && !RECURRENCES.includes(a.recurrence)) throw new Error('recurrence debe ser daily, weekdays o weekly.');

  const cols = await getColumns();
  let when = parseDate(a.when);
  if (a.recurrence && !when) when = today();
  const deadline = parseDate(a.deadline);

  let col = findColumn(cols, a.list);
  if (a.list && !col) throw new Error(`No existe la lista "${a.list}". Listas: ${cols.map((c) => c.title).join(', ')}.`);
  if (!col) {
    const open = cols.filter((c) => slug(c.title) !== 'hecho');
    const isToday = when !== null && when <= today();
    col = (isToday ? findColumn(cols, 'hoy') : findColumn(cols, 'esta-semana')) || open[0];
  }
  if (!col) throw new Error('No hay ninguna lista creada en el planificador.');

  const { data: last } = await db.from('tasks').select('position').eq('column_id', col.id)
    .order('position', { ascending: false }).limit(1);
  const position = last && last.length ? (last[0].position ?? 0) + 1 : 0;

  const subtasks = Array.isArray(a.subtasks) ? a.subtasks.map((s: unknown) => ({ text: String(s), checked: false })) : [];
  const { data, error } = await db.from('tasks').insert({
    title,
    description: a.note ? String(a.note) : null,
    column_id: col.id,
    position,
    priority: a.urgent ? 'urgent' : null,
    subtasks_data: subtasks.length ? JSON.stringify(subtasks) : null,
    scheduled_on: when,
    deadline_on: deadline,
    recurrence: a.recurrence || null,
  }).select().single();
  if (error) throw new Error(error.message);
  return present(data, cols);
}

async function listTasks(a: Record<string, any>) {
  const cols = await getColumns();
  const { data, error } = await db.from('tasks').select('*').order('position');
  if (error) throw new Error(error.message);
  const now = today();
  const hecho = findColumn(cols, 'hecho');
  const hoy = findColumn(cols, 'hoy');
  const open = (data || []).filter((t) => t.priority !== 'done' && !t.completed_at && t.column_id !== hecho?.id);
  const isToday = (t: any) => (t.scheduled_on && t.scheduled_on <= now) || (t.deadline_on && t.deadline_on <= now) ||
    (hoy && t.column_id === hoy.id && !(t.scheduled_on && t.scheduled_on > now));

  const filter = slug(a.filter || 'hoy');
  let rows;
  if (filter === 'hoy') rows = open.filter(isToday);
  else if (filter === 'proximo') rows = open.filter((t) => !isToday(t) && ((t.scheduled_on && t.scheduled_on > now) || (t.deadline_on && t.deadline_on > now)));
  else if (filter === 'todas') rows = open;
  else {
    const col = findColumn(cols, a.filter);
    if (!col) throw new Error(`Filtro no reconocido: "${a.filter}". Usa hoy, proximo, todas o el nombre de una lista (${cols.map((c) => c.title).join(', ')}).`);
    rows = (data || []).filter((t) => t.column_id === col.id).slice(0, 50);
  }
  return { today: now, count: rows.length, tasks: rows.map((t) => present(t, cols)) };
}

async function findTask(a: Record<string, any>) {
  if (a.id) {
    const { data, error } = await db.from('tasks').select('*').eq('id', a.id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error('No existe ninguna tarea con ese id.');
    return data;
  }
  const q = String(a.title || '').trim();
  if (!q) throw new Error('Indica el id o el título de la tarea.');
  const { data, error } = await db.from('tasks').select('*').ilike('title', `%${q.replace(/[%_]/g, '')}%`).is('completed_at', null);
  if (error) throw new Error(error.message);
  const rows = (data || []).filter((t) => t.priority !== 'done');
  if (!rows.length) throw new Error(`No hay ninguna tarea abierta que contenga "${q}".`);
  if (rows.length > 1) throw new Error(`Hay ${rows.length} tareas que coinciden: ${rows.map((t) => `"${t.title}" (id ${t.id})`).join('; ')}. Repite indicando el id.`);
  return rows[0];
}

async function completeTask(a: Record<string, any>) {
  const cols = await getColumns();
  const t = await findTask(a);
  let patch: Record<string, unknown>;
  if (t.recurrence) {
    let subtasks = [];
    try { subtasks = t.subtasks_data ? JSON.parse(t.subtasks_data) : []; } catch { /* sin subtareas */ }
    subtasks.forEach((s: any) => { s.checked = false; });
    patch = { last_done_on: today(), scheduled_on: nextOccurrence(t.recurrence), subtasks_data: subtasks.length ? JSON.stringify(subtasks) : null };
  } else {
    patch = { priority: 'done', completed_at: new Date().toISOString() };
    const hecho = findColumn(cols, 'hecho');
    if (hecho && t.column_id !== hecho.id) {
      const { data: first } = await db.from('tasks').select('position').eq('column_id', hecho.id).order('position').limit(1);
      patch.column_id = hecho.id;
      patch.position = first && first.length ? (first[0].position ?? 0) - 1 : 0;
    }
  }
  const { data, error } = await db.from('tasks').update(patch).eq('id', t.id).select().single();
  if (error) throw new Error(error.message);
  return present(data, cols);
}

async function updateTask(a: Record<string, any>) {
  const cols = await getColumns();
  const t = await findTask({ id: a.id, title: a.id ? undefined : a.title });
  const patch: Record<string, unknown> = {};
  if (a.new_title) patch.title = String(a.new_title).trim();
  if (a.note !== undefined) patch.description = a.note ? String(a.note) : null;
  if (a.when !== undefined) patch.scheduled_on = parseDate(a.when);
  if (a.deadline !== undefined) patch.deadline_on = parseDate(a.deadline);
  if (a.urgent !== undefined && t.priority !== 'done') patch.priority = a.urgent ? 'urgent' : null;
  if (a.recurrence !== undefined) {
    if (a.recurrence && !RECURRENCES.includes(a.recurrence)) throw new Error('recurrence debe ser daily, weekdays o weekly.');
    patch.recurrence = a.recurrence || null;
  }
  if (a.list) {
    const col = findColumn(cols, a.list);
    if (!col) throw new Error(`No existe la lista "${a.list}". Listas: ${cols.map((c) => c.title).join(', ')}.`);
    if (col.id !== t.column_id) {
      const { data: last } = await db.from('tasks').select('position').eq('column_id', col.id).order('position', { ascending: false }).limit(1);
      patch.column_id = col.id;
      patch.position = last && last.length ? (last[0].position ?? 0) + 1 : 0;
    }
  }
  if (!Object.keys(patch).length) throw new Error('No has indicado ningún cambio.');
  const { data, error } = await db.from('tasks').update(patch).eq('id', t.id).select().single();
  if (error) throw new Error(error.message);
  return present(data, cols);
}

async function deleteTask(a: Record<string, any>) {
  // Solo por id exacto: borrar por título sería demasiado fácil de equivocar
  if (!a.id) throw new Error('Para borrar hace falta el id exacto de la tarea (consúltalo con list_tasks).');
  const { data, error } = await db.from('tasks').delete().eq('id', a.id).select('id,title');
  if (error) throw new Error(error.message);
  if (!data || !data.length) throw new Error('No existe ninguna tarea con ese id.');
  return { deleted: data[0] };
}

// ===== Herramientas (compartidas por MCP y OpenAPI) =====
const dateHelp = 'Fecha como AAAA-MM-DD, o "hoy", "mañana", "pasado mañana" o un día de la semana en español.';
const TOOLS = [
  {
    name: 'add_task',
    description: 'Añade una tarea al planificador de Yago. Sin lista, va a "Hoy" si es para hoy y a "Esta semana" en otro caso.',
    handler: addTask,
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Título breve de la tarea, empezando por un verbo.' },
        note: { type: 'string', description: 'Detalle opcional.' },
        when: { type: 'string', description: 'Cuándo hacerla. ' + dateHelp },
        deadline: { type: 'string', description: 'Fecha límite. ' + dateHelp },
        list: { type: 'string', description: 'Lista del tablero: Hoy, Esta semana, En espera, Algún día…' },
        urgent: { type: 'boolean' },
        recurrence: { type: 'string', enum: RECURRENCES, description: 'daily = cada día, weekdays = laborables, weekly = cada semana.' },
        subtasks: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_tasks',
    description: 'Lista las tareas abiertas. filter: "hoy" (por defecto), "proximo", "todas" o el nombre de una lista.',
    handler: listTasks,
    inputSchema: { type: 'object', properties: { filter: { type: 'string' } } },
  },
  {
    name: 'complete_task',
    description: 'Marca una tarea como hecha. Indica el id o parte del título.',
    handler: completeTask,
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' } } },
  },
  {
    name: 'update_task',
    description: 'Cambia una tarea existente: título, nota, fecha, fecha límite, lista, urgencia o repetición. Indica el id o parte del título.',
    handler: updateTask,
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        title: { type: 'string', description: 'Parte del título actual, para localizarla si no hay id.' },
        new_title: { type: 'string' },
        note: { type: 'string' },
        when: { type: 'string', description: dateHelp + ' Cadena vacía para quitar la fecha.' },
        deadline: { type: 'string', description: dateHelp + ' Cadena vacía para quitarla.' },
        list: { type: 'string' },
        urgent: { type: 'boolean' },
        recurrence: { type: 'string', description: 'daily, weekdays, weekly o cadena vacía para que deje de repetirse.' },
      },
    },
  },
  {
    name: 'delete_task',
    description: 'Borra definitivamente una tarea. Requiere el id exacto. Úsalo solo si Yago lo pide de forma explícita; para tareas terminadas usa complete_task.',
    handler: deleteTask,
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
];

// ===== Respuestas HTTP =====
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, x-client-info, x-api-key, content-type, mcp-session-id, mcp-protocol-version',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

// Comparación en tiempo constante para no filtrar la clave por tiempos de respuesta
function keyOk(candidate: string | null | undefined): boolean {
  if (!API_KEY || API_KEY.length < 24 || !candidate) return false;
  const a = new TextEncoder().encode(candidate), b = new TextEncoder().encode(API_KEY);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ b[i];
  return diff === 0;
}

// ===== Calendario: tareas con fecha -> feed ICS =====
const icsEscape = (v: string) => v.replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsDate = (iso: string) => iso.replace(/-/g, '');

function icsEvent(uid: string, date: string, summary: string, description?: string | null): string[] {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VEVENT',
    `UID:${uid}@tareas-yago`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${icsDate(date)}`,
    `DTEND;VALUE=DATE:${icsDate(addDays(date, 1))}`,
    `SUMMARY:${icsEscape(summary)}`,
  ];
  if (description) lines.push(`DESCRIPTION:${icsEscape(description)}`);
  lines.push('TRANSP:TRANSPARENT', 'END:VEVENT');
  return lines;
}

// Las líneas de un ICS no deben pasar de 75 octetos: se pliegan con salto + espacio
function icsFold(line: string): string {
  const bytes = new TextEncoder().encode(line);
  if (bytes.length <= 74) return line;
  const out: string[] = [];
  let current = '';
  for (const ch of line) {
    if (new TextEncoder().encode(current + ch).length > 73) { out.push(current); current = ' ' + ch; }
    else current += ch;
  }
  out.push(current);
  return out.join('\r\n');
}

async function tasksFeed(): Promise<Response> {
  const cols = await getColumns();
  const hecho = findColumn(cols, 'hecho');
  const { data, error } = await db.from('tasks').select('*').is('completed_at', null);
  if (error) throw new Error(error.message);
  const now = today();
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Tareas de Yago//ES', 'CALSCALE:GREGORIAN',
    'X-WR-CALNAME:Tareas', 'X-WR-TIMEZONE:' + TIMEZONE, 'REFRESH-INTERVAL;VALUE=DURATION:PT30M', 'X-PUBLISHED-TTL:PT30M'];

  for (const t of data || []) {
    if (t.priority === 'done' || t.column_id === hecho?.id) continue;
    const mark = t.priority === 'urgent' ? '❗ ' : '';
    // Lo atrasado se enseña hoy para que no se pierda en el pasado
    if (t.scheduled_on) lines.push(...icsEvent(t.id + '-when', t.scheduled_on < now ? now : t.scheduled_on, mark + t.title, t.description));
    if (t.deadline_on && t.deadline_on !== t.scheduled_on) {
      lines.push(...icsEvent(t.id + '-deadline', t.deadline_on < now ? now : t.deadline_on, '⚑ Vence: ' + t.title, t.description));
    }
  }

  const { data: batches } = await db.from('batches').select('id,title,stages,stage_dates');
  const { data: items } = await db.from('batch_items').select('batch_id,stage');
  for (const b of batches || []) {
    const stages: string[] = b.stages || [];
    for (const [k, date] of Object.entries((b.stage_dates || {}) as Record<string, string>)) {
      const n = (items || []).filter((i) => i.batch_id === b.id && i.stage === Number(k)).length;
      if (!n || !date) continue;
      lines.push(...icsEvent(`${b.id}-stage-${k}`, date < now ? now : date, `${stages[Number(k)] ?? 'Etapa'} · ${b.title} (${n} ${n === 1 ? 'pieza' : 'piezas'})`));
    }
  }
  lines.push('END:VCALENDAR');
  return new Response(lines.map(icsFold).join('\r\n') + '\r\n', {
    headers: { ...CORS, 'Content-Type': 'text/calendar; charset=utf-8', 'Cache-Control': 'no-cache' },
  });
}

// ===== Calendario: eventos externos (Google, iCloud…) -> agenda de la app =====
const madridParts = (d: Date) => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (type: string) => p.find((x) => x.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
};

type AgendaEvent = { date: string; time: string | null; end: string | null; title: string; allDay: boolean };

async function readAgenda(from: string, to: string): Promise<{ events: AgendaEvent[]; errors: string[]; configured: boolean }> {
  const { data } = await db.from('app_settings').select('value').eq('key', 'calendar_ics_urls').maybeSingle();
  const urls = String(data?.value || '').split(/\s+/).map((u) => u.trim().replace(/^webcal:/i, 'https:')).filter((u) => /^https:\/\//i.test(u));
  const events: AgendaEvent[] = [];
  const errors: string[] = [];
  const start = new Date(from + 'T00:00:00Z'); start.setUTCDate(start.getUTCDate() - 1);
  const end = new Date(to + 'T23:59:59Z'); end.setUTCDate(end.getUTCDate() + 1);

  await Promise.all(urls.map(async (url, idx) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const expander = new IcalExpander({ ics: await res.text(), maxIterations: 2000 });
      const found = expander.between(start, end);
      const all = [
        ...found.events.map((e: any) => ({ start: e.startDate, end: e.endDate, title: e.summary })),
        ...found.occurrences.map((o: any) => ({ start: o.startDate, end: o.endDate, title: o.item.summary })),
      ];
      for (const e of all) {
        const title = String(e.title || '(sin título)');
        if (e.start.isDate) {
          // Evento de día completo: puede durar varios días (el final es exclusivo)
          const first = `${e.start.year}-${String(e.start.month).padStart(2, '0')}-${String(e.start.day).padStart(2, '0')}`;
          const last = e.end ? `${e.end.year}-${String(e.end.month).padStart(2, '0')}-${String(e.end.day).padStart(2, '0')}` : addDays(first, 1);
          for (let d = first; d < last && d <= to; d = addDays(d, 1)) {
            if (d >= from) events.push({ date: d, time: null, end: null, title, allDay: true });
          }
        } else {
          const s = madridParts(e.start.toJSDate());
          if (s.date < from || s.date > to) continue;
          events.push({ date: s.date, time: s.time, end: e.end ? madridParts(e.end.toJSDate()).time : null, title, allDay: false });
        }
      }
    } catch (err) {
      errors.push(`Calendario ${idx + 1}: ${(err as Error).message}`);
    }
  }));

  events.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.title.localeCompare(b.title));
  return { events, errors, configured: urls.length > 0 };
}

// Rutas para la propia app: se identifican con la sesión de Supabase del usuario, no con la clave
async function sessionUser(req: Request): Promise<boolean> {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return false;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data.user) return false;
  return !OWNER_ID || data.user.id === OWNER_ID;
}

// ===== MCP (JSON-RPC sobre HTTP) =====
async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== 'POST') return json({ error: 'Usa POST' }, 405);
  let msg: any;
  try { msg = await req.json(); } catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON no válido' } }, 400); }
  const reply = (result: unknown) => json({ jsonrpc: '2.0', id: msg.id, result });

  if (msg.id === undefined || msg.id === null) return new Response(null, { status: 202, headers: CORS });
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: msg.params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'tareas-yago', version: '1.0.0' },
        instructions: 'Planificador de tareas personal de Yago. Usa add_task cuando pida apuntar o recordar algo.',
      });
    case 'ping':
      return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === msg.params?.name);
      if (!tool) return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'Herramienta desconocida' } });
      try {
        const result = await tool.handler(msg.params?.arguments || {});
        return reply({ content: [{ type: 'text', text: JSON.stringify(result) }] });
      } catch (e) {
        return reply({ content: [{ type: 'text', text: (e as Error).message }], isError: true });
      }
    }
    default:
      return json({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Método no soportado' } });
  }
}

// ===== OpenAPI para la acción de ChatGPT =====
function openapi(base: string) {
  const op = (tool: typeof TOOLS[number], summary: string) => ({
    operationId: tool.name,
    summary,
    description: tool.description,
    requestBody: { required: true, content: { 'application/json': { schema: tool.inputSchema } } },
    responses: { '200': { description: 'Resultado', content: { 'application/json': { schema: { type: 'object' } } } } },
  });
  return {
    openapi: '3.1.0',
    info: { title: 'Tareas de Yago', version: '1.0.0', description: 'Añade, consulta y completa tareas del planificador personal.' },
    servers: [{ url: base }],
    paths: {
      '/tasks': { post: op(TOOLS[0], 'Añadir una tarea') },
      '/tasks/list': { post: op(TOOLS[1], 'Listar tareas') },
      '/tasks/complete': { post: op(TOOLS[2], 'Completar una tarea') },
      '/tasks/update': { post: op(TOOLS[3], 'Modificar una tarea') },
      '/tasks/delete': { post: op(TOOLS[4], 'Borrar una tarea') },
    },
    components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } }, schemas: {} },
    security: [{ bearer: [] }],
  };
}

const REST_ROUTES: Record<string, (a: Record<string, any>) => Promise<unknown>> = {
  '/tasks': addTask,
  '/tasks/list': listTasks,
  '/tasks/complete': completeTask,
  '/tasks/update': updateTask,
  '/tasks/delete': deleteTask,
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

  const url = new URL(req.url);
  const at = url.pathname.indexOf('/' + FUNCTION_NAME);
  let path = at >= 0 ? url.pathname.slice(at + FUNCTION_NAME.length + 1) : url.pathname;
  path = path.replace(/\/+$/, '') || '/';

  if (req.method === 'GET' && path === '/openapi.json') {
    const base = `https://${url.host}/functions/v1/${FUNCTION_NAME}`;
    return json(openapi(base));
  }

  // Clave en la ruta (/k/<clave>/…) para clientes que no permiten cabeceras, o en cabecera
  let key = req.headers.get('x-api-key') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const inPath = path.match(/^\/k\/([^/]+)(\/.*)?$/);
  if (inPath) { key = decodeURIComponent(inPath[1]); path = inPath[2] || '/'; }
  if (!keyOk(key)) {
    if ((path === '/calendar' || path === '/feed-url') && req.method === 'GET' && await sessionUser(req)) {
      if (path === '/feed-url') return json({ url: `https://${url.host}/functions/v1/${FUNCTION_NAME}/k/${API_KEY}/calendar.ics` });
      const from = url.searchParams.get('from') || today();
      const to = url.searchParams.get('to') || from;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ error: 'Fechas no válidas' }, 400);
      return json(await readAgenda(from, to));
    }
    return json({ error: 'Clave no válida' }, 401);
  }

  if (path === '/mcp') return handleMcp(req);
  if (path === '/calendar' && req.method === 'GET') {
    const from = url.searchParams.get('from') || today();
    const to = url.searchParams.get('to') || from;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) return json({ error: 'Fechas no válidas' }, 400);
    return json(await readAgenda(from, to));
  }
  if (path === '/calendar.ics' && req.method === 'GET') {
    try { return await tasksFeed(); } catch (e) { return json({ error: (e as Error).message }, 500); }
  }

  const handler = REST_ROUTES[path];
  if (!handler) return json({ error: 'Ruta no encontrada' }, 404);
  if (req.method !== 'POST') return json({ error: 'Usa POST' }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    return json(await handler(body || {}));
  } catch (e) {
    return json({ error: (e as Error).message }, 400);
  }
});
