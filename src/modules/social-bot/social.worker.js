'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { solicitaPrueba } = require('./social.schema');
const hash = (...p) => createHash('sha256').update(JSON.stringify(p)).digest('hex');
const TERMINADOS = ['ENVIADO', 'HUMANO', 'ERROR', 'INCIERTO', 'IGNORADO'];
const ACTIVOS = ['PENDIENTE', 'PROCESANDO', 'LISTO', 'ENVIANDO'];
const ventana = (fecha, ahora) => fecha && new Date(fecha) <= ahora && ahora - new Date(fecha) < 86400000;
function limitarTexto(texto, canal) {
  const limite = { facebook: 2000, instagram: 1000, whatsapp: 4000 }[canal] || 1000;
  const tamano = (t) => canal === 'instagram' ? Buffer.byteLength(t, 'utf8') : t.length;
  if (tamano(texto) <= limite) return texto;
  const enlaces = texto.match(/https?:\/\/\S+/g) || [];
  const pie = enlaces[0] && tamano(enlaces[0]) < limite / 2 ? `\n${enlaces[0]}` : '';
  const cuerpo = texto.replace(/https?:\/\/\S+/g, '').trim();
  let corto = '';
  for (const letra of cuerpo) {
    if (tamano(corto + letra + '…' + pie) > limite) break;
    corto += letra;
  }
  return corto.trimEnd() + '…' + pie;
}

/** Cola persistente. Solo reintenta envíos rechazados de forma inequívoca.
 * Un envío interrumpido tras llamar a Meta queda INCIERTO para revisión humana.
 */
