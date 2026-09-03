'use strict';

const { McpServer, fromJsonSchema } = require('@modelcontextprotocol/server');
const env = require('../../config/env');
const logger = require('../../config/logger');
const skillService = require('../skills/skill.service');
const licenseService = require('../licensing/license.service');

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
    sesion: {
      type: 'string',
      description: 'Identificador devuelto en la respuesta anterior, para continuar.',
    },
  },
  required: ['capitulo', 'mensaje'],
  additionalProperties: false,
});

const NOMBRE_SERVIDOR = 'acosta-research-tesis';
const VERSION_SERVIDOR = '1.0.0';

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
      const skills = await skillService.listCatalog();
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'listar_capitulos' });

      if (skills.length === 0) {
        return texto('Todavía no hay capítulos publicados. Escribe a Acosta | IA & Research.');
      }

      const lineas = skills.map((s) => {
        const listo = s.anthropicSkillId ? '' : '  (aún no disponible)';
        return `${s.displayName}${listo}\n    clave: ${s.code}\n    ${s.summary}`;
      });

      return texto(
        `Método de tesis — Acosta | IA & Research\n\n${lineas.join('\n\n')}\n\n` +
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

      const caduca = licencia.expiresAt
        ? `Caduca el ${licencia.expiresAt.toISOString().slice(0, 10)}.`
        : 'Sin fecha de caducidad.';

      return texto(
        `Licencia activa a nombre de ${licencia.user.firstName} (${licencia.user.email}).\n` +
          `Producto: ${licencia.productCode}\n` +
          `Consultas realizadas: ${licencia.callsTotal}\n` +
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
        'Es una conversación: usa "sesion" para continuar donde lo dejaste.',
      inputSchema: ESQUEMA_REDACTAR,
    },
    async ({ capitulo, mensaje, sesion }) => {
      const inicio = Date.now();
      const skill = await skillService.findByCode(capitulo);

      if (!skill || !skill.active) {
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

      // El uso se registra siempre, incluso cuando no se puede atender: el motor
      // de detección necesita ver TODAS las llamadas, no solo las que salieron bien.
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: `redactar:${skill.code}`,
        prompt: mensaje,
        sessionId: sesion,
        ok: Boolean(skill.anthropicSkillId) && env.rewriteEnabled,
        durationMs: Date.now() - inicio,
      });

      if (!env.rewriteEnabled) {
        logger.warn('Se pidió redactar sin ANTHROPIC_API_KEY configurada');
        return texto(
          'El servicio de redacción no está disponible en este momento. ' +
            'Escribe a Acosta | IA & Research y lo revisamos.',
        );
      }

      if (!skill.anthropicSkillId) {
        return texto(
          `El capítulo "${skill.displayName}" todavía no está publicado. ` +
            'Usa listar_capitulos para ver cuáles ya están disponibles.',
        );
      }

      // Aquí entrará la invocación real contra la Skills API. Se deja explícito
      // en vez de improvisar: sin clave no se ha podido probar ni una llamada.
      return texto(
        'La redacción asistida se está terminando de habilitar. ' +
          'Mientras tanto puedes consultar el catálogo con listar_capitulos.',
      );
    },
  );

  return server;
}

module.exports = { construirServidor, NOMBRE_SERVIDOR, VERSION_SERVIDOR };
