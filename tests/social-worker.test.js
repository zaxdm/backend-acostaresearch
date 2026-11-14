'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { crearWorker } = require('../src/modules/social-bot/social.worker');
const { limitarTexto } = require('../src/modules/social-bot/social.worker');

const NOW = new Date('2026-11-14T15:00:00Z');
const copy = (value) => structuredClone(value);

test('acorta UTF-8 sin cortar caracteres ni perder el enlace de compra', () => {
  const enlace = 'https://acosta.example/planes';
  const texto = limitarTexto('😊á'.repeat(600) + '\n' + enlace, 'instagram');
  assert.ok(Buffer.byteLength(texto, 'utf8') <= 1000);
  assert.ok(texto.endsWith(enlace));
  assert.ok(!texto.includes('\uFFFD'));
});

// Simula las operaciones de persistencia, no la lógica del worker. Cada lectura
// devuelve una copia para representar correctamente una intervención concurrente.
function coincide(registro, where = {}) {
  return Object.entries(where).every(([key, wanted]) => {
    if (key === 'OR') return wanted.some((branch) => coincide(registro, branch));
    if (key === 'AND') return wanted.every((branch) => coincide(registro, branch));
    const value = registro[key];
    if (wanted instanceof Date) return value instanceof Date && value.getTime() === wanted.getTime();
    if (wanted && typeof wanted === 'object') {
      return Object.entries(wanted).every(([op, bound]) => {
        if (op === 'in') return bound.includes(value);
        if (op === 'lt') return value !== null && value < bound;
        if (op === 'lte') return value !== null && value <= bound;
        if (op === 'gt') return value !== null && value > bound;
        throw new Error(`Operador de prueba no previsto: ${op}`);
      });
    }
    return value === wanted;
  });
}
function aplicar(registro, data) {
  for (const [key, value] of Object.entries(data)) {
    registro[key] = value && typeof value === 'object' && 'increment' in value
      ? (registro[key] || 0) + value.increment : copy(value);
  }
}
function preparar({ enviar, pensar, clienteAt = NOW, humano = false } = {}) {
  const conversaciones = [{
    id: 'c1', clave: 'contacto', canal: 'instagram', cuenta: 'ig1', contacto: 'persona1',
    nombre: '', historial: [], humano, noLeidos: 0, revision: 0,
    ultimoDelClienteAt: clienteAt, queueLease: 'lease1', queueUntil: new Date(NOW.getTime() + 60000),
  }];
  const trabajos = [];
  const tabla = (datos, idPrefix) => ({
    async findUnique({ where }) { return copy(datos.find((r) => coincide(r, where)) || null); },
    async findFirst({ where }) { return copy(datos.find((r) => coincide(r, where)) || null); },
    async findMany({ where }) { return copy(datos.filter((r) => coincide(r, where))); },
    async upsert({ where, create, update }) {
      let row = datos.find((r) => coincide(r, where));
      if (!row) { row = { id: `${idPrefix}${datos.length + 1}`, humano: false, revision: 0, noLeidos: 0, ultimoDelClienteAt: null, ...copy(create) }; datos.push(row); }
      else aplicar(row, update);
      return copy(row);
    },
    async create({ data }) {
      const row = { id: `${idPrefix}${datos.length + 1}`, intentos: 0, proximoAt: NOW, createdAt: NOW, ...copy(data) };
      datos.push(row); return copy(row);
    },
    async update({ where, data }) {
      const row = datos.find((r) => coincide(r, where));
      if (!row) throw new Error('Registro no encontrado');
      aplicar(row, data); return copy(row);
    },
    async updateMany({ where, data }) {
      const matches = datos.filter((r) => coincide(r, where));
      matches.forEach((r) => aplicar(r, data)); return { count: matches.length };
    },
  });
  const db = { socialConversacion: tabla(conversaciones, 'c'), socialTrabajo: tabla(trabajos, 't') };
  db.$transaction = (fn) => fn(db);
  let envios = 0; let pensamientos = 0;
  const worker = crearWorker({
    db, config: () => ({ token: 'falso' }), ahora: () => new Date(NOW),
    transport: { async enviar(e, texto) { envios++; return enviar ? enviar(e, texto) : 'meta1'; } },
    engine: { async atender(e) { pensamientos++; return pensar ? pensar(e, conversaciones[0]) : { texto: 'Respuesta de prueba' }; } },
  });
  const evento = { canal: 'instagram', cuenta: 'ig1', contacto: 'persona1', evento: 'mid1', tipo: 'privado', texto: 'Hola', timestamp: NOW.toISOString(), eco: false };
  const trabajo = { id: 't1', clave: 'evento1', conversacionId: 'c1', autor: 'CLIENTE', evento, texto: 'Hola', respuesta: null, estado: 'PROCESANDO', intentos: 0, revision: 0, createdAt: NOW, proximoAt: NOW };
  trabajos.push(trabajo);
  return { worker, conversaciones, trabajos, evento, trabajo, db, envios: () => envios, pensamientos: () => pensamientos,
    lock: () => ({ lease: 'lease1', c: copy(conversaciones[0]) }) };
}

