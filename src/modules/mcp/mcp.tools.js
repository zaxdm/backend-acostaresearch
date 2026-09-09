'use strict';

const { McpServer, fromJsonSchema } = require('@modelcontextprotocol/server');
const env = require('../../config/env');
const logger = require('../../config/logger');
const skillService = require('../skills/skill.service');
const skillRunner = require('../skills/skill.runner');
const skillDelivery = require('../skills/skill.delivery');
const licenseService = require('../licensing/license.service');
const { analizarIntencion, RESPUESTA_RECHAZO } = require('../licensing/license.guard');
const prisma = require('../../lib/prisma');
const referenceService = require('../references/reference.service');

/**
 * Los esquemas de las herramientas van en JSON Schema, no en Zod.
 *
 * El SDK de MCP necesita convertirlos a JSON Schema para responder a
 * `tools/list`, y solo sabe hacerlo desde Zod 4.2 en adelante. El resto del
 * backend valida con Zod 3 y actualizarlo entero por tres esquemas sería
 * cambiar código que ya funciona; `fromJsonSchema` deja el problema aquí
 * encerrado.
 */
const SIN_ARGUMENTOS = fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false });

const ESQUEMA_FUENTES = fromJsonSchema({
  type: 'object',
  properties: {
    tema: {
      type: 'string',
      minLength: 3,
      description:
        'Sobre qué buscar, EN INGLÉS y en palabras del contenido, no una pregunta entera: ' +
        '«construct validity», «convenience sampling», «Cronbach alpha». ' +
        'Tradúcelo tú: el tesista escribe en español y la biblioteca está en inglés.',
    },
    cuantas: {
      type: 'integer',
      minimum: 1,
      maximum: 15,
      description: 'Cuántas fuentes quieres. Por omisión, seis.',
    },
  },
  required: ['tema'],
  additionalProperties: false,
});

const ESQUEMA_REDACTAR = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description: 'Clave del capítulo, tal como aparece en listar_capitulos.',
    },
    mensaje: {
      type: 'string',
      minLength: 1,
      description: 'Lo que el tesista quiere hacer, o su respuesta al paso anterior.',
    },
    paso: {
      type: 'integer',
      minimum: 1,
      description:
        'Solo en los capítulos que se entregan como método: número del tramo que quieres. ' +
        'Si lo omites, se sirve el siguiente al último que recibiste.',
    },
    referencia: {
      type: 'string',
      description:
        'Solo en los capítulos que se entregan como método: nombre del material de apoyo ' +
        'que quieres, tal como aparece en el listado del capítulo.',
    },
    sesion: {
      type: 'string',
      description:
        'Identificador de esta conversación, elegido por ti: invéntalo la primera vez ' +
        'y repite el mismo en todas las llamadas del mismo hilo, para no empezar de cero. ' +
        'Usa uno distinto para cada conversación nueva.',
    },
  },
  required: ['capitulo', 'mensaje'],
  additionalProperties: false,
});

const NOMBRE_SERVIDOR = 'acosta-research-tesis';
const VERSION_SERVIDOR = '1.0.0';

/**
 * Hilo de entrega de una licencia. Guarda por qué tramo va, de modo que el
 * asistente pueda pedir «el siguiente» sin llevar él la cuenta.
 */
async function sesionDeEntrega(licenseId, clientKey, skillCode) {
  const clave = clientKey || 'principal';
  const existente = await prisma.mcpSession.findUnique({
    where: { licenseId_clientKey: { licenseId, clientKey: clave } },
  });

  // Cambiar de capítulo reinicia la cuenta: los tramos son de cada uno.
  if (existente && existente.skillCode === skillCode) return existente;

  if (existente) {
    return prisma.mcpSession.update({
      where: { id: existente.id },
      data: { skillCode, lastSection: 0 },
    });
  }

  return prisma.mcpSession.create({
    data: { licenseId, clientKey: clave, skillCode, messages: '[]', lastSection: 0 },
  });
}

function guardarTramo(sessionId, skillCode, numero) {
  return prisma.mcpSession.update({
    where: { id: sessionId },
    data: { skillCode, lastSection: numero, turns: { increment: 1 } },
  });
}

