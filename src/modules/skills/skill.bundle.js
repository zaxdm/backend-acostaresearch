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

/** Los cuatro bytes con los que empieza cualquier .zip. */
function esZip(buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

/**
 * Un SKILL.md suelto también vale como bundle.
 *
 * Una skill sin materiales de apoyo es un único archivo Markdown, y comprimirlo
 * solo para subirlo es un paso que no aporta nada: quien lo escribe lo guarda
 * como `humanizador-academico.skill` y lo arrastra. Antes eso fallaba con «El
 * bundle no tiene SKILL.md», que era verdad y no ayudaba en nada.
 *
 * Se envuelve aquí, en la entrada, y no se toca nada más: a partir de este
 * punto todo el sistema —el analizador, el guardado, el conector— sigue viendo
 * un .zip normal con su SKILL.md dentro. La alternativa era enseñar a cada
 * lector a distinguir los dos formatos, que es multiplicar el mismo `if` por
 * todos los sitios donde se abre un bundle.
 */
function empaquetar(buffer) {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', buffer);
  return zip.toBuffer();
}

/**
 * Deja el archivo en forma de bundle, venga como venga.
 *
 * Un .zip pasa tal cual. Cualquier otra cosa se toma por un SKILL.md suelto y
 * se envuelve; si no lo era, `analizar` lo rechazará después por no declarar un
 * `name` válido en su cabecera, que es un motivo mucho más útil que «no es un
 * zip».
 */
function normalizar(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw rechazar('No llegó ningún archivo.');
  }

  return esZip(buffer) ? buffer : empaquetar(buffer);
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
  /** Deja el archivo en forma de bundle: un SKILL.md suelto se envuelve. */
  normalizar,

  /**
   * Comprueba que el buffer es un bundle utilizable y extrae sus datos.
   *
   * Lanza `ValidationError` con un motivo concreto: al administrador que sube
   * un archivo equivocado hay que decirle cuál es el problema, no «error».
   */
  analizar(buffer) {
    if (buffer.length > env.SKILLS_MAX_BYTES) {
      const mb = (env.SKILLS_MAX_BYTES / 1024 / 1024).toFixed(0);
      throw rechazar(`El archivo pasa de ${mb} MB.`);
    }

    // Un SKILL.md suelto se envuelve para que a partir de aquí todo sea igual.
    const bundle = normalizar(buffer);

    let entradas;
    try {
      entradas = new AdmZip(bundle).getEntries().filter((e) => !e.isDirectory);
    } catch {
      throw rechazar('El archivo no se pudo leer. Sube el .skill sin abrirlo.');
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
   * Convierte lo que hay guardado en `skill.bundlePath` en una ruta usable.
   *
   * En la base de datos se guarda solo el NOMBRE del archivo, no su ruta
   * completa, y se resuelve aquí contra la carpeta de este entorno. La razón es
   * concreta: una ruta absoluta se guarda una vez y deja de ser cierta en
   * cuanto el servidor cambia de sitio. Las filas escritas desde Windows decían
   * «C:\Users\...\skills\marco-teorico.skill», que en el servidor Linux no
   * existe, y el conector respondía que el capítulo no está publicado con los
   * archivos delante.
   *
   * Se aceptan también las rutas absolutas antiguas: se les toma el nombre y se
   * resuelven igual, de modo que una base que venga de antes funciona sin que
   * nadie tenga que corregirla.
   */
  resolver(bundlePath) {
    if (!bundlePath) return null;
    // basename() de POSIX no entiende la barra invertida de Windows, así que se
    // parte por las dos: esto tiene que digerir rutas escritas en cualquiera de
    // los dos sistemas.
    const nombre = bundlePath.split(/[\\/]/).pop();
    return path.join(env.SKILLS_DIR, nombre);
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

    // Se devuelve el NOMBRE, no la ruta: es lo que se guarda en la ficha para
    // que la skill no quede atada a la carpeta de este servidor.
    return path.basename(destino);
  },

  existe(code) {
    return fs.existsSync(this.rutaDe(code));
  },
};

module.exports = skillBundle;