test('rechazo temporal inequívoco de Meta conserva respuesta y programa reintento', async () => {
  const p = preparar({ enviar: () => { throw Object.assign(new Error('429'), { ambiguo: false, permanente: false }); } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'LISTO');
  assert.equal(p.trabajo.respuesta, 'Respuesta de prueba');
  assert.equal(p.trabajo.proximoAt.getTime(), NOW.getTime() + 30000);
  assert.equal(p.conversaciones[0].humano, false);
  assert.equal(p.envios(), 1);
});

test('timeout tras iniciar el envío queda incierto y pasa al equipo sin reintento automático', async () => {
  const p = preparar({ enviar: () => { throw Object.assign(new Error('timeout'), { ambiguo: true }); } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'INCIERTO');
  assert.equal(p.conversaciones[0].humano, true);
  await p.worker.pasar();
  assert.equal(p.envios(), 1);
});

test('rechazo permanente de permisos no reintenta ni declara un envío confirmado', async () => {
  const p = preparar({ enviar: () => { throw Object.assign(new Error('403'), { ambiguo: false, permanente: true }); } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'ERROR');
  assert.equal(p.conversaciones[0].humano, true);
  assert.equal(p.envios(), 1);
});

test('una persona que interviene durante la generación invalida el texto preparado', async () => {
  const p = preparar({ pensar: (_e, c) => { c.humano = true; c.revision++; return { texto: 'No debe enviarse' }; } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'IGNORADO');
  assert.equal(p.envios(), 0);
});

test('la ventana privada vencida no llama al modelo ni envía una respuesta libre', async () => {
  const p = preparar({ clienteAt: new Date(NOW.getTime() - 86400000) });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'HUMANO');
  assert.equal(p.pensamientos(), 0);
  assert.equal(p.envios(), 0);
});

test('con el bot apagado el mensaje queda visible para atención humana', async () => {
  const p = preparar({ pensar: () => ({ texto: '', humano: false, estado: 'apagado' }) });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'HUMANO');
  assert.equal(p.conversaciones[0].humano, true);
  assert.equal(p.envios(), 0);
});

test('una prueba vencida durante la cola no se entrega como si siguiera disponible', async () => {
  const p = preparar({ pensar: () => ({ texto: 'Prueba: https://acosta.example/prueba/abc' }) });
  p.db.socialPrueba = { findUnique: async () => ({ expiresAt: new Date(0) }) };
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'HUMANO');
  assert.equal(p.conversaciones[0].humano, true);
  assert.equal(p.envios(), 0);
});

test('recibir un comentario no abre la ventana de mensajes privados', async () => {
  const p = preparar({ clienteAt: null });
  p.trabajos.length = 0;
  await p.worker.recibir([{ ...p.evento, tipo: 'comentario', comentarioId: 'comment1' }]);
  const c = p.conversaciones.find((r) => r.contacto === 'persona1' && r.clave !== 'contacto');
  assert.equal(c.ultimoDelClienteAt, null);
  assert.equal(p.trabajos[0].evento.tipo, 'comentario');
  assert.equal(c.noLeidos, 1);
});

test('recuperar un proceso caído durante envío lo marca incierto y no lo vuelve a mandar', async () => {
  const p = preparar();
  p.conversaciones[0].queueUntil = new Date(NOW.getTime() - 1000);
  p.trabajo.estado = 'ENVIANDO';
  await p.worker.recuperar();
  assert.equal(p.trabajo.estado, 'INCIERTO');
  assert.equal(p.conversaciones[0].humano, true);
  assert.equal(p.conversaciones[0].queueLease, null);
  await p.worker.pasar();
  assert.equal(p.envios(), 0);
});

test('recuperar generación interrumpida permite procesarla de nuevo sin marcar envío', async () => {
  const p = preparar();
  p.conversaciones[0].queueUntil = new Date(NOW.getTime() - 1000);
  await p.worker.recuperar();
  assert.equal(p.trabajo.estado, 'PENDIENTE');
  assert.equal(p.conversaciones[0].humano, false);
  assert.equal(p.envios(), 0);
});

test('una revisión humana nueva descarta mensajes manuales que quedaron pendientes', async () => {
  const p = preparar({ humano: true });
  p.trabajo.autor = 'ADMIN'; p.trabajo.texto = 'Mensaje anterior';
  p.conversaciones[0].revision = 1;
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'IGNORADO');
  assert.equal(p.envios(), 0);
});