/** Respuesta de texto plano, que es lo que el cliente sabe mostrar siempre. */
function texto(contenido) {
  return { content: [{ type: 'text', text: contenido }] };
}

/**
 * Construye el servidor MCP para UNA licencia concreta.
 *
 * Se crea uno por petición y muere con ella: así la licencia queda cerrada
 * dentro de las herramientas y no hay forma de que una petición acabe
 * respondiendo con los datos de otro comprador.
 */
function construirServidor(licencia) {
  const server = new McpServer({ name: NOMBRE_SERVIDOR, version: VERSION_SERVIDOR });

  // ── Catálogo ─────────────────────────────────────────────────────────────
  server.registerTool(
    'listar_capitulos',
    {
      title: 'Capítulos disponibles',
      description:
        'Lista los capítulos de tesis que este método puede trabajar, en su orden. ' +
        'Úsala primero para saber en qué punto está el tesista y qué le toca.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      // Solo los capítulos del grupo que esta licencia compró. Sin el filtro,
      // quien pagara el humanizador vería también el método de tesis.
      const skills = await skillService.listCatalog(licencia.productCode);
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'listar_capitulos' });

      if (skills.length === 0) {
        return texto('Todavía no hay capítulos publicados. Escribe a Acosta | IA & Research.');
      }

      // Una licencia de entrega no necesita que la skill esté subida a la
      // Skills API: el método sale del bundle que ya está en este servidor.
      // Sin esto, el catálogo diría «pendiente de publicar» mientras `redactar`
      // funciona, que es la peor combinación posible.
      const entregaDirecta = licencia.delivery === 'INSTRUCTIONS';
      const disponible = (s) => entregaDirecta || Boolean(s.anthropicSkillId);
      const publicados = skills.filter(disponible);

      const lineas = skills.map((s) => {
        // El motivo tiene que ser inequívoco: sin él, el asistente se inventa
        // una explicación —«será que no has definido el tema»— y el tesista se
        // queda pensando que el fallo es suyo.
        const pendiente = disponible(s)
          ? ''
          : env.skillsSimuladas
            ? '  [MODO DE PRUEBA]'
            : '  [pendiente de publicar por Acosta]';
        return `${s.displayName}${pendiente}\n    clave: ${s.code}\n    ${s.summary}`;
      });

      // En modo de prueba se avisa por delante: el asistente tiene que decirlo,
      // porque el texto que va a recibir el usuario NO sirve para su tesis y no
      // debe confundirse con el producto.
      const aviso = env.skillsSimuladas && !entregaDirecta
        ? '\n\nESTE SERVIDOR ESTÁ EN MODO DE PRUEBA. Los capítulos responden, pero con ' +
          'texto de ejemplo, no con el método real. Adviértelo antes de trabajar nada.'
        : publicados.length === 0
          ? '\n\nNINGÚN capítulo está publicado todavía. No es nada que haya hecho ' +
            'el usuario ni le falte configurar: es que Acosta | IA & Research aún no los ' +
            'ha activado en el servidor. No sugieras soluciones al usuario ni le pidas datos.'
          : '';

      return texto(
        `Método de tesis — Acosta | IA & Research\n\n${lineas.join('\n\n')}${aviso}\n\n` +
          'Para trabajar un capítulo usa la herramienta "redactar" con la clave correspondiente.',
      );
    },
  );

  // ── Estado de la licencia ────────────────────────────────────────────────
  server.registerTool(
    'estado_licencia',
    {
      title: 'Estado de la licencia',
      description: 'Muestra a nombre de quién está esta licencia y cuánto se ha usado.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'estado_licencia' });

      const uso = await licenseService.usageSummary(licencia);
      const caduca = licencia.expiresAt
        ? `Caduca el ${licencia.expiresAt.toISOString().slice(0, 10)}.`
        : 'Sin fecha de caducidad.';

      // El cupo solo se menciona si existe: decirle «0 de 0» a quien no tiene
      // tope no informa de nada y preocupa.
      const cupo = [];
      if (uso.limits.callsPerDay > 0) {
        cupo.push(`Hoy llevas ${uso.callsToday} de ${uso.limits.callsPerDay} consultas.`);
      }
      if (uso.limits.callsPerMonth > 0) {
        cupo.push(`Este mes llevas ${uso.callsMonth} de ${uso.limits.callsPerMonth}.`);
      }

      return texto(
        `Licencia activa a nombre de ${licencia.user.firstName} (${licencia.user.email}).\n` +
          `Producto: ${licencia.productCode}\n` +
          `Consultas realizadas en total: ${licencia.callsTotal}\n` +
          (cupo.length > 0 ? `${cupo.join('\n')}\n` : '') +
          `${caduca}\n\n` +
          'Esta licencia es individual. Compartir la URL del conector puede provocar su revocación.',
      );
    },
  );

  // ── Redacción de un capítulo ─────────────────────────────────────────────
  server.registerTool(
    'redactar',
    {
      title: 'Trabajar un capítulo',
      description:
        'Trabaja un capítulo de la tesis con el método de Acosta | IA & Research. ' +
        'Envía lo que el tesista quiere hacer o responder, y devuelve el siguiente paso. ' +
        'Es una conversación: manda el mismo "sesion" en cada llamada del mismo hilo.',
      inputSchema: ESQUEMA_REDACTAR,
    },
    async ({ capitulo, mensaje, sesion, referencia, paso }) => {
      const inicio = Date.now();

      // ── 1. Filtro de intención ───────────────────────────────────────────
      // Va lo primero: un intento de extracción no debe llegar a gastar cupo
      // ni a tocar la base de datos del catálogo.
      const intencion = analizarIntencion(mensaje);
      if (intencion.sospechoso) {
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `redactar:${capitulo}`,
          prompt: mensaje,
          sessionId: sesion,
          ok: false,
          kind: 'EXTRACTION_ATTEMPT',
          durationMs: Date.now() - inicio,
        });
        logger.warn(
          { licenseId: licencia.id, patrones: intencion.patrones },
          'Intento de extracción bloqueado',
        );
        return texto(RESPUESTA_RECHAZO);
      }

      const skill = await skillService.findByCode(capitulo);

      // Un capítulo de otro grupo se trata como inexistente, no como prohibido.
      // Que no salga en la lista no impide pedirlo por su clave, y la clave no
      // es ningún secreto; decir «no tienes acceso a ese» sería confirmarle a
      // quien va probando que ahí hay algo que comprar.
      const suyo = skill && skillService.perteneceAlGrupo(skill, licencia.productCode);

      if (!skill || !skill.active || !suyo) {
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: 'redactar',
          ok: false,
          durationMs: Date.now() - inicio,
        });
        return texto(
          `No existe ningún capítulo con la clave "${capitulo}". ` +
            'Usa listar_capitulos para ver las claves válidas.',
        );
      }

      /**
       * Registro que NO descuenta cupo.
       *
       * Todas las llamadas se anotan —el detector necesita verlas todas—, pero
       * solo descuenta la que de verdad hace el trabajo. Si el fallo es nuestro
       * (servicio apagado, capítulo sin publicar), sería cobrarle al comprador
       * por nada: gastaría su cuota del día sin recibir una sola línea.
       */
      const anotarSinCobrar = (motivo) =>
        licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `redactar:${skill.code}`,
          prompt: mensaje,
          sessionId: sesion,
          ok: false,
          kind: motivo,
          durationMs: Date.now() - inicio,
        });

      // ── 2. Licencias de entrega: el método viaja, no se ejecuta ──────────
      //
      // No llama a ningún modelo, así que no cuesta nada y no hay coste que
      // descontar. Sí cuenta para el tope diario, que aquí solo hace de freno
      // ante una descarga masiva.
      if (licencia.delivery === 'INSTRUCTIONS') {
        const cupoEntrega = await licenseService.checkLimits(licencia);
        if (!cupoEntrega.permitido) {
          await anotarSinCobrar('BLOCKED_LIMIT');
          return texto(cupoEntrega.motivo);
        }

        // El servidor recuerda por dónde va, para poder servir el tramo
        // siguiente aunque el asistente no lleve la cuenta.
        const hilo = await sesionDeEntrega(licencia.id, sesion, skill.code);

        let contenido;
        try {
          contenido = referencia
            ? skillDelivery.entregarReferencia({ skill, licencia, nombre: referencia })
            : skillDelivery.entregar({
                skill,
                licencia,
                paso,
                ultimoEntregado: hilo.lastSection,
              });

          if (!referencia) {
            await guardarTramo(hilo.id, skill.code, contenido.numero);
          }
        } catch (error) {
          await anotarSinCobrar('NORMAL');
          logger.error(
            { err: error, licenseId: licencia.id, skill: skill.code },
            'No se pudo entregar el método',
          );
          return texto(
            'No pudimos recuperar ese capítulo ahora mismo. No se te ha descontado nada.',
          );
        }

        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `entregar:${skill.code}`,
          prompt: mensaje,
          sessionId: sesion,
          durationMs: Date.now() - inicio,
          // Entregar no consume tokens nuestros: el coste va a cero y solo
          // cuenta como consulta.
          costCents: 0,
          cuentaParaElTope: true,
        });

        return texto(contenido.texto);
      }

      // ── 3. ¿Podemos atenderle siquiera? ──────────────────────────────────
      // Va antes del cupo a propósito: a quien pide un capítulo que aún no
      // existe hay que decírselo, no anunciarle que se quedó sin consultas.
      if (!env.rewriteEnabled) {
        logger.warn('Se pidió redactar sin ANTHROPIC_API_KEY configurada');
        await anotarSinCobrar('NORMAL');
        return texto(
          'La redacción todavía no está activada en el servidor de Acosta | IA & Research. ' +
            'No es un problema del usuario ni de su licencia, y no se arregla reintentando. ' +
            'Comunícaselo tal cual, sin sugerirle pasos ni pedirle datos.',
        );
      }

      if (!skill.anthropicSkillId && !env.skillsSimuladas) {
        await anotarSinCobrar('NORMAL');
        return texto(
          `El capítulo "${skill.displayName}" todavía no está publicado en el servidor de ` +
            'Acosta | IA & Research. No es un fallo del usuario ni le falta configurar nada, ' +
            'y no hay nada que pueda hacer para arreglarlo. Dilo así, sin proponerle soluciones.',
        );
      }

      // ── 4. Topes del plan ────────────────────────────────────────────────
      // Se comprueba ANTES de gastar tokens, que es lo que cuesta dinero.
      const cupo = await licenseService.checkLimits(licencia);
      if (!cupo.permitido) {
        await anotarSinCobrar('BLOCKED_LIMIT');
        return texto(cupo.motivo);
      }

      // ── 5. El trabajo ────────────────────────────────────────────────────
      // La skill se ejecuta AQUÍ, con nuestra clave y contra la Skills API. Sus
      // instrucciones no pasan por el Claude del comprador en ningún momento:
      // de vuelta solo sale el texto redactado.
      let resultado;
      try {
        resultado = await skillRunner.ejecutar({
          licenseId: licencia.id,
          skill,
          mensaje,
          clientKey: sesion,
        });
      } catch (error) {
        // El fallo no lo paga el comprador: se anota, no se le descuenta.
        await anotarSinCobrar('NORMAL');
        logger.error(
          { err: error, licenseId: licencia.id, skill: skill.code },
          'Falló la ejecución de la skill',
        );

        if (error.codigo === 'REWRITE_REFUSED') {
          return texto(
            'No puedo atender esa petición tal como está planteada. ' +
              'Reformúlala centrándote en tu propio trabajo de tesis.',
          );
        }

        return texto(
          'Hubo un problema al trabajar el capítulo y no se te ha descontado la consulta. ' +
            'Vuelve a intentarlo en un momento.',
        );
      }

      // Salió bien: ahora sí se descuenta, con el coste real.
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: `redactar:${skill.code}`,
        prompt: mensaje,
        sessionId: sesion,
        durationMs: resultado.durationMs,
        inputTokens: resultado.inputTokens,
        outputTokens: resultado.outputTokens,
        cachedTokens: resultado.cachedTokens,
        costCents: resultado.costCents,
        cuentaParaElTope: true,
      });

      return texto(resultado.texto);
    },
  );

  // ── Corpus bibliográfico ─────────────────────────────────────────────────
  // Solo existe si hay corpus configurado. Una herramienta anunciada que
  // responde «no hay nada» en cada llamada es peor que no tenerla: el
  // asistente la sigue intentando y el tesista cree que le falta algo por
  // activar.
  if (env.zoteroEnabled) {
    server.registerTool(
      'buscar_fuentes',
      {
        title: 'Buscar fuentes en la biblioteca',
        description:
          'Busca referencias reales y verificadas en la biblioteca de Acosta | IA & Research. ' +
          'ÚSALA SIEMPRE que haga falta citar: antecedentes, marco teórico, metodología o ' +
          'discusión. NO cites de memoria: los datos bibliográficos que no salen de aquí ' +
          'suelen tener el año o el DOI equivocados, y eso lo comprueba un jurado en segundos. ' +
          'BUSCA EN INGLÉS: la biblioteca son artículos indexados en Scopus y Web of Science, ' +
          'y sus títulos y resúmenes están en inglés. El tesista te escribe en español, así que ' +
          'traduce tú el tema antes de buscar («validez de constructo» → «construct validity»). ' +
          'Si en inglés no sale nada, prueba con sinónimos antes de darlo por perdido.',
        inputSchema: ESQUEMA_FUENTES,
      },
      async ({ tema, cuantas }) => {
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: 'buscar_fuentes',
          prompt: tema,
        });

        // Mismo filtro que el catálogo de capítulos: cada licencia ve lo suyo.
        // Las fuentes sin producto —la metodología— las ve todo el mundo.
        const fuentes = await referenceService.buscarParaLicencia({
          tema,
          cuantas,
          productCode: licencia.productCode,
          // Las que subió este tesista de su export de Scopus, además del fondo
          // de la casa. Las de otros compradores NO: el filtro va dentro de la
          // consulta, y este es el único sitio desde donde se le pasa un dueño.
          ownerUserId: licencia.userId,
        });

        if (fuentes.length === 0) {
          return texto(
            `No hay ninguna fuente sobre «${tema}» en la biblioteca.\n\n` +
              'Antes de rendirte: ¿lo buscaste EN INGLÉS? La biblioteca son artículos de ' +
              'Scopus y Web of Science. Prueba una vez más con el tema traducido, o con ' +
              'sinónimos del término.\n\n' +
              'Si aun así no hay nada, DÍSELO AL TESISTA TAL CUAL y sigue sin citar ahí. Y ' +
              'dile esto, que es lo que de verdad lo resuelve: puede subir SU PROPIO export ' +
              'de Scopus, Web of Science o SciELO desde su perfil, en «Método de tesis → Mis ' +
              'fuentes», y desde ese momento estas búsquedas también leen de ahí. Es la vía ' +
              'para los temas que la biblioteca de la casa no cubre.\n\n' +
              'NO rellenes el hueco con referencias de memoria: es donde se cuelan los datos ' +
              'inventados.',
          );
        }

        const fichas = fuentes.map((f, i) => {
          const lineas = [`${i + 1}. ${f.cita}`];
          // La nota vale más que el resumen: el resumen lo escribió la revista
          // para vender su artículo; la nota la escribió Acosta diciendo para
          // qué sirve la fuente.
          if (f.nota) lineas.push(`   Nota de Acosta: ${f.nota.slice(0, 400)}`);
          else if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
          // De dónde salió. Va en cada ficha y no en un encabezado porque las
          // dos procedencias se mezclan en la misma lista, y el tesista tiene
          // derecho a distinguir las que eligió él de las que le pusimos.
          lineas.push(f.propia ? '   [de tu biblioteca]' : '   [biblioteca de Acosta · curada]');
          return lineas.join('\n');
        });

        return texto(
          `Fuentes de la biblioteca sobre «${tema}»:\n\n${fichas.join('\n\n')}\n\n` +
            'Cita EXACTAMENTE como están escritas, sin cambiar años, autores ni DOIs. ' +
            'NO TRADUZCAS LOS TÍTULOS: en la bibliografía va el título original, en el ' +
            'idioma en que se publicó. Puedes explicar en español de qué va cada fuente, ' +
            'pero la referencia se copia tal cual. Un título traducido no lo encuentra ' +
            'nadie al comprobarlo, y eso es lo primero que hace un jurado. ' +
            'Si ninguna sirve para lo que estabas escribiendo, dilo en vez de forzarla.',
        );
      },
    );
  }

  return server;
}

module.exports = { construirServidor, NOMBRE_SERVIDOR, VERSION_SERVIDOR };
