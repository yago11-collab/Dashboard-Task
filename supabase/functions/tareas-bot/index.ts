// Bot de Telegram del planificador. Es una capa fina sobre la función tareas-api.
//
//   POST /tareas-bot/k/<clave>/setup    registra el webhook en Telegram (lo llamo yo una vez)
//   POST /tareas-bot/webhook            mensajes y botones del bot (Telegram lo llama; valida cabecera secreta)
//   POST /tareas-bot/k/<clave>/daily    manda el plan del día (lo llama el cron de la base de datos)
//   POST /tareas-bot/k/<clave>/review   manda la revisión de tareas paradas
//
// Secretos: TAREAS_API_KEY (la misma de tareas-api), TELEGRAM_BOT_TOKEN y TYPEFULLY_API_KEY
// (esta última para los botones Publicar y Programar de los avisos de contenido).
// El chat autorizado se guarda solo la primera vez que se escribe /start.

import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const API_KEY = Deno.env.get('TAREAS_API_KEY') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';
const API = `${Deno.env.get('SUPABASE_URL')}/functions/v1/tareas-api`;
const TIMEZONE = 'Europe/Madrid';
const CHAT_KEY = 'telegram_chat_id';
const ULTIMO_KEY = 'telegram_ultimo';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: TIMEZONE }).format(new Date());
const addDays = (iso: string, n: number) => {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const weekday = (iso: string) => new Date(iso + 'T12:00:00Z').getUTCDay();
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado'];
const slug = (s: string) => (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function fmtDate(iso: string): string {
  const diff = Math.round((new Date(iso + 'T12:00:00Z').getTime() - new Date(today() + 'T12:00:00Z').getTime()) / 86400000);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === -1) return 'ayer';
  if (diff < 0) return `hace ${-diff} días`;
  return new Date(iso + 'T12:00:00Z').toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(/\./g, '');
}

const fmtMin = (n: number) => n < 60 ? `${n} min` : `${Math.floor(n / 60)} h${n % 60 ? ' ' + (n % 60) : ''}`;

// Llama a la API del planificador con la clave
async function api(path: string, body: unknown = {}) {
  const res = await fetch(API + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error ' + res.status);
  return data;
}

async function telegram(method: string, payload: unknown) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.description || 'Telegram: error ' + res.status);
  return data.result;
}

async function getChatId(): Promise<string | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', CHAT_KEY).maybeSingle();
  return data?.value || null;
}

// Lo último que el bot creó, para poder deshacerlo con "borra eso"
async function recordarUltimo(tipo: 'tarea' | 'idea', id: string, titulo: string) {
  await db.from('app_settings').upsert({
    key: ULTIMO_KEY,
    value: JSON.stringify({ tipo, id, titulo, at: new Date().toISOString() }),
    updated_at: new Date().toISOString(),
  });
}

async function leerUltimo(): Promise<{ tipo: string; id: string; titulo: string; at: string } | null> {
  const { data } = await db.from('app_settings').select('value').eq('key', ULTIMO_KEY).maybeSingle();
  if (!data?.value) return null;
  try { return JSON.parse(data.value); } catch { return null; }
}