test('un worker con lease sustituido no sobreescribe el estado de otro worker', async () => {
  const p = preparar({ pensar: (_e, c) => {
    c.queueLease = 'otro-worker';
    p.trabajo.estado = 'ENVIADO';
    p.trabajo.metaId = 'meta-del-worker-nuevo';
    return { texto: 'Respuesta tardía' };
  } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'ENVIADO');
  assert.equal(p.trabajo.metaId, 'meta-del-worker-nuevo');
  assert.equal(p.conversaciones[0].queueLease, 'otro-worker');
  assert.equal(p.envios(), 0);
});

test('el aviso de derivación preparado se puede reintentar aunque el motor ya pausó el bot', async () => {
  const p = preparar({ humano: true });
  p.trabajo.estado = 'LISTO';
  p.trabajo.respuesta = 'Te paso con una persona del equipo.';
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'ENVIADO');
  assert.equal(p.pensamientos(), 0);
  assert.equal(p.envios(), 1);
});

test('la respuesta privada a un comentario sale sin ventana de 24 horas y caduca a los 7 días', async () => {
  const enviados = [];
  const p = preparar({ clienteAt: null, humano: true, enviar: (e) => { enviados.push(e.tipo); return 'meta-privado'; } });
  Object.assign(p.trabajo, { autor: 'ADMIN', texto: 'Info', evento: { ...p.evento, tipo: 'respuesta_privada', comentarioId: 'c1', timestamp: new Date(NOW.getTime() - 86400000).toISOString() } });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'ENVIADO'); assert.equal(p.trabajo.metaId, 'meta-privado');
  assert.deepEqual(enviados, ['respuesta_privada']);

  const viejo = preparar({ clienteAt: null, humano: true });
  Object.assign(viejo.trabajo, { autor: 'ADMIN', texto: 'Info', evento: { ...viejo.evento, tipo: 'respuesta_privada', comentarioId: 'c1', timestamp: new Date(NOW.getTime() - 8 * 86400000).toISOString() } });
  await viejo.worker.procesar(copy(viejo.trabajo), viejo.lock());
  assert.equal(viejo.trabajo.estado, 'IGNORADO'); assert.equal(viejo.envios(), 0);
});

function comentarioDe(p, { texto = 'SKILL', previos = [] } = {}) {
  Object.assign(p.trabajo, { estado: 'PENDIENTE', texto, evento: { ...p.evento, tipo: 'comentario', comentarioId: 'k1', texto } });
  p.trabajos.push(...previos);
}

