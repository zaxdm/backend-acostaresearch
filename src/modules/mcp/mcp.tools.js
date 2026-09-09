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
const projectService = require('../projects/project.service');

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
    temaOriginal: {
      type: 'string',
      description:
        'El mismo tema EN ESPAÑOL, tal como lo dijo el tesista. Mándalo siempre. ' +
        'Si en la biblioteca no hay nada, esta herramienta sale sola al catálogo abierto ' +
        'usando estas palabras, y ahí el español encuentra lo que el inglés no: Scielo, ' +
        'Redalyc y los repositorios latinoamericanos.',
    },
    pais: {
      type: 'string',
      description:
        'Código de dos letras del país del tesista: «pe» Perú, «co» Colombia, «mx» México. ' +
        'Solo se usa si hay que salir al catálogo abierto, y sirve para traerle ' +
        'ANTECEDENTES NACIONALES, que es lo que le va a pedir su jurado.',
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

const ESQUEMA_LITERATURA = fromJsonSchema({
  type: 'object',
  properties: {
    tema: {
      type: 'string',
      minLength: 3,
      description:
        'Sobre qué buscar. AQUÍ SÍ VALE EL ESPAÑOL: esta base indexa Scielo, Redalyc y ' +
        'repositorios latinoamericanos. Escribe el tema como lo diría el tesista.',
    },
    idioma: {
      type: 'string',
      enum: ['es', 'en', 'pt'],
      description:
        'Acota el idioma de los trabajos. Úsalo con «es» cuando el tesista quiera fuentes ' +
        'que pueda leer sin traducir. Si lo omites, entran todos los idiomas.',
    },
    pais: {
      type: 'string',
      description:
        'Código de dos letras del país de los autores: «pe» Perú, «co» Colombia, «mx» ' +
        'México, «cl» Chile. ES LO QUE PIDE UN JURADO cuando pregunta qué se ha estudiado ' +
        'sobre esto en el país. Sin él, entra la producción de todo el mundo.',
    },
    desdeAnio: {
      type: 'integer',
      minimum: 1900,
      description: 'Solo trabajos publicados desde ese año. Útil para «los últimos cinco años».',
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

const ESQUEMA_GUARDAR_AVANCE = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo sobre el que quedó algo decidido, tal como aparece en ' +
        'listar_capitulos. Omítelo si solo estás guardando el tema o la universidad.',
    },
    estado: {
      type: 'string',
      enum: ['PENDIENTE', 'EN_CURSO', 'LISTO'],
      description:
        'Cómo queda ese capítulo. Marca LISTO SOLO si el tesista ha dicho que lo da por ' +
        'bueno. No lo decidas tú porque hayáis escrito mucho: un capítulo que se da por ' +
        'cerrado sin que él lo cierre es el que luego no se sostiene ante el jurado.',
    },
    resumen: {
      type: 'string',
      maxLength: 1500,
      description:
        'Qué quedó decidido, en dos o tres frases y en concreto: los objetivos que se ' +
        'fijaron, la población que se eligió, el diseño acordado. NO el texto del ' +
        'capítulo — esto es la memoria de lo acordado, no el documento. Lo leerá el ' +
        'asistente que atienda al tesista la próxima vez, que no habrá visto esta ' +
        'conversación.',
    },
    tema: {
      type: 'string',
      description: 'El tema de la tesis ya delimitado, si se ha fijado o ha cambiado.',
    },
    carrera: { type: 'string', description: 'La carrera del tesista.' },
    universidad: { type: 'string', description: 'Su universidad.' },
  },
  additionalProperties: false,
});

const ESQUEMA_GUARDAR_CAPITULO = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description: 'Clave del capítulo, tal como aparece en listar_capitulos.',
    },
    texto: {
      type: 'string',
      minLength: 1,
      maxLength: 30000,
      description:
        'El texto del capítulo tal y como va a la tesis, en Markdown: ## para los ' +
        'subtítulos y párrafos separados por una línea en blanco. NADA de comentarios ' +
        'tuyos, ni «aquí tienes», ni notas entre corchetes: esto se convierte en el Word ' +
        'que el tesista entrega. Si pasa de 30.000 caracteres, mándalo por partes.',
    },
    anadir: {
      type: 'boolean',
      description:
        'Verdadero para pegarlo detrás de lo que ya había, en vez de reemplazarlo. ' +
        'Úsalo para las partes segunda y siguientes de un capítulo largo. ' +
        'Si el tesista corrigió el capítulo entero, mándalo completo SIN esta marca.',
    },
  },
  required: ['capitulo', 'texto'],
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

  // ── La memoria del proyecto ──────────────────────────────────────────────
  //
  // Estas dos son la diferencia entre un conector que contesta y uno que
  // acompaña una tesis. Van fuera de cualquier condición: no dependen de que
  // haya corpus, ni de cómo se entregue el método.

  server.registerTool(
    'mi_proyecto',
    {
      title: 'Por dónde va su tesis',
      description:
        'Lo que este servidor recuerda del proyecto del tesista: su tema, su universidad y ' +
        'en qué punto está cada capítulo. LLÁMALA AL EMPEZAR CUALQUIER CONVERSACIÓN NUEVA, ' +
        'antes de preguntarle nada. Si ya lo sabemos, preguntárselo otra vez es hacerle ' +
        'repetir lo que ya contó.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'mi_proyecto' });

      const contexto = await projectService.contexto(licencia.user.id, licencia.productCode);

      if (!contexto) {
        return texto(
          'Todavía no hay nada guardado de este proyecto.\n\n' +
            'Según vayáis fijando cosas —el tema, los objetivos, la metodología— guárdalas ' +
            'con "guardar_avance". No lo dejes para el final de la conversación: si se corta, ' +
            'se pierde, y el tesista tendrá que contarlo todo otra vez.',
        );
      }

      const siguiente = await projectService.siguientePaso(
        licencia.user.id,
        licencia.productCode,
      );

      return texto(
        contexto +
          (siguiente
            ? `\n\nLo siguiente que le tocaría: ${siguiente.displayName} (clave: ${siguiente.code}).`
            : '\n\nTiene todos los capítulos dados por buenos.'),
      );
    },
  );

  server.registerTool(
    'guardar_avance',
    {
      title: 'Recordar lo que quedó decidido',
      description:
        'Guarda en el servidor lo que se ha acordado, para que siga estando la próxima vez ' +
        'aunque sea en otra conversación. Úsala EN CUANTO se fije algo —el tema, los ' +
        'objetivos, la población, el diseño—, no al terminar. Guarda lo acordado en dos o ' +
        'tres frases, nunca el texto del capítulo.',
      inputSchema: ESQUEMA_GUARDAR_AVANCE,
    },
    async (entrada) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'guardar_avance' });

      // Guardar el avance de un capítulo que no es suyo escribiría en la
      // memoria del proyecto una clave que después nadie sabe interpretar.
      if (entrada.capitulo) {
        const skill = await skillService.findByCode(entrada.capitulo);
        if (!skill || !skillService.perteneceAlGrupo(skill, licencia.productCode)) {
          return texto(
            `No existe ningún capítulo con la clave "${entrada.capitulo}". ` +
              'Usa listar_capitulos para ver las claves válidas. No se ha guardado nada.',
          );
        }
      }

      try {
        const { etapa } = await projectService.guardarAvance({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          ...entrada,
        });

        const guardado = [];
        if (entrada.tema) guardado.push('el tema');
        if (entrada.carrera) guardado.push('la carrera');
        if (entrada.universidad) guardado.push('la universidad');
        if (etapa) {
          guardado.push(
            `el capítulo ${etapa.skillCode}` +
              (etapa.estado === 'LISTO' ? ', que queda dado por bueno' : ''),
          );
        }

        return texto(
          guardado.length > 0
            ? `Guardado: ${guardado.join(', ')}. Estará aquí la próxima vez que abra una conversación.`
            : 'No mandaste nada que guardar.',
        );
      } catch (error) {
        // Un fallo al guardar no puede parecer un éxito: el asistente daría por
        // recordado algo que se perdió, y nadie lo sabría hasta semanas después.
        logger.error(
          { err: error, licenseId: licencia.id },
          'No se pudo guardar el avance del proyecto',
        );
        return texto(
          'No se pudo guardar eso: ' +
            (error?.issues?.[0]?.message ?? 'error del servidor') +
            '. Vuelve a intentarlo; si insiste, sigue trabajando y avísale de que este ' +
            'avance no ha quedado guardado.',
        );
      }
    },
  );

  server.registerTool(
    'guardar_capitulo',
    {
      title: 'Guardar el capítulo escrito',
      description:
        'Guarda el texto de un capítulo en el servidor, para que el tesista se lo pueda ' +
        'descargar en Word con todos los demás, en orden y con su portada. ' +
        'GUÁRDALO EN CUANTO el tesista dé por bueno lo redactado, sin que te lo pida: no ' +
        'sabe que esto existe, y lo que no se guarde aquí lo tendrá que copiar y pegar él. ' +
        'Manda el texto limpio, sin comentarios tuyos.',
      inputSchema: ESQUEMA_GUARDAR_CAPITULO,
    },
    async (entrada) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'guardar_capitulo' });

      const skill = await skillService.findByCode(entrada.capitulo);
      if (!skill || !skillService.perteneceAlGrupo(skill, licencia.productCode)) {
        return texto(
          `No existe ningún capítulo con la clave "${entrada.capitulo}". ` +
            'Usa listar_capitulos para ver las claves válidas. No se ha guardado nada.',
        );
      }

      try {
        const { palabras } = await projectService.guardarCapitulo({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          ...entrada,
        });

        return texto(
          `Guardado. «${skill.displayName}» lleva ${palabras} palabras.\n\n` +
            'Dile que ya puede descargar su tesis en Word desde su panel, en ' +
            'acostaresearch.com/perfil, y que sale con todos los capítulos que llevéis.',
        );
      } catch (error) {
        logger.error(
          { err: error, licenseId: licencia.id },
          'No se pudo guardar el texto del capítulo',
        );
        // Decirle «guardado» cuando no se guardó sería lo peor que puede pasar
        // aquí: el tesista cerraría la conversación creyendo que su capítulo
        // está a salvo.
        return texto(
          'NO se pudo guardar: ' +
            (error?.issues?.[0]?.message ?? 'error del servidor') +
            '. AVÍSALE de que este capítulo no ha quedado guardado en el servidor y que ' +
            'no cierre la conversación sin copiarlo.',
        );
      }
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

        /**
         * La memoria del proyecto viaja con el primer tramo del capítulo.
         *
         * Va aquí y no en una herramienta aparte porque delegar en que el
         * asistente se acuerde de consultarla es exactamente lo que no
         * funciona: no se acuerda, y el tesista cuenta su tema por cuarta vez.
         *
         * Solo en el primero. Repetir el contexto en cada tramo engordaría cada
         * respuesta con lo mismo, y lo que se repite se acaba ignorando.
         */
        const primerTramo = !referencia && !hilo.lastSection;
        if (primerTramo) {
          const memoria = await projectService
            .contexto(licencia.user.id, licencia.productCode)
            .catch((error) => {
              // Que falle la memoria no puede dejar sin capítulo a nadie: el
              // método es el producto, esto es la ayuda.
              logger.error(
                { err: error, licenseId: licencia.id },
                'No se pudo leer la memoria del proyecto',
              );
              return null;
            });

          if (memoria) return texto(`${memoria}\n\n───────────\n\n${contenido.texto}`);
        }

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
          'BUSCA AQUÍ EN INGLÉS: esta biblioteca son artículos indexados en Scopus y Web of ' +
          'Science, y sus títulos y resúmenes están en inglés. El tesista te escribe en español, ' +
          'así que traduce tú el tema antes de buscar («validez de constructo» → «construct ' +
          'validity»). ' +
          'MANDA SIEMPRE "temaOriginal" con el tema en español y "pais" con el del tesista: ' +
          'si aquí no hay nada, esta misma herramienta sale al catálogo abierto con esas ' +
          'palabras y no te deja sin fuentes. ' +
          'Las de la biblioteca llevan el criterio de Acosta; las que vengan del catálogo ' +
          'abierto no, y la respuesta te lo dirá para que lo adviertas.',
        inputSchema: ESQUEMA_FUENTES,
      },
      async ({ tema, temaOriginal, pais, cuantas }) => {
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

        // ── Sin nada en la biblioteca: NO se vuelve con las manos vacías ────
        //
        // Antes esto devolvía un muro de instrucciones y cero fuentes. El
        // tesista se quedaba igual que empezó, y lo peor: la salida que le
        // quedaba era que el asistente citara de memoria.
        //
        // Ahora sale al catálogo abierto en la misma llamada. Con las palabras
        // EN ESPAÑOL del tesista, que es lo que encuentra Scielo y Redalyc: el
        // término en inglés que sirve para la biblioteca de la casa no
        // encuentra un artículo peruano publicado en español.
        if (fuentes.length === 0) {
          const enEspanol = (temaOriginal || '').trim() || tema;
          const abierta = await referenceService.buscarEnLaLiteratura({
            tema: enEspanol,
            pais: pais || null,
            cuantas,
          });

          if (abierta.fuentes.length === 0) {
            return texto(
              `No hay nada sobre «${tema}» ni en la biblioteca de Acosta ni en el catálogo ` +
                `abierto.\n\n` +
                'DÍSELO AL TESISTA TAL CUAL y sigue sin citar ahí. Que su tema esté poco ' +
                'estudiado es un hallazgo que va en la justificación, no un problema que se ' +
                'tape citando de memoria.\n\n' +
                'Y dile que puede subir SU PROPIO export de Scopus, Web of Science o SciELO ' +
                'desde su perfil, en «Método de tesis → Mis fuentes»: desde ese momento estas ' +
                'búsquedas también leen de ahí.',
            );
          }

          const deFuera = abierta.fuentes.map((f, i) => {
            const lineas = [`${i + 1}. ${f.cita}`];
            const señas = [];
            if (f.citas > 0) señas.push(`citado ${f.citas} veces`);
            if (f.pdfLibre) señas.push('PDF gratis');
            if (f.idioma) señas.push(`en ${f.idioma}`);
            if (señas.length > 0) lineas.push(`   [${señas.join(' · ')}]`);
            if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
            return lineas.join('\n');
          });

          return texto(
            `En la biblioteca de Acosta no hay nada sobre «${tema}», así que busqué en el ` +
              `catálogo abierto con «${enEspanol}»:\n\n${deFuera.join('\n\n')}\n\n` +
              'AVISA DE QUE ESTAS NO ESTÁN REVISADAS POR ACOSTA: vienen de un catálogo ' +
              'abierto donde entra de todo, preprints y repositorios incluidos. El tesista ' +
              'debería comprobar dónde se publicó cada una antes de citarla. ' +
              'Cita EXACTAMENTE como están, sin traducir los títulos.',
          );
        }

        const fichas = fuentes.map((f, i) => {
          // La clave va primero, pegada al número, porque es lo que hay que
          // copiar al texto. Lo que va delante es lo que se copia.
          const lineas = [`${i + 1}. [${f.clave}]  ${f.cita}`];
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
            'CÓMO SE CITAN. Al redactar el capítulo, escribe la clave entre corchetes donde ' +
            'vaya la cita —así: «…afecta al rendimiento [AR97D22F86].»— y guarda el capítulo ' +
            'con esa marca puesta. Al armar el Word, el servidor la cambia por la cita en ' +
            'APA y añade la fuente a la lista de Referencias, las dos cosas sacadas de la ' +
            'misma ficha. No montes tú la bibliografía: sale sola, y así no puede discrepar ' +
            'de lo que dice el texto.\n\n' +
            'Al hablar con el tesista, cítalas en APA normal; la clave es para el texto que ' +
            'guardes. Y NO TRADUZCAS LOS TÍTULOS: en la bibliografía va el original, en el ' +
            'idioma en que se publicó. Un título traducido no lo encuentra nadie al ' +
            'comprobarlo, y eso es lo primero que hace un jurado. ' +
            'Si ninguna sirve para lo que estabas escribiendo, dilo en vez de forzarla.',
        );
      },
    );
  }

  // ── Literatura abierta, en vivo ──────────────────────────────────────────
  //
  // POR QUÉ NO ES LA API DE SCOPUS
  // ------------------------------
  // Porque no se puede desde aquí. Elsevier ata el acceso real a la RED de una
  // institución suscrita: desde la IP de este servidor no hay suscripción que
  // valga, y lo que devolvería es metadato recortado o nada.
  //
  // OpenAlex cubre el mismo terreno sin clave ni cuota institucional, e indexa
  // Scielo, Redalyc y repositorios latinoamericanos que Scopus ni tiene. Para
  // un tesista peruano que necesita antecedentes nacionales eso no es un
  // consuelo: es mejor que Scopus.
  //
  // Va siempre disponible, con corpus configurado o sin él: no depende de la
  // biblioteca de la casa.
  server.registerTool(
    'buscar_en_la_literatura',
    {
      title: 'Buscar en la literatura publicada',
      description:
        'Busca en OpenAlex, el catálogo abierto de 327 millones de trabajos publicados. ' +
        'EN VIVO, no en una biblioteca guardada. ' +
        'ÚSALA cuando "buscar_fuentes" no encuentre nada, cuando el tesista pida ' +
        'ANTECEDENTES DE SU PAÍS, o cuando quiera fuentes en español: aquí sí valen, porque ' +
        'esta base indexa Scielo, Redalyc y repositorios latinoamericanos. ' +
        'Devuelve autor, año, revista, DOI real, cuántas veces se ha citado y si hay PDF ' +
        'gratis. NO cites de memoria ni completes datos que no vengan de aquí. ' +
        'ESTAS FUENTES NO ESTÁN REVISADAS POR ACOSTA: el catálogo es abierto y entra de todo, ' +
        'incluidos repositorios y preprints. Dilo al presentarlas, y recuerda que las de ' +
        '"buscar_fuentes" sí llevan ese criterio.',
      inputSchema: ESQUEMA_LITERATURA,
    },
    async ({ tema, idioma, pais, desdeAnio, cuantas }) => {
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: 'buscar_en_la_literatura',
        prompt: tema,
      });

      const { fuentes, total, caida } = await referenceService.buscarEnLaLiteratura({
        tema,
        idioma,
        pais,
        desdeAnio,
        cuantas,
      });

      // La búsqueda abierta de OpenAlex se pausa a veces mientras su servidor se
      // recupera. No es culpa del tesista ni un fallo del conector, y decirlo
      // así evita que se ponga a probar cosas creyendo que hizo algo mal.
      if (caida) {
        return texto(
          'El catálogo abierto no está respondiendo ahora mismo. No es nada que hayas hecho ' +
            'tú ni te falte configurar: es su servidor.\n\n' +
            'Prueba de nuevo en un rato, o busca mientras en la biblioteca de Acosta con ' +
            '"buscar_fuentes", traduciendo el tema al inglés.',
        );
      }

      if (fuentes.length === 0) {
        const acotado = [idioma ? 'idioma ' + idioma : null, pais ? 'país ' + pais : null]
          .filter(Boolean)
          .join(' y ');

        return texto(
          `No hay trabajos sobre «${tema}»${acotado ? ' con ' + acotado : ''}.${N}${N}` +
            'Antes de darlo por perdido: quita el filtro de país o de idioma y vuelve a ' +
            'buscar, o prueba con sinónimos. Si de verdad no hay nada, DÍSELO AL TESISTA ' +
            'TAL CUAL: que su tema esté poco estudiado es un hallazgo que va en la ' +
            'justificación, no un problema que se tape citando de memoria.',
        );
      }

      const fichas = fuentes.map((f, i) => {
        const lineas = [`${i + 1}. ${f.cita}`];

        const señas = [];
        if (f.citas > 0) señas.push(`citado ${f.citas} veces`);
        if (f.pdfLibre) señas.push('PDF gratis');
        if (f.idioma) señas.push(`en ${f.idioma}`);
        if (señas.length > 0) lineas.push(`   [${señas.join(' · ')}]`);

        if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
        return lineas.join('\n');
      });

      const cuantosHay = total > fuentes.length ? ` (hay ${total} en total)` : '';

      return texto(
        `Literatura publicada sobre «${tema}»${cuantosHay}:\n\n${fichas.join('\n\n')}\n\n` +
          'Cita EXACTAMENTE como están escritas, sin cambiar años, autores ni DOIs, y sin ' +
          'traducir los títulos: en la bibliografía va el título original. ' +
          'Y DI DE DÓNDE VIENEN: son del catálogo abierto, no de la biblioteca revisada de ' +
          'Acosta. El tesista debería comprobar dónde se publicó cada una antes de citarla.',
      );
    },
  );

  return server;
}

module.exports = { construirServidor, NOMBRE_SERVIDOR, VERSION_SERVIDOR };
