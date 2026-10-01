'use strict';

const env = require('../../config/env');
const logger = require('../../config/logger');
const { ConflictError, NotFoundError } = require('../../shared/errors/AppError');
const { generarConRespaldo, GeminiError } = require('../../lib/gemini');
const { avisarAlAdmin } = require('../../lib/notify');
const asistenteService = require('../asistente/asistente.service');
const { crearTopeDiario } = require('../asistente/asistente.tope');
const repo = require('./whatsapp.repository');
const meta = require('./whatsapp.meta');
const { construirSistemaWhatsapp, aTextoDeWhatsapp } = require('./whatsapp.prompt');
const { enHorarioHumano, pidePersona, ventanaAbierta } = require('./whatsapp.reglas');

/**
 * El bot de WhatsApp: lo que pasa con cada mensaje que llega.
 *
 *   llega → se guarda → ¿bloqueado? ¿lo lleva una persona? ¿bot apagado?
 *   ¿horario humano? ¿pide una persona? → Gemini con su historial → se manda
 *
 * En cualquiera de las paradas el mensaje queda guardado y, si hace falta que
 * alguien lo mire, llega un aviso al móvil (ntfy). Nada se pierde por callar.
 *
 * SOLO GEMINI Y CON SU CLAVE. No usa la carrera del chat de la web (Groq,
 * NVIDIA, OVH) ni la clave de la casa: ver `WHATSAPP_GEMINI_API_KEY`.
 */

/** Mensajes de la conversación que ve el modelo. Más es más caro y no mejora. */
const HISTORIAL = 20;

const tope = crearTopeDiario(env.WHATSAPP_MAX_DIARIO);

const RESPUESTAS = {
  soloTexto:
    'Por ahora solo puedo leer mensajes de texto 🙏 ¿Me lo escribes? Si prefieres, una persona del equipo te responderá por aquí.',
  aPersona: 'Listo, le paso tu consulta a una persona del equipo. Te escribirá por aquí mismo.',
  bloqueada:
    'Esa consulta no la puedo responder por aquí. Si es sobre tu tesis, tu artículo o lo que ofrecemos, cuéntamela de otra forma.',
  sinRespuesta:
    'Ahora mismo no puedo responderte, pero ya le avisé a una persona del equipo y te escribirá por aquí.',
};

/**
 * Un número a la vez. Si alguien manda tres mensajes seguidos, el segundo
 * espera a que el primero tenga respuesta: si no, el bot contestaría tres veces
 * en paralelo sin ver lo que acaba de decir.
 */
const filas = new Map();
function enFila(clave, tarea) {
  const anterior = filas.get(clave) ?? Promise.resolve();
  const actual = anterior.catch(() => {}).then(tarea);
  filas.set(clave, actual);
  actual.finally(() => {
    if (filas.get(clave) === actual) filas.delete(clave);
  });
  return actual;
}

/**
 * Aviso al móvil. El tópico de ntfy lo puede leer quien acierte su nombre, así
 * que no va el número entero ni lo que escribió: nombre de pila y los tres
 * últimos dígitos, lo justo para reconocerlo en el panel.
 */
function avisar(conversacion, motivo) {
  const pila = (conversacion.nombre || 'Alguien').split(/\s+/)[0].slice(0, 20);
  avisarAlAdmin({
    titulo: 'WhatsApp · lo tiene que ver una persona',
    mensaje: `${pila} (…${conversacion.telefono.slice(-3)}): ${motivo}. Míralo en el panel → WhatsApp.`,
    etiquetas: ['speech_balloon'],
    prioridad: 4,
  });
}

/** Lo que se le dice al cliente desde aquí, mandado y guardado. */
async function decir(conversacion, texto, { autor = 'BOT', modelo = null, adminId = null, simulado = false }) {
  const resultado = simulado ? { simulado: true } : await meta.enviarTexto(conversacion.telefono, texto);
  const envio = resultado.simulado ? 'SIMULADO' : resultado.error ? 'FALLIDO' : 'ENVIADO';

  const mensaje = await repo.guardarMensaje({
    conversacionId: conversacion.id,
    autor,
    texto: meta.recortar(texto),
    envio,
    waId: resultado.waId ?? null,
    error: resultado.error ?? null,
    modelo,
    adminId,
  });
  await repo.actualizar(conversacion.id, { ultimoMensajeAt: new Date() });
  if (resultado.error) logger.warn({ error: resultado.error }, 'WhatsApp: el mensaje no salió');
  return mensaje;
}