test('un comentario recibe la información por privado y un aviso público corto', async () => {
  const salidas = [];
  const p = preparar({ enviar: (e, texto) => { salidas.push({ tipo: e.tipo, texto }); return `m${salidas.length}`; }, pensar: () => ({ texto: 'Info del Humanizador 🎥' }) });
  comentarioDe(p);
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.deepEqual(salidas.map((s) => s.tipo), ['respuesta_privada', 'comentario']);
  assert.equal(salidas[0].texto, 'Info del Humanizador 🎥');
  assert.equal(salidas[1].texto, '¡Te escribimos por mensaje directo! 📩');
  assert.equal(p.trabajo.estado, 'ENVIADO'); assert.equal(p.trabajo.metaId, 'm1'); assert.equal(p.trabajo.error, null);
});

test('si el aviso público falla, lo enviado por privado no queda incierto', async () => {
  let n = 0;
  const p = preparar({ enviar: () => { n++; if (n === 2) throw Object.assign(new Error('x'), { ambiguo: true }); return 'm1'; }, pensar: () => ({ texto: 'Info' }) });
  comentarioDe(p);
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.trabajo.estado, 'ENVIADO'); assert.equal(p.trabajo.metaId, 'm1');
  assert.match(p.trabajo.error, /aviso público/);
});

test('un segundo comentario de quien ya recibió la información solo lleva el aviso público y no gasta IA', async () => {
  const salidas = [];
  const previo = { id: 't0', conversacionId: 'c1', autor: 'CLIENTE', estado: 'ENVIADO', respuesta: 'Info', evento: { tipo: 'comentario' }, createdAt: new Date(NOW.getTime() - 1000) };
  const p = preparar({ enviar: (e) => { salidas.push(e.tipo); return 'm9'; } });
  comentarioDe(p, { previos: [previo] });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.deepEqual(salidas, ['comentario']); assert.equal(p.pensamientos(), 0);
  assert.equal(p.trabajo.estado, 'ENVIADO'); assert.equal(p.trabajo.respuesta ?? null, null);
});

test('un comentario que el bot pasa al equipo no recibe nada automático', async () => {
  const p = preparar({ pensar: () => ({ texto: 'Te paso con una persona del equipo.', humano: true }) });
  comentarioDe(p, { texto: 'Son unos estafadores' });
  await p.worker.procesar(copy(p.trabajo), p.lock());
  assert.equal(p.envios(), 0); assert.equal(p.trabajo.estado, 'HUMANO');
});

test('tras 2 horas sin el equipo la conversación vuelve al bot y responde lo que quedó pendiente', async () => {
  const p = preparar({ humano: true });
  Object.assign(p.conversaciones[0], { humanoHasta: new Date(NOW.getTime() - 1000), revision: 4, queueLease: null, queueUntil: null });
  Object.assign(p.trabajo, { estado: 'HUMANO', revision: 4 });
  await p.worker.devolverAlBot();
  assert.equal(p.conversaciones[0].humano, false);
  assert.equal(p.conversaciones[0].humanoHasta, null);
  assert.equal(p.conversaciones[0].revision, 5);
  assert.equal(p.trabajo.estado, 'PENDIENTE'); assert.equal(p.trabajo.revision, 5);
  await p.worker.pasar();
  assert.equal(p.envios(), 1); assert.equal(p.trabajo.estado, 'ENVIADO');
});

test('no vuelve al bot antes de tiempo ni cuando fue el bot quien la derivó', async () => {
  const antes = preparar({ humano: true });
  antes.conversaciones[0].humanoHasta = new Date(NOW.getTime() + 60000);
  await antes.worker.devolverAlBot();
  assert.equal(antes.conversaciones[0].humano, true);

  const derivada = preparar({ humano: true });
  derivada.conversaciones[0].humanoHasta = null;
  await derivada.worker.devolverAlBot();
  assert.equal(derivada.conversaciones[0].humano, true);
});

test('si el último mensaje ya lo contestó el equipo, al volver al bot no se responde nada', async () => {
  const p = preparar({ humano: true });
  Object.assign(p.conversaciones[0], { humanoHasta: new Date(NOW.getTime() - 1000), queueLease: null, queueUntil: null });
  Object.assign(p.trabajo, { autor: 'ADMIN', estado: 'ENVIADO' });
  await p.worker.devolverAlBot();
  assert.equal(p.conversaciones[0].humano, false);
  assert.equal(p.trabajo.estado, 'ENVIADO');
});