function crearWorker({ db, engine, transport, config, ahora = () => new Date() }) {
  async function recibir(eventos) {
    for (const e of eventos) {
      const clave = hash(e.canal, e.cuenta, e.evento);
      if (await db.socialTrabajo.findUnique({ where: { clave } })) continue;
      try {
        await db.$transaction(async (tx) => {
          const identidad = hash(e.canal, e.cuenta, e.contacto);
          let c = await tx.socialConversacion.upsert({
            where: { clave: identidad }, update: {},
            create: { clave: identidad, canal: e.canal, cuenta: e.cuenta, contacto: e.contacto, nombre: (e.nombre || '').slice(0, 120), historial: [] },
          });
          // El eco de un envío propio no debe pausar el bot. Puede llegar antes de guardar su ID.
          const propio = e.eco && await tx.socialTrabajo.findFirst({ where: {
            conversacionId: c.id, OR: [{ metaId: e.evento }, { estado: 'ENVIANDO', OR: [{ respuesta: e.texto }, { autor: 'ADMIN', texto: e.texto }] }],
          } });
          await tx.socialTrabajo.create({ data: {
            clave, conversacionId: c.id, autor: e.eco ? 'ADMIN' : 'CLIENTE',
            texto: (e.texto || '(Adjunto no procesado)').slice(0, 4000), evento: e,
            estado: propio ? 'IGNORADO' : e.eco ? 'ENVIADO' : 'PENDIENTE',
            metaId: e.eco ? e.evento : null, revision: c.revision,
          } });
          if (propio) return;
          const fecha = new Date(e.timestamp);
          const mensajeAt = !Number.isNaN(fecha.getTime()) && fecha < ahora() ? fecha : ahora();
          c = await tx.socialConversacion.update({ where: { id: c.id }, data: {
            ...(e.nombre ? { nombre: e.nombre.slice(0, 120) } : {}),
            ultimoMensajeAt: ahora(),
            ...(!e.eco ? { noLeidos: { increment: 1 } } : {}),
            ...(!e.eco && e.tipo === 'privado' && (!c.ultimoDelClienteAt || mensajeAt > c.ultimoDelClienteAt) ? { ultimoDelClienteAt: mensajeAt } : {}),
            ...(e.eco ? { humano: true, revision: { increment: 1 }, lease: null, busyUntil: null,
              historial: [...c.historial, { rol: 'asistente', texto: e.texto || '(Adjunto enviado por el equipo)' }].slice(-20),
            } : {}),
          } });
        });
      } catch (error) {
        // Un choque en el alta de conversación puede ser de OTRO mensaje.
        // Solo confirmar un duplicado si este evento concreto ya está persistido.
        if (error.code !== 'P2002' || !await db.socialTrabajo.findUnique({ where: { clave } })) throw error;
      }
    }
  }

  async function recuperar() {
    const vencidas = await db.socialConversacion.findMany({ where: { queueUntil: { lt: ahora() } }, take: 20 });
    for (const c of vencidas) {
      await db.$transaction(async (tx) => {
        const tomada = await tx.socialConversacion.updateMany({
          where: { id: c.id, queueLease: c.queueLease, queueUntil: { lt: ahora() } },
          data: { queueLease: null, queueUntil: null },
        });
        if (!tomada.count) return;
        const inciertos = await tx.socialTrabajo.updateMany({
          where: { conversacionId: c.id, estado: 'ENVIANDO' },
          data: { estado: 'INCIERTO', error: 'Envío interrumpido: verifica en Meta antes de volver a responder.' },
        });
        await tx.socialTrabajo.updateMany({ where: { conversacionId: c.id, estado: 'PROCESANDO' }, data: { estado: 'PENDIENTE', proximoAt: ahora() } });
        if (inciertos.count) await tx.socialConversacion.update({ where: { id: c.id }, data: { humano: true, revision: { increment: 1 } } });
      });
    }
  }

  async function reclamar(t) {
    return db.$transaction(async (tx) => {
      const anterior = await tx.socialTrabajo.findFirst({ where: {
        conversacionId: t.conversacionId, estado: { in: ACTIVOS },
        OR: [{ createdAt: { lt: t.createdAt } }, { createdAt: t.createdAt, id: { lt: t.id } }],
      } });
      if (anterior) return null;
      const lease = randomUUID();
      const lock = await tx.socialConversacion.updateMany({
        where: { id: t.conversacionId, OR: [{ queueUntil: null }, { queueUntil: { lt: ahora() } }] },
        data: { queueLease: lease, queueUntil: new Date(ahora().getTime() + 240000) },
      });
      if (!lock.count) return null;
      const trabajo = await tx.socialTrabajo.updateMany({
        where: { id: t.id, estado: t.estado, proximoAt: { lte: ahora() } },
        data: { estado: t.estado === 'LISTO' ? 'LISTO' : 'PROCESANDO', intentos: { increment: 1 } },
      });
      if (!trabajo.count) {
        await tx.socialConversacion.updateMany({ where: { id: t.conversacionId, queueLease: lease }, data: { queueLease: null, queueUntil: null } });
        return null;
      }
      return { lease, c: await tx.socialConversacion.findUnique({ where: { id: t.conversacionId } }) };
    });
  }

  async function procesar(t, lock) {
    let enviando = false;
    const guardar = (data, comprobarRevision = false, turno = null) => db.$transaction(async (tx) => {
      // Todo cambio del trabajo comprueba y renueva la propiedad bajo el mismo bloqueo de BD.
      const propio = await tx.socialConversacion.updateMany({
        where: { id: t.conversacionId, queueLease: lock.lease, queueUntil: { gt: ahora() }, ...(comprobarRevision ? { revision: lock.c.revision } : {}) },
        data: { queueUntil: new Date(ahora().getTime() + 240000) },
      });
      if (!propio.count) return false;
      await tx.socialTrabajo.update({ where: { id: t.id }, data });
      if (turno) {
        const actual = await tx.socialConversacion.findUnique({ where: { id: t.conversacionId } });
        await tx.socialConversacion.update({ where: { id: t.conversacionId }, data: { historial: [...actual.historial, turno].slice(-20) } });
      }
      return true;
    });
    const finalizar = async (_t, estado, error = null) => {
      const turno = estado === 'HUMANO' && t.autor === 'CLIENTE' && t.evento.tipo === 'privado' ? { rol: 'usuario', texto: t.texto } : null;
      const terminado = await guardar({ estado, error }, false, turno);
      if (terminado && estado === 'HUMANO') await db.socialConversacion.updateMany({ where: { id: t.conversacionId, queueLease: lock.lease }, data: { humano: true } });
      return terminado;
    };
    try {
      let c = lock.c;
      const e = t.evento;
      if (t.autor !== 'ADMIN' && c.humano && t.estado !== 'LISTO') return await finalizar(t, 'HUMANO');
      if (t.autor !== 'ADMIN' && t.revision !== c.revision) return await finalizar(t, 'IGNORADO', 'La conversación cambió de responsable.');
      if (t.autor === 'ADMIN' && t.revision !== c.revision) return await finalizar(t, 'IGNORADO', 'Otra intervención sustituyó este mensaje pendiente.');
      if (e.tipo !== 'comentario' && !ventana(c.ultimoDelClienteAt, ahora())) return await finalizar(t, 'HUMANO', 'La ventana de respuesta de 24 horas está cerrada.');
      if (e.tipo === 'comentario' && ahora() - new Date(e.timestamp) > 7 * 86400000) return await finalizar(t, 'IGNORADO', 'Comentario antiguo.');
      let texto = t.respuesta || (t.autor === 'ADMIN' ? t.texto : '');
      if (!texto) {
        if (!e.texto) {
          await db.socialConversacion.update({ where: { id: c.id }, data: { humano: true } });
          return await finalizar(t, 'HUMANO', 'Adjunto: necesita atención del equipo.');
        }
        const r = await engine.atender({ ...e, accion: e.tipo === 'privado' && solicitaPrueba(e.texto) ? 'prueba' : 'responder' });
        if (!r.texto) return await finalizar(t, r.humano ? 'HUMANO' : 'IGNORADO');
        texto = r.texto;
        texto = limitarTexto(texto, e.canal);
        if (!await guardar({ respuesta: texto, estado: 'LISTO' })) return;
      }
      // Pausar durante la generación invalida la respuesta; el motor puede derivar sin cambiar revisión.
      c = await db.socialConversacion.findUnique({ where: { id: c.id } });
      if (c.queueLease !== lock.lease || c.revision !== lock.c.revision) return await finalizar(t, 'IGNORADO', 'Intervino una persona antes del envío.');
      if (t.autor === 'CLIENTE' && texto.includes('/prueba/')) {
        const prueba = await db.socialPrueba.findUnique({ where: { contacto: c.clave } });
        if (!prueba || prueba.expiresAt <= ahora()) return await finalizar(t, 'HUMANO', 'La prueba venció mientras el envío estaba pendiente. Necesita revisión del equipo.');
      }
      if (e.tipo !== 'comentario' && !ventana(c.ultimoDelClienteAt, ahora())) return await finalizar(t, 'HUMANO', 'La ventana de respuesta se cerró antes del envío.');
      if (!await guardar({ estado: 'ENVIANDO' }, true)) return;
      enviando = true;
      const metaId = await transport.enviar(e, texto, config(e.canal));
      await guardar({ estado: 'ENVIADO', metaId, error: null }, false, t.autor === 'ADMIN' ? { rol: 'asistente', texto } : null);
      await db.socialConversacion.updateMany({ where: { id: c.id, queueLease: lock.lease }, data: { ultimoMensajeAt: ahora() } });
    } catch (error) {
      const intentos = t.intentos + 1;
      // Solo los rechazos explícitos de Meta se pueden repetir tras iniciar el envío.
      const incierto = enviando && error.ambiguo !== false;
      const reintentar = !incierto && !error.permanente && intentos < 4;
      if (reintentar) {
        await guardar({
          estado: enviando ? 'LISTO' : 'PENDIENTE', proximoAt: new Date(ahora().getTime() + 30000 * (2 ** (intentos - 1))),
          error: 'Servicio temporalmente no disponible; reintento programado.',
        });
      } else {
        const terminado = await finalizar(t, incierto ? 'INCIERTO' : 'ERROR', incierto ? 'Meta puede haber enviado el mensaje. Revisa la conversación antes de responder.' : 'No se pudo procesar. Revisa configuración y atiende la conversación.');
        if (terminado) await db.socialConversacion.updateMany({ where: { id: t.conversacionId, queueLease: lock.lease }, data: { humano: true, revision: { increment: 1 } } });
      }
    } finally {
      await db.socialConversacion.updateMany({ where: { id: t.conversacionId, queueLease: lock.lease }, data: { queueLease: null, queueUntil: null } });
    }
  }

  let ocupado = false;
  async function pasar() {
    if (ocupado) return;
    ocupado = true;
    try {
      await recuperar();
      const trabajos = await db.socialTrabajo.findMany({ where: { estado: { in: ['PENDIENTE', 'LISTO'] }, proximoAt: { lte: ahora() } }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 20 });
      for (const t of trabajos) {
        const lock = await reclamar(t);
        if (lock) await procesar(t, lock);
      }
    } finally { ocupado = false; }
  }
  return { recibir, pasar, recuperar, procesar, reclamar };
}
module.exports = { crearWorker, ventana, TERMINADOS, limitarTexto };