/**
 * La historia para Gemini. Lo del bot y lo del panel son «asistente»: para el
 * cliente, las dos cosas las dijo la misma casa. Los turnos seguidos del mismo
 * lado se juntan en uno, que es como los espera Gemini.
 */
function comoConversacion(mensajes) {
  const turnos = [];
  for (const m of mensajes) {
    const rol = m.autor === 'CLIENTE' ? 'usuario' : 'asistente';
    const previo = turnos[turnos.length - 1];
    if (previo && previo.rol === rol) previo.texto += `\n${m.texto}`;
    else turnos.push({ rol, texto: m.texto });
  }
  // Gemini quiere que empiece el usuario: la bienvenida, si la hubo, se cae.
  while (turnos.length && turnos[0].rol !== 'usuario') turnos.shift();
  return turnos;
}

/** Los modelos del bot: el suyo y su respaldo, los dos de Gemini. */
const modelosDelBot = () =>
  [...new Set([env.WHATSAPP_GEMINI_MODEL, env.WHATSAPP_GEMINI_MODEL_RESPALDO].filter(Boolean))];

async function pensarRespuesta(conversacion, ajustes, primeraVez) {
  const { planes, promos } = await asistenteService.preciosVigentes();
  const sistema = construirSistemaWhatsapp({
    planes,
    promos,
    appUrl: env.APP_URL,
    instrucciones: ajustes.instrucciones,
    nombre: conversacion.nombre,
    primeraVez,
  });
  const mensajes = comoConversacion(await repo.historial(conversacion.id, HISTORIAL));

  const { texto, modelo, uso } = await generarConRespaldo({
    modelos: modelosDelBot(),
    sistema,
    mensajes,
    clave: env.WHATSAPP_GEMINI_API_KEY,
    maxTokens: 700,
    ventajaMs: 6_000,
  });
  logger.info(
    { modelo, entrada: uso?.promptTokenCount, salida: uso?.candidatesTokenCount, hoy: tope.usados() },
    'WhatsApp: respuesta del bot',
  );
  return { ...aTextoDeWhatsapp(texto, env.APP_URL), modelo };
}

/**
 * Un mensaje de un cliente, de principio a fin. Devuelve por qué se paró (o
 * `respondido`) y lo que se le dijo, que es lo que enseña «Probar el bot».
 */
async function atender(entrante, { simulado = false } = {}) {
  const { waId = null, telefono, nombre = '', tipo = 'text', texto = '' } = entrante;

  if (await repo.yaVisto(waId)) return { motivo: 'repetido', respuestas: [] };

  let conversacion = await repo.anotarDelCliente(telefono, nombre);
  const contenido = texto || `(mandó un mensaje de tipo «${tipo}» que el bot no lee)`;
  try {
    await repo.guardarMensaje({
      conversacionId: conversacion.id,
      autor: 'CLIENTE',
      texto: meta.recortar(contenido),
      envio: 'RECIBIDO',
      waId,
    });
  } catch (error) {
    // Dos avisos iguales de Meta a la vez: el segundo choca con el índice único.
    if (error?.code === 'P2002') return { motivo: 'repetido', respuestas: [] };
    throw error;
  }

  const respuestas = [];
  const responder = async (dicho, opciones = {}) => {
    const mensaje = await decir(conversacion, dicho, { ...opciones, simulado });
    respuestas.push(mensaje);
  };
  // El primer mensaje sin leer es el que avisa; los siguientes ya los verá.
  const esElPrimeroSinLeer = conversacion.noLeidos <= 1;

  if (conversacion.bloqueado) return { motivo: 'bloqueado', respuestas };

  if (!simulado) meta.marcarLeido(waId);
  const ajustes = await repo.ajustes();

  if (conversacion.modo === 'HUMANO') {
    if (esElPrimeroSinLeer) avisar(conversacion, 'escribió en una conversación que llevas tú');
    return { motivo: 'persona', respuestas };
  }
  if (!ajustes.activo) {
    if (esElPrimeroSinLeer) avisar(conversacion, 'escribió y el bot está apagado');
    return { motivo: 'apagado', respuestas };
  }
  if (enHorarioHumano(ajustes)) {
    if (esElPrimeroSinLeer) avisar(conversacion, 'escribió en horario de atención');
    return { motivo: 'horario', respuestas };
  }

  if (!texto) {
    await responder(RESPUESTAS.soloTexto);
    return { motivo: 'no_es_texto', respuestas };
  }

  if (pidePersona(texto, ajustes.palabrasHumano)) {
    conversacion = await repo.actualizar(conversacion.id, { modo: 'HUMANO', pideHumano: true });
    await responder(RESPUESTAS.aPersona);
    avisar(conversacion, 'pidió hablar con una persona');
    return { motivo: 'pidio_persona', respuestas };
  }

  if (!env.whatsappIaEnabled) {
    if (esElPrimeroSinLeer) avisar(conversacion, 'escribió y el bot no tiene clave de Gemini');
    return { motivo: 'sin_ia', respuestas };
  }

  if (!tope.intentar()) {
    logger.warn({ tope: env.WHATSAPP_MAX_DIARIO }, 'WhatsApp: tope diario alcanzado');
    if (!conversacion.pideHumano) {
      conversacion = await repo.actualizar(conversacion.id, { pideHumano: true });
      avisar(conversacion, 'el bot llegó a su tope del día');
    }
    return { motivo: 'tope', respuestas };
  }

  const primeraVez = (await repo.cuantosMensajes(conversacion.id)) === 1;
  if (primeraVez && ajustes.bienvenida.trim()) await responder(ajustes.bienvenida.trim());

  try {
    const { texto: dicho, pidePersona: quierePersona, modelo } = await pensarRespuesta(
      conversacion,
      ajustes,
      primeraVez,
    );
    // Gemini tarda unos segundos: si en ese rato alguien contestó desde el
    // celular o el panel, lo pensado se tira para no hablarle encima.
    const ahora = await repo.porId(conversacion.id);
    if (ahora?.modo === 'HUMANO') return { motivo: 'persona', respuestas };
    if (dicho) await responder(dicho, { modelo });
    if (quierePersona && !conversacion.pideHumano) {
      conversacion = await repo.actualizar(conversacion.id, { pideHumano: true });
      avisar(conversacion, 'el bot pidió que lo atienda una persona');
    }
    return { motivo: quierePersona ? 'bot_pide_persona' : 'respondido', respuestas };
  } catch (error) {
    if (error instanceof GeminiError && error.bloqueado) {
      await responder(RESPUESTAS.bloqueada);
      return { motivo: 'bloqueado_por_gemini', respuestas };
    }
    logger.error({ err: error }, 'WhatsApp: Gemini no contestó');
    conversacion = await repo.actualizar(conversacion.id, { pideHumano: true });
    await responder(RESPUESTAS.sinRespuesta);
    avisar(conversacion, 'el bot no pudo responder');
    return { motivo: 'error_ia', respuestas };
  }
}