const send = async (chat: string, text: string) => telegram('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });

// ===== Entender lo que se escribe =====
// Mismo criterio que el alta rápida de la app: fecha, urgencia y lista en la propia frase.
function parseTask(text: string) {
  let t = ' ' + text.trim() + ' ';
  const out: Record<string, unknown> = {};
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => boolean | void) => {
    const m = t.match(re);
    if (m && fn(m) !== false) t = t.replace(m[0], ' ');
  };
  take(/\s(!{1,3}|urgente)(?=\s)/i, () => { out.urgent = true; });
  take(/\scada d[ií]a(?=\s)/i, () => { out.recurrence = 'daily'; });
  take(/\scada semana(?=\s)/i, () => { out.recurrence = 'weekly'; });
  take(/\s(d[ií]as )?laborables(?=\s)/i, () => { out.recurrence = 'weekdays'; });
  take(/\spasado ma[ñn]ana(?=\s)/i, () => { out.when = addDays(today(), 2); });
  take(/\sma[ñn]ana(?=\s)/i, () => { if (out.when) return false; out.when = addDays(today(), 1); });
  take(/\shoy(?=\s)/i, () => { if (out.when) return false; out.when = today(); });
  take(/\s(?:el )?(lunes|martes|mi[eé]rcoles|jueves|viernes|s[aá]bado|domingo)(?=\s)/i, (m) => {
    if (out.when) return false;
    const target = WEEKDAYS.indexOf(slug(m[1]));
    let d = addDays(today(), 1);
    while (weekday(d) !== target) d = addDays(d, 1);
    out.when = d;
  });
  take(/\s(?:el )?(\d{1,2})\/(\d{1,2})(?=\s)/, (m) => {
    if (out.when) return false;
    const now = new Date();
    let d = `${now.getFullYear()}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
    if (d < today()) d = `${now.getFullYear() + 1}${d.slice(4)}`;
    out.when = d;
  });
  take(/\s#([\p{L}\d-]+)(?=\s)/u, (m) => { out.list = m[1]; });
  out.title = t.replace(/\s+/g, ' ').trim();
  return out;
}

function taskLine(t: Record<string, any>, i: number): string {
  const detalle = [
    t.deadline ? `vence ${fmtDate(t.deadline)}` : '',
    t.when && t.when < today() ? `desde ${fmtDate(t.when)}` : '',
    t.estimate_min ? fmtMin(t.estimate_min) : '',
  ].filter(Boolean).join(' · ');
  return `${i + 1}. ${t.urgent ? '❗ ' : ''}${escapeHtml(t.title)}${detalle ? ` <i>(${escapeHtml(detalle)})</i>` : ''}`;
}

const escapeHtml = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function agendaLines(): Promise<string> {
  try {
    const res = await fetch(`${API}/k/${API_KEY}/calendar?from=${today()}&to=${today()}`);
    if (!res.ok) return '';
    const data = await res.json();
    if (!data.events?.length) return '';
    const lines = data.events.map((e: any) => `• ${e.allDay ? 'todo el día' : e.time}  ${escapeHtml(e.title)}`);
    return '\n\n<b>Agenda</b>\n' + lines.join('\n');
  } catch { return ''; }
}

async function dailyMessage(): Promise<string> {
  const { tasks } = await api('/tasks/list', { filter: 'hoy' });
  const mins = tasks.reduce((n: number, t: any) => n + (t.estimate_min || 0), 0);
  const fecha = new Date().toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TIMEZONE });
  let text = `<b>Buenos días</b>\n${fecha}`;
  if (!tasks.length) {
    text += '\n\nNo hay nada planificado para hoy. Abre la app y usa “Planear el día”, o escríbeme aquí una tarea.';
  } else {
    text += ` · ${tasks.length} ${tasks.length === 1 ? 'tarea' : 'tareas'}${mins ? ' · ' + fmtMin(mins) : ''}\n\n`;
    text += tasks.map(taskLine).join('\n');
  }
  text += await agendaLines();
  text += '\n\nEscríbeme una tarea para añadirla, o <b>hecho &lt;texto&gt;</b> para completarla.';
  return text;
}

async function reviewMessage(): Promise<string> {
  const { count: ideas } = await api('/ideas/list', {}).catch(() => ({ count: 0 }));
  const colaIdeas = ideas ? `\n\n💡 Tienes ${ideas} ${ideas === 1 ? 'idea sin decidir' : 'ideas sin decidir'} (/ideas).` : '';
  const { tasks } = await api('/tasks/list', { filter: 'todas' });
  const paradas = tasks.filter((t: any) => !t.when && !t.deadline && !t.recurrence && t.list && !/algun dia|algún día/i.test(t.list));
  if (!paradas.length) return '<b>Revisión semanal</b>\n\nNo hay tareas paradas. Buen trabajo.' + colaIdeas;
  const lista = paradas.slice(0, 15).map(taskLine).join('\n');
  return `<b>Revisión semanal</b>\n\nEstas tareas no tienen fecha:\n\n${lista}` +
    (paradas.length > 15 ? `\n\n…y ${paradas.length - 15} más.` : '') +
    '\n\nDecide con cada una: ponle fecha desde la app, o escríbeme <b>hecho &lt;texto&gt;</b> si ya la hiciste.' + colaIdeas;
}

// Avisos de tareas con hora: se mandan una vez y se borra la hora para no repetirlos
async function sendReminders(): Promise<number> {
  const chat = await getChatId();
  if (!chat) return 0;
  const now = new Date();
  const desde = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from('tasks')
    .select('id,title,remind_at,estimate_min')
    .is('deleted_at', null)
    .is('completed_at', null)
    .not('remind_at', 'is', null)
    .lte('remind_at', now.toISOString())
    .gte('remind_at', desde);
  if (error) throw new Error(error.message);
  const pend = data || [];
  for (const t of pend) {
    const hora = new Date(t.remind_at).toLocaleTimeString('es-ES', { timeZone: TIMEZONE, hour: '2-digit', minute: '2-digit' });
    await send(chat, `⏰ <b>${escapeHtml(t.title)}</b>\nEra para las ${hora}.` + (t.estimate_min ? ` (${fmtMin(t.estimate_min)})` : ''));
    await db.from('tasks').update({ remind_at: null }).eq('id', t.id);
  }
  return pend.length;
}

// ===== Mensajes del bot =====
async function handleMessage(chatId: string, text: string) {
  const bound = await getChatId();
  const clean = text.trim();
  const lower = slug(clean);

  if (lower === 'start' || clean === '/start') {
    if (!bound) {
      await db.from('app_settings').upsert({ key: CHAT_KEY, value: chatId, updated_at: new Date().toISOString() });
      await send(chatId, '<b>Listo.</b> Este chat ya está conectado a tu planificador.\n\nEscríbeme una tarea y la añado: “grabar reel mañana”, “facturación viernes !”, “revisar DMs cada día”.\nPara una idea suelta: <b>idea lo que sea</b>.\n\nComandos: /hoy, /ideas, /pendientes, <b>hecho &lt;texto&gt;</b> y <b>borra eso</b>.');
    } else if (bound === chatId) {
      await send(chatId, 'Este chat ya estaba conectado. Escríbeme una tarea o usa /hoy.');
    } else {
      await send(chatId, 'Este bot ya está conectado a otro chat.');
    }
    return;
  }

  if (!bound || bound !== chatId) {
    await send(chatId, bound ? 'Este bot no responde en este chat.' : 'Escribe /start para conectar este chat con tu planificador.');
    return;
  }

  if (clean === '/hoy' || lower === 'hoy' || lower === 'que tengo hoy') {
    await send(chatId, await dailyMessage());
    return;
  }
  if (clean === '/pendientes' || lower === 'pendientes' || lower === 'revision') {
    await send(chatId, await reviewMessage());
    return;
  }
  if (clean === '/ayuda' || clean === '/help') {
    await send(chatId, 'Escríbeme una tarea para añadirla. Entiendo “hoy”, “mañana”, “el viernes”, “25/9”, “a las 17:00”, “cada día”, “!” para urgente y “#lista”.\n\n<b>idea &lt;texto&gt;</b> · apunta una idea, sin convertirla en tarea\n/hoy · el plan del día\n/ideas · ideas pendientes\n/pendientes · lo que no tiene fecha\nhecho &lt;texto&gt; · completar una tarea\nborra eso · deshace lo último que apunté');
    return;
  }

  if (clean === '/ideas' || lower === 'ideas') {
    const { ideas } = await api('/ideas/list', {});
    if (!ideas.length) { await send(chatId, 'No hay ideas pendientes.'); return; }
    const lines = ideas.slice(0, 20).map((i: any, n: number) => `${n + 1}. ${escapeHtml(i.text)}`).join('\n');
    await send(chatId, `<b>Ideas pendientes</b>\n\n${lines}\n\nSe deciden en la app, en la vista Ideas.`);
    return;
  }

  if (/^\/?(borra eso|borra|deshacer|undo|olvidalo|olvídalo|anula)( .*)?$/i.test(clean)) {
    const ultimo = await leerUltimo();
    if (!ultimo) { await send(chatId, 'No tengo nada reciente que borrar.'); return; }
    // Solo lo creado en la última hora: pasado ese rato, mejor borrarlo en la app
    if (Date.now() - new Date(ultimo.at).getTime() > 60 * 60 * 1000) {
      await send(chatId, `Lo último que apunté fue <b>${escapeHtml(ultimo.titulo)}</b>, pero hace más de una hora. Bórralo desde la app para no liarla.`);
      return;
    }
    if (ultimo.tipo === 'idea') await db.from('ideas').update({ archived_at: new Date().toISOString() }).eq('id', ultimo.id);
    else await db.from('tasks').update({ deleted_at: new Date().toISOString() }).eq('id', ultimo.id);
    await db.from('app_settings').delete().eq('key', ULTIMO_KEY);
    await send(chatId, `🗑️ Borrado: <b>${escapeHtml(ultimo.titulo)}</b>` + (ultimo.tipo === 'tarea' ? '\nEstá en la papelera 30 días.' : ''));
    return;
  }

  // Un mensaje que empieza por @ suele ser una mención, no una tarea
  if (/^@\w+$/.test(clean)) {
    await send(chatId, 'Eso parece una mención, no una tarea, así que no la apunto. Si quieres apuntarla, escríbela con más texto.');
    return;
  }

  const ideaMatch = clean.match(/^\/?(idea|ideas?:)\s+(.+)$/is);
  if (ideaMatch) {
    try {
      const i = await api('/ideas', { text: ideaMatch[2].trim(), source: 'telegram' });
      await recordarUltimo('idea', i.id, i.text);
      await send(chatId, `💡 Apuntada: <b>${escapeHtml(i.text)}</b>\nLa decides luego en la vista Ideas.\n\n<i>Si me he colado, escribe “borra eso”.</i>`);
    } catch (e) {
      await send(chatId, '⚠️ ' + escapeHtml((e as Error).message));
    }
    return;
  }

  const doneMatch = clean.match(/^\/?(hecho|hecha|completar|done)\s+(.+)$/i);
  if (doneMatch) {
    try {
      const t = await api('/tasks/complete', { title: doneMatch[2].trim() });
      await send(chatId, `✅ Hecho: <b>${escapeHtml(t.title)}</b>` + (t.when ? `\nVuelve ${fmtDate(t.when)}.` : ''));
    } catch (e) {
      await send(chatId, '⚠️ ' + escapeHtml((e as Error).message));
    }
    return;
  }

  if (clean.startsWith('/')) {
    await send(chatId, 'No conozco ese comando. Usa /ayuda.');
    return;
  }

  try {
    const fields = parseTask(clean);
    if (!fields.title) { await send(chatId, 'No he entendido la tarea.'); return; }
    const t = await api('/tasks', fields);
    await recordarUltimo('tarea', t.id, t.title);
    const detalle = [t.list, t.when ? fmtDate(t.when) : '', t.recurrence ? 'se repite' : '', t.urgent ? 'urgente' : ''].filter(Boolean).join(' · ');
    await send(chatId, `➕ <b>${escapeHtml(t.title)}</b>\n<i>${escapeHtml(detalle)}</i>`);
  } catch (e) {
    await send(chatId, '⚠️ ' + escapeHtml((e as Error).message));
  }
}

// ===== Botones de Typefully (avisos de la caza de contenido) =====
// Los avisos llegan con botones cuyo callback_data es "tf:<accion>:<cuenta>:<draft>".
// Publicar pide confirmación. Programar busca el primer hueco de las franjas habituales
// que deje al menos 3 horas con lo ya programado o publicado en esa cuenta.
// Secreto: TYPEFULLY_API_KEY.
const TYPEFULLY_KEY = Deno.env.get('TYPEFULLY_API_KEY') ?? '';
const TF_CUENTAS: Record<string, string> = { '170360': 'Yoker', '178070': 'ValerIA' };
const TF_HUECOS: [number, number][] = [[9, 0], [12, 45], [16, 0], [20, 0]];
const TF_MARGEN_MIN = 180;

async function typefully(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch('https://api.typefully.com/v2' + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TYPEFULLY_KEY },
  });
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.detail || data?.message || 'Typefully: error ' + res.status);
  return data;
}

// Hora de Madrid -> instante UTC, sin depender del horario de verano
function madridUtc(fecha: string, h: number, m: number): Date {
  const [y, mo, d] = fecha.split('-').map(Number);
  const guess = new Date(Date.UTC(y, mo - 1, d, h, m));
  const p: Record<string, string> = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(guess).map((x) => [x.type, x.value]),
  );
  const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return new Date(guess.getTime() - (local - guess.getTime()));
}

const tfFecha = (d: Date) => new Intl.DateTimeFormat('es-ES', { timeZone: TIMEZONE, weekday: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d);

async function tfOcupadas(cuenta: string): Promise<number[]> {
  const [prog, pub] = await Promise.all([
    typefully(`/social-sets/${cuenta}/drafts?status=scheduled&limit=50`),
    typefully(`/social-sets/${cuenta}/drafts?status=published&order_by=-published_at&limit=3`),
  ]);
  const out: number[] = [];
  for (const d of prog.results || []) if (d.scheduled_date) out.push(new Date(d.scheduled_date).getTime());
  for (const d of pub.results || []) if (d.published_at) out.push(new Date(d.published_at).getTime());
  return out;
}

async function tfHueco(cuenta: string): Promise<Date> {
  const ocupadas = await tfOcupadas(cuenta);
  const desde = Date.now() + 15 * 60000;
  for (let i = 0; i < 8; i++) {
    const fecha = addDays(today(), i);
    for (const [h, m] of TF_HUECOS) {
      const t = madridUtc(fecha, h, m);
      if (t.getTime() < desde) continue;
      if (ocupadas.every((o) => Math.abs(o - t.getTime()) >= TF_MARGEN_MIN * 60000)) return t;
    }
  }
  throw new Error('No hay hueco libre en los próximos 8 días');
}

function tfTeclado(cuenta: string, draft: string): any {
  return { inline_keyboard: [
    [{ text: '🚀 Publicar', callback_data: `tf:pub:${cuenta}:${draft}` }, { text: '🗓 Programar', callback_data: `tf:prog:${cuenta}:${draft}` }],
    [{ text: '✏️ Abrir en Typefully', url: `https://typefully.com/?d=${draft}&a=${cuenta}` }],
  ] };
}
const tfSoloAbrir = (cuenta: string, draft: string): any => ({ inline_keyboard: [[{ text: '✏️ Abrir en Typefully', url: `https://typefully.com/?d=${draft}&a=${cuenta}` }]] });

