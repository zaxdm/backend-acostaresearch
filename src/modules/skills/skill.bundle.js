'use strict';

const fs = require('node:fs');
const path = require('node:path');
const AdmZip = require('adm-zip');
const env = require('../../config/env');
const { ValidationError } = require('../../shared/errors/AppError');

/**
 * Lectura y guardado de bundles de skill.
 *
 * Un bundle es un .zip (con extensión .skill) que contiene un SKILL.md y, al
 * lado, los materiales de apoyo. Es exactamente el formato de la Skills API de
 * Anthropic, y también lo que sirve el conector en modo de entrega: NO hay una
 * conversión a «formato MCP» de por medio, porque el conector no traduce nada.
 * Lee el SKILL.md, lo parte por pasos y lo entrega. Subir un bundle aquí es,
 * literalmente, dejarlo disponible.
 *
 * Todo lo que entra por el panel pasa por `analizar()` antes de tocar el disco:
 * un .zip cualquiera renombrado a .skill no debe llegar nunca a la carpeta que
 * lee el conector.
 */

/** Segmento de ruta válido: sin barras, sin puntos iniciales, sin sorpresas. */
const CODIGO = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Rechazo con motivo visible.
 *
 * `ValidationError` recibe los detalles primero y el mensaje después, así que
 * se pasan los dos: el detalle lo pinta el formulario junto al campo, y el
 * mensaje es el que lee el administrador arriba.
 */
function rechazar(motivo) {
  return new ValidationError([{ field: 'archivo', message: motivo }], motivo);
}

/** Nombres de archivo que no se aceptan dentro del zip. */
function rutaPeligrosa(nombre) {
  return nombre.startsWith('/') || nombre.includes('..') || /^[a-zA-Z]:/.test(nombre);
}

/**
 * Lee el bloque YAML de cabecera del SKILL.md.
 *
 * No se usa un parser de YAML: hacen falta dos campos de una línea cada uno, y
 * `description` de estas skills es un párrafo largo con comas, dos puntos y
 * comillas que un parser estricto rechazaría. Se toma el texto tal cual.
 */
function leerFrontmatter(skillMd) {
  const bloque = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/.exec(skillMd);
  if (!bloque) return {};

  const campos = {};
  let clave = null;

  for (const linea of bloque[1].split('\n')) {
    const encabezado = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(linea);
    if (encabezado) {
      clave = encabezado[1];
      campos[clave] = encabezado[2].trim();
    } else if (clave && linea.trim()) {
      // Continuación de un valor que ocupa varias líneas.
      campos[clave] = `${campos[clave]} ${linea.trim()}`.trim();
    }
  }

  return campos;
}

/** Primer título `#` del cuerpo, como nombre visible de reserva. */
function primerTitulo(skillMd) {
  const titulo = /^#[ \t]+(.+)$/m.exec(skillMd);
  return titulo ? titulo[1].trim() : null;
}

/** Cuenta los `## Paso N`: es el número de tramos que entregará el conector. */
function contarPasos(skillMd) {
  return (skillMd.match(/^##[ \t]+Paso\b/gim) ?? []).length;
}

/** Recorta un texto a lo que cabe en la columna, sin cortar a mitad de palabra. */
function recortar(texto, maximo) {
  const limpio = texto.replace(/\s+/g, ' ').trim();
  if (limpio.length <= maximo) return limpio;

  const corte = limpio.slice(0, maximo - 1);
  const espacio = corte.lastIndexOf(' ');
  return `${(espacio > maximo * 0.6 ? corte.slice(0, espacio) : corte).trimEnd()}…`;
}

const skillBundle = {
  /**
   * Comprueba que el buffer es un bundle utilizable y extrae sus datos.
   *
   * Lanza `ValidationError` con un motivo concreto: al administrador que sube
   * un archivo equivocado hay que decirle cuál es el problema, no «error».
   */
  analizar(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      throw rechazar('No llegó ningún archivo.');
    }

    if (buffer.length > env.SKILLS_MAX_BYTES) {
      const mb = (env.SKILLS_MAX_BYTES / 1024 / 1024).toFixed(0);
      throw rechazar(`El archivo pasa de ${mb} MB.`);
    }

    let entradas;
    try {
      entradas = new AdmZip(buffer).getEntries().filter((e) => !e.isDirectory);
    } catch {
      throw rechazar('El archivo no es un .zip válido. Sube el .skill sin abrirlo.');
    }

    const sospechosa = entradas.find((e) => rutaPeligrosa(e.entryName));
    if (sospechosa) {
      throw rechazar(`El bundle contiene una ruta no permitida: ${sospechosa.entryName}`);
    }

    const principal = entradas.find((e) => /(^|\/)SKILL\.md$/i.test(e.entryName));
    if (!principal) {
      throw rechazar(
        'El bundle no tiene SKILL.md. Debe ser la carpeta de la skill comprimida, con su SKILL.md dentro.',
      );
    }

    const skillMd = principal.getData().toString('utf8');
    const frontmatter = leerFrontmatter(skillMd);

    const code = (frontmatter.name ?? '').trim().toLowerCase();
    if (!CODIGO.test(code)) {
      throw rechazar(
        'El SKILL.md no declara un `name` válido en su cabecera. Debe ir en minúsculas y con guiones, por ejemplo: marco-teorico.',
      );
    }

    const pasos = contarPasos(skillMd);

    return {
      code,
      // Sugerencias para el formulario. El administrador las puede cambiar:
      // el `description` del frontmatter está escrito para que el modelo sepa
      // cuándo activar la skill, no para que lo lea un comprador.
      displayNameSugerido: recortar(primerTitulo(skillMd) ?? code, 120),
      summarySugerido: recortar(frontmatter.description ?? '', 500),
      skillMdBytes: Buffer.byteLength(skillMd, 'utf8'),
      pasos,
      archivos: entradas.length,
      materiales: entradas.filter((e) => e !== principal).map((e) => e.entryName.split('/').pop()),
    };
  },

  /** Ruta en disco de un bundle, dado su código. */
  rutaDe(code) {
    return path.join(env.SKILLS_DIR, `${code}.skill`);
  },

  /**
   * Escribe el bundle en la carpeta que lee el conector.
   *
   * Se escribe a un temporal y se renombra: si el proceso muere a mitad, el
   * bundle anterior sigue entero y el conector sigue sirviendo. Sustituir un
   * archivo que se está leyendo por uno a medias sería servir un método roto a
   * quien está trabajando en ese momento.
   */
  guardar(code, buffer) {
    fs.mkdirSync(env.SKILLS_DIR, { recursive: true });

    const destino = this.rutaDe(code);
    const temporal = `${destino}.${process.pid}.tmp`;

    fs.writeFileSync(temporal, buffer);
    fs.renameSync(temporal, destino);

    return destino;
  },

  existe(code) {
    return fs.existsSync(this.rutaDe(code));
  },
};

module.exports = skillBundle;