/**
 * Lo que el equipo contestó desde el celular (coexistencia): se guarda como
 * respuesta del equipo y el bot se calla en esa conversación, igual que al
 * contestar desde el panel. No va a la fila del número a propósito: así, si el
 * bot está pensando una respuesta para ese cliente, ve el cambio y no la manda.
 */
async function registrarEco(eco) {
  // Lo que mandó el bot o el panel por la API ya está guardado con su waId.
  if (await repo.yaVisto(eco.waId)) return { motivo: 'repetido' };

  const conversacion = await repo.anotarDelEquipo(eco.telefono);
  const texto = eco.texto || `(mandaste un mensaje de tipo «${eco.tipo}» desde el celular)`;
  try {
    await repo.guardarMensaje({
      conversacionId: conversacion.id,
      autor: 'ADMIN',
      texto: meta.recortar(texto),
      envio: 'ENVIADO',
      waId: eco.waId,
    });
  } catch (error) {
    if (error?.code === 'P2002') return { motivo: 'repetido' };
    throw error;
  }
  return { motivo: 'persona' };
}

/** Las claves de Meta que faltan, por su nombre en el .env. */
function clavesQueFaltan() {
  return [
    ['WHATSAPP_TOKEN', env.WHATSAPP_TOKEN],
    ['WHATSAPP_PHONE_NUMBER_ID', env.WHATSAPP_PHONE_NUMBER_ID],
    ['WHATSAPP_APP_SECRET', env.WHATSAPP_APP_SECRET],
    ['WHATSAPP_VERIFY_TOKEN', env.WHATSAPP_VERIFY_TOKEN],
  ]
    .filter(([, valor]) => !valor)
    .map(([nombre]) => nombre);
}

/** Medianoche de hoy en Lima (UTC−5, sin horario de verano). */
function inicioDelDiaEnLima(ahora = new Date()) {
  const dia = ahora.toLocaleDateString('en-CA', { timeZone: 'America/Lima' });
  return new Date(`${dia}T00:00:00-05:00`);
}