async function handleCallback(cb: any) {
  const chat = String(cb.message?.chat?.id ?? '');
  const msgId = cb.message?.message_id;
  const responder = (text = '', alerta = false) => telegram('answerCallbackQuery', { callback_query_id: cb.id, text, show_alert: alerta });
  const bound = await getChatId();
  if (!bound || chat !== bound || String(cb.from?.id) !== bound) { await responder('Este botón no es para ti.'); return; }
  const m = String(cb.data || '').match(/^tf:(pub|pubok|prog|volver):(\d+):(\d+)$/);
  if (!m) { await responder(); return; }
  const [, accion, cuenta, draft] = m;
  const nombre = TF_CUENTAS[cuenta];
  if (!nombre) { await responder('Cuenta no permitida.', true); return; }
  if (!TYPEFULLY_KEY) { await responder('Falta el secreto TYPEFULLY_API_KEY en Supabase.', true); return; }
  const marcar = (reply_markup: any) => telegram('editMessageReplyMarkup', { chat_id: chat, message_id: msgId, reply_markup });
  const contestar = (text: string) => telegram('sendMessage', { chat_id: chat, text, parse_mode: 'HTML', reply_parameters: { message_id: msgId }, link_preview_options: { is_disabled: true } });

  if (accion === 'volver') { await marcar(tfTeclado(cuenta, draft)); await responder(); return; }

  if (accion === 'pub') {
    // Paso de confirmación, con aviso si se salta el margen de 3 horas
    let aviso = '';
    try {
      const ahora = Date.now(), ocupadas = await tfOcupadas(cuenta);
      const antes = ocupadas.filter((o) => o <= ahora), despues = ocupadas.filter((o) => o > ahora);
      const ultima = antes.length ? Math.max(...antes) : 0, proxima = despues.length ? Math.min(...despues) : 0;
      if (ultima && ahora - ultima < TF_MARGEN_MIN * 60000) aviso = `Ojo: lo último de ${nombre} salió hace ${Math.round((ahora - ultima) / 60000)} min.`;
      else if (proxima && proxima - ahora < TF_MARGEN_MIN * 60000) aviso = `Ojo: tienes algo programado en ${nombre} dentro de ${Math.round((proxima - ahora) / 60000)} min.`;
    } catch { /* si no se puede mirar la cola, se pregunta sin aviso */ }
    await marcar({ inline_keyboard: [[{ text: '✅ Sí, publicar ya', callback_data: `tf:pubok:${cuenta}:${draft}` }, { text: '↩️ Volver', callback_data: `tf:volver:${cuenta}:${draft}` }]] });
    await responder(aviso ? aviso + ' ¿Publicar igualmente?' : `¿Publicar ahora en ${nombre}?`, !!aviso);
    return;
  }

  await responder('Un momento…');
  try {
    if (accion === 'pubok') {
      await typefully(`/social-sets/${cuenta}/drafts/${draft}`, { method: 'PATCH', body: JSON.stringify({ publish_at: 'now' }) });
      await marcar(tfSoloAbrir(cuenta, draft));
      await contestar(`✅ <b>Publicando en ${nombre}.</b> En unos segundos está en X.`);
    } else {
      const t = await tfHueco(cuenta);
      const d = await typefully(`/social-sets/${cuenta}/drafts/${draft}`, { method: 'PATCH', body: JSON.stringify({ publish_at: t.toISOString() }) });
      await marcar(tfSoloAbrir(cuenta, draft));
      await contestar(`🗓 <b>Programado en ${nombre}</b> para el ${tfFecha(new Date(d.scheduled_date || t))}.`);
    }
  } catch (e) {
    await marcar(tfTeclado(cuenta, draft)).catch(() => {});
    await contestar('⚠️ No se ha podido: ' + escapeHtml((e as Error).message));
  }
}

