// Widget de Tareas para Scriptable (iOS). Funciona en la pantalla de inicio y en la bloqueada.
//
// 1. Instala Scriptable (gratis) desde la App Store.
// 2. Crea un script nuevo, pega todo esto y ponle de nombre "Tareas".
// 3. Sustituye PEGA_AQUI_TU_CLAVE por la clave que está en conexion-privada.md.
// 4. Añade el widget a la pantalla: mantén pulsado, Editar, Añadir widget, Scriptable,
//    elige el tamaño, y en sus ajustes pon Script = Tareas.
//
// La clave da acceso a tus tareas: no compartas este script con nadie.

const API = 'https://zttdbsprkqconspnwzxx.supabase.co/functions/v1/tareas-api';
const CLAVE = 'PEGA_AQUI_TU_CLAVE';

const AZUL = new Color('#4da3ff');
const FONDO = new Color('#0a1526');
const TENUE = new Color('#8a9ab9');
const BLANCO = new Color('#e8eefb');
const ROJO = new Color('#ff8a93');

async function pedir(ruta, cuerpo) {
  const req = new Request(API + ruta);
  req.method = 'POST';
  req.headers = { 'Content-Type': 'application/json', Authorization: 'Bearer ' + CLAVE };
  req.body = JSON.stringify(cuerpo || {});
  req.timeoutInterval = 15;
  return await req.loadJSON();
}

function minutos(n) {
  if (!n) return '';
  return n < 60 ? n + ' min' : Math.floor(n / 60) + ' h' + (n % 60 ? ' ' + (n % 60) : '');
}

function hora(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

let datos = { tasks: [], error: null };
try {
  datos = await pedir('/tasks/list', { filter: 'hoy' });
} catch (e) {
  datos = { tasks: [], error: 'Sin conexión' };
}

const tareas = (datos.tasks || []).filter(t => !t.done);
const total = minutos(tareas.reduce((n, t) => n + (t.estimate_min || 0), 0));
const familia = config.widgetFamily || 'medium';
const w = new ListWidget();
w.url = 'https://yago11-collab.github.io/Dashboard-Task/dashboard-supabase.html';

// Pantalla bloqueada: una línea o un rectángulo pequeño, sin fondo propio
if (familia === 'accessoryInline') {
  w.addText(tareas.length ? tareas.length + ' tareas · ' + (tareas[0].title || '') : 'Día despejado');
} else if (familia === 'accessoryCircular') {
  const pila = w.addStack();
  pila.layoutVertically();
  const n = pila.addText(String(tareas.length));
  n.font = Font.boldSystemFont(20);
  n.centerAlignText();
  const etiqueta = pila.addText('hoy');
  etiqueta.font = Font.systemFont(9);
  etiqueta.centerAlignText();
} else if (familia === 'accessoryRectangular') {
  const t1 = w.addText(tareas.length ? tareas.length + (tareas.length === 1 ? ' tarea hoy' : ' tareas hoy') : 'Día despejado');
  t1.font = Font.semiboldSystemFont(13);
  t1.lineLimit = 1;
  for (const t of tareas.slice(0, 2)) {
    const linea = w.addText((t.urgent ? '! ' : '') + t.title);
    linea.font = Font.systemFont(12);
    linea.lineLimit = 1;
  }
  if (!tareas.length && total) w.addText(total).font = Font.systemFont(12);
} else {
  // Pantalla de inicio
  w.backgroundColor = FONDO;
  w.setPadding(14, 16, 14, 16);

  const cabecera = w.addStack();
  cabecera.centerAlignContent();
  const dia = cabecera.addText(String(new Date().getDate()));
  dia.font = Font.boldSystemFont(26);
  dia.textColor = BLANCO;
  cabecera.addSpacer(8);

  const resumen = cabecera.addStack();
  resumen.layoutVertically();
  const l1 = resumen.addText(tareas.length ? (tareas.length === 1 ? '1 tarea' : tareas.length + ' tareas') : 'Día despejado');
  l1.font = Font.semiboldSystemFont(14);
  l1.textColor = BLANCO;
  if (total) {
    const l2 = resumen.addText(total);
    l2.font = Font.systemFont(11);
    l2.textColor = TENUE;
  }
  cabecera.addSpacer();

  if (datos.error) {
    const err = cabecera.addText('sin conexión');
    err.font = Font.systemFont(10);
    err.textColor = TENUE;
  }

  w.addSpacer(10);

  const cuantas = familia === 'large' ? 8 : 3;
  for (const t of tareas.slice(0, cuantas)) {
    const fila = w.addStack();
    fila.centerAlignContent();
    const punto = fila.addText('•');
    punto.font = Font.systemFont(13);
    punto.textColor = t.urgent ? ROJO : AZUL;
    fila.addSpacer(6);
    const titulo = fila.addText(t.title);
    titulo.font = Font.systemFont(13);
    titulo.textColor = BLANCO;
    titulo.lineLimit = 1;
    if (t.remind_at) {
      fila.addSpacer();
      const h = fila.addText(hora(t.remind_at));
      h.font = Font.systemFont(11);
      h.textColor = TENUE;
    }
    w.addSpacer(5);
  }

  if (!tareas.length && !datos.error) {
    const vacio = w.addText('Nada planificado. Abre la app y planea el día.');
    vacio.font = Font.systemFont(12);
    vacio.textColor = TENUE;
  }
  w.addSpacer();
}

w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);

if (config.runsInWidget) {
  Script.setWidget(w);
} else {
  await w.presentMedium();
}
Script.complete();