const whatsappService = {
  // ── Lo que manda Meta ────────────────────────────────────────────────────

  /**
   * Cada mensaje de un aviso, en la fila de su número, y cada respuesta que el
   * equipo dio desde el celular. Nunca lanza.
   */
  recibirAviso(cuerpo) {
    for (const eco of meta.extraerEcos(cuerpo)) {
      registrarEco(eco).catch((error) =>
        logger.error({ err: error }, 'WhatsApp: no se pudo anotar lo que se contestó desde el celular'),
      );
    }
    for (const entrante of meta.extraerMensajes(cuerpo)) {
      enFila(entrante.telefono, () => atender(entrante)).catch((error) =>
        logger.error({ err: error }, 'WhatsApp: no se pudo atender un mensaje'),
      );
    }
  },

  // ── El panel ─────────────────────────────────────────────────────────────

  async estado() {
    return {
      ia: env.whatsappIaEnabled,
      meta: env.whatsappMetaEnabled,
      faltan: clavesQueFaltan(),
      webhookUrl: `${env.apiPublicUrl}${env.API_PREFIX}/whatsapp/webhook`,
      modelos: modelosDelBot(),
      maxDiario: env.WHATSAPP_MAX_DIARIO,
      usadosHoy: tope.usados(),
      retencionDias: env.WHATSAPP_RETENCION_DIAS,
      cifras: await repo.cifras(inicioDelDiaEnLima()),
    };
  },

  ajustes: () => repo.ajustes(),
  guardarAjustes: (datos) => repo.guardarAjustes(datos),

  listar: (consulta) => repo.listar(consulta),

  /** Una conversación con sus mensajes. Abrirla la da por leída. */
  async abrir(id) {
    const conversacion = await repo.porId(id);
    if (!conversacion) throw new NotFoundError('Esa conversación ya no existe.');
    const mensajes = await repo.historial(id, 200);
    const leida = conversacion.noLeidos ? await repo.actualizar(id, { noLeidos: 0 }) : conversacion;
    return {
      ...leida,
      ventanaAbierta: ventanaAbierta(leida.ultimoDelClienteAt),
      mensajes,
    };
  },

  /**
   * Contestar desde el panel. Quien contesta toma la conversación: el bot se
   * calla en ella hasta que se le devuelva, o hablarían los dos a la vez.
   */
  async responder(id, texto, adminId) {
    const conversacion = await repo.porId(id);
    if (!conversacion) throw new NotFoundError('Esa conversación ya no existe.');
    const esPrueba = !/^\d+$/.test(conversacion.telefono);
    if (!esPrueba && env.whatsappMetaEnabled && !ventanaAbierta(conversacion.ultimoDelClienteAt)) {
      throw new ConflictError(
        'Pasaron más de 24 horas desde su último mensaje: WhatsApp solo deja escribirle con una plantilla aprobada.',
      );
    }
    await repo.actualizar(id, { modo: 'HUMANO', pideHumano: false, noLeidos: 0 });
    const mensaje = await decir(conversacion, texto, { autor: 'ADMIN', adminId, simulado: esPrueba });
    if (mensaje.envio === 'FALLIDO') throw new ConflictError(`No salió: ${mensaje.error}`);
    return mensaje;
  },

  /** Tomarla (HUMANO) o devolvérsela al bot (BOT). Devolverla apaga el aviso. */
  cambiarModo(id, modo) {
    return repo.actualizar(id, { modo, ...(modo === 'BOT' ? { pideHumano: false } : {}) });
  },

  bloquear: (id, bloqueado) => repo.actualizar(id, { bloqueado }),

  async borrar(id) {
    if (!(await repo.porId(id))) throw new NotFoundError('Esa conversación ya no existe.');
    await repo.borrarConversacion(id);
  },

  /**
   * «Probar el bot»: el mismo camino que un mensaje de verdad, pero con un
   * número de prueba y sin mandar nada a WhatsApp aunque estén las claves.
   * Los números de prueba llevan letras, así que nunca chocan con uno real.
   */
  simular({ conversacion = 'prueba', nombre = 'Prueba del panel', texto }) {
    const telefono = `prueba-${conversacion}`.slice(0, 20);
    return enFila(telefono, () => atender({ telefono, nombre, tipo: 'text', texto }, { simulado: true }));
  },

  /** Borra lo que pasó el plazo de retención. Lo llama el servidor una vez al día. */
  async purgar(ahora = Date.now()) {
    const antesDe = new Date(ahora - env.WHATSAPP_RETENCION_DIAS * 24 * 60 * 60 * 1000);
    const borrados = await repo.purgar(antesDe);
    if (borrados.mensajes || borrados.conversaciones) {
      logger.info(borrados, 'WhatsApp: borradas las conversaciones fuera de plazo');
    }
    return borrados;
  },
};

module.exports = whatsappService;
module.exports._interno = { comoConversacion, atender, registrarEco, RESPUESTAS };