// ===== HTTP =====
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function keyOk(candidate: string | null | undefined): boolean {
  if (!API_KEY || API_KEY.length < 24 || !candidate) return false;
  const a = new TextEncoder().encode(candidate), b = new TextEncoder().encode(API_KEY);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) diff |= (a[i % (a.length || 1)] ?? 0) ^ b[i];
  return diff === 0;
}

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const at = url.pathname.indexOf('/tareas-bot');
  let path = (at >= 0 ? url.pathname.slice(at + '/tareas-bot'.length) : url.pathname).replace(/\/+$/, '') || '/';

  if (!BOT_TOKEN) return json({ error: 'Falta el secreto TELEGRAM_BOT_TOKEN' }, 500);

  // Telegram entrega los mensajes aquí; se valida con la cabecera secreta que se registró en setup
  if (path === '/webhook') {
    if (!keyOk(req.headers.get('x-telegram-bot-api-secret-token'))) return json({ error: 'no' }, 401);
    let update: any = {};
    try { update = await req.json(); } catch { /* cuerpo vacío */ }
    if (update.callback_query) {
      try { await handleCallback(update.callback_query); } catch (e) { console.error('Error atendiendo el botón:', e); }
      return json({ ok: true });
    }
    const msg = update.message || update.edited_message;
    const text = msg?.text;
    const chatId = msg?.chat?.id;
    if (!text || !chatId) return json({ ok: true });
    try {
      await handleMessage(String(chatId), text);
    } catch (e) {
      console.error('Error atendiendo el mensaje:', e);
      try { await send(String(chatId), '⚠️ Algo ha fallado: ' + escapeHtml((e as Error).message)); } catch { /* sin respuesta */ }
    }
    return json({ ok: true });
  }

  const inPath = path.match(/^\/k\/([^/]+)(\/.*)?$/);
  if (!inPath || !keyOk(decodeURIComponent(inPath[1]))) return json({ error: 'Clave no válida' }, 401);
  path = inPath[2] || '/';

  try {
    if (path === '/setup') {
      const hook = `https://${url.host}/functions/v1/tareas-bot/webhook`;
      await telegram('setWebhook', { url: hook, secret_token: API_KEY, allowed_updates: ['message', 'callback_query'], drop_pending_updates: true });
      const me = await telegram('getMe', {});
      return json({ ok: true, bot: me.username, webhook: hook, chat: await getChatId() });
    }
    if (path === '/status') return json({ chat: await getChatId(), webhook: await telegram('getWebhookInfo', {}) });
    if (path === '/reminders') return json({ ok: true, sent: await sendReminders() });
    if (path === '/daily' || path === '/review') {
      // El cron corre en UTC: se le pasa la hora y los días locales para que el cambio
      // de horario de verano no mueva el aviso. Si no coinciden, no se manda nada.
      const at = url.searchParams.get('at');
      const dow = url.searchParams.get('dow');
      if (at || dow) {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: TIMEZONE, hour: '2-digit', weekday: 'short', hourCycle: 'h23' }).formatToParts(new Date());
        const hour = Number(parts.find((p) => p.type === 'hour')?.value);
        const day = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'].indexOf(String(parts.find((p) => p.type === 'weekday')?.value).toLowerCase().slice(0, 3));
        if (at && hour !== Number(at)) return json({ skipped: 'hora local ' + hour });
        if (dow && !dow.split(',').map(Number).includes(day)) return json({ skipped: 'día local ' + day });
      }
      const chat = await getChatId();
      if (!chat) return json({ error: 'Todavía no hay ningún chat conectado: escribe /start al bot' }, 400);
      const text = path === '/daily' ? await dailyMessage() : await reviewMessage();
      await send(chat, text);
      return json({ ok: true, sent: text.length });
    }
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  return json({ error: 'Ruta no encontrada' }, 404);
});
