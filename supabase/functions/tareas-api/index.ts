// Puerta de entrada al planificador para asistentes (Claude, ChatGPT) y atajos de iOS.
//
//   MCP (Claude):      POST /tareas-api/k/<clave>/mcp
//   REST (ChatGPT…):   /tareas-api/tasks…  con cabecera  Authorization: Bearer <clave>
//   Esquema OpenAPI:   GET  /tareas-api/openapi.json
//
// Secretos necesarios: TAREAS_API_KEY. SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY los pone Supabase.

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const API_KEY = Deno.env.get('TAREAS_API_KEY') ?? '';
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
  'Access-Control-Allow-Headers': 'authorization, x-api-key, content-type, mcp-session-id, mcp-protocol-version',
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
  if (!keyOk(key)) return json({ error: 'Clave no válida' }, 401);

  if (path === '/mcp') return handleMcp(req);

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
