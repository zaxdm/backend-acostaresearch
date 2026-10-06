'use strict';

/**
 * Las palabras de las páginas que el reporte de Turnitin trae como imagen.
 *
 * Para qué: el reporte clásico («Informe de originalidad») de una entrega en
 * PDF no trae el texto de la tesis, sino una foto de cada hoja; encima van, en
 * vector, los rectángulos de color de cada coincidencia. Se lee la foto con
 * tesseract (en español) y cada palabra se sitúa en coordenadas de la página,
 * para que se cruce con esos rectángulos igual que el texto de verdad.
 *
 * Tarda unos dos segundos por hoja: por eso el reporte se guarda primero y esto
 * corre después, de a un reporte por vez para no quitarle la CPU al servidor.
 */

const os = require('node:os');
const path = require('node:path');

/** Un trabajador de tesseract dura lo que dura la cola y unos segundos más. */
const REPOSO_MS = 60_000;

/** Menos que esto (en puntos de la página) es un logo o un sello, no una hoja escrita. */
const LADO_MINIMO = 200;

let trabajador = null;
let apagar = null;
let cola = Promise.resolve();

async function elTrabajador() {
  clearTimeout(apagar);
  if (!trabajador) {
    const { createWorker } = await import('tesseract.js');
    const { langPath } = require('@tesseract.js-data/spa');
    trabajador = await createWorker('spa', 1, {
      langPath,
      gzip: true,
      cachePath: path.join(os.tmpdir(), 'acosta-tesseract'),
    });
  }
  return trabajador;
}

function dormir() {
  clearTimeout(apagar);
  apagar = setTimeout(() => {
    const t = trabajador;
    trabajador = null;
    t?.terminate().catch(() => {});
  }, REPOSO_MS);
  apagar.unref?.();
}

/** Corre `tarea` cuando terminen las anteriores: un OCR a la vez en todo el servidor. */
function enCola(tarea) {
  const turno = cola.then(tarea, tarea);
  cola = turno.catch(() => {});
  return turno;
}

const multiplicar = ([a, b, c, d, e, f], [a2, b2, c2, d2, e2, f2]) => [
  a * a2 + b * c2,
  a * b2 + b * d2,
  c * a2 + d * c2,
  c * b2 + d * d2,
  e * a2 + f * c2 + e2,
  e * b2 + f * d2 + f2,
];

const aplicar = ([a, b, c, d, e, f], x, y) => [a * x + c * y + e, b * x + d * y + f];

/**
 * Las imágenes grandes que pinta la página, con la matriz con que se pintan.
 * La imagen ocupa el cuadrado unidad: la matriz la lleva a la página.
 */
function imagenesDe(fnArray, argsArray, OPS) {
  let ctm = [1, 0, 0, 1, 0, 0];
  const pila = [];
  const imagenes = [];
  for (let i = 0; i < fnArray.length; i += 1) {
    const op = fnArray[i];
    const args = argsArray[i];
    if (op === OPS.save) pila.push(ctm);
    else if (op === OPS.restore) ctm = pila.pop() ?? ctm;
    else if (op === OPS.transform) ctm = multiplicar(args, ctm);
    else if (op === OPS.paintImageXObject) {
      const ancho = Math.hypot(ctm[0], ctm[1]);
      const alto = Math.hypot(ctm[2], ctm[3]);
      if (ancho >= LADO_MINIMO && alto >= LADO_MINIMO) imagenes.push({ nombre: args[0], ctm });
    }
  }
  return imagenes;
}

/** Los píxeles de pdfjs (gris de 1 bit, RGB o RGBA) a un PNG que tesseract entienda. */
function aPng({ width, height, data, kind }) {
  const { PNG } = require('pngjs');
  const png = new PNG({ width, height });
  const salida = png.data;
  if (kind === 1) {
    const fila = Math.ceil(width / 8);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const v = (data[y * fila + (x >> 3)] >> (7 - (x & 7))) & 1 ? 255 : 0;
        const j = (y * width + x) * 4;
        salida[j] = v;
        salida[j + 1] = v;
        salida[j + 2] = v;
        salida[j + 3] = 255;
      }
    }
  } else {
    const canales = kind === 3 ? 4 : 3;
    for (let k = 0, j = 0; k < width * height; k += 1) {
      salida[j++] = data[k * canales];
      salida[j++] = data[k * canales + 1];
      salida[j++] = data[k * canales + 2];
      salida[j++] = 255;
    }
  }
  return PNG.sync.write(png);
}

const objeto = (pagina, nombre) =>
  new Promise((resolve) => (nombre.startsWith('g_') ? pagina.commonObjs : pagina.objs).get(nombre, resolve));

/**
 * Las palabras de las imágenes de una página, en orden de lectura y en
 * coordenadas de la página: `[{ texto, x, y }]`, con (x, y) en el centro.
 */
async function palabrasDeLaPagina(pagina, { fnArray, argsArray }, OPS) {
  const salida = [];
  for (const { nombre, ctm } of imagenesDe(fnArray, argsArray, OPS)) {
    const img = await objeto(pagina, nombre);
    if (!img?.data || !img.width || !img.height) continue;
    const t = await elTrabajador();
    const { data } = await t.recognize(aPng(img), {}, { blocks: true });
    for (const bloque of data.blocks ?? []) {
      for (const parrafo of bloque.paragraphs) {
        for (const renglon of parrafo.lines) {
          for (const w of renglon.words) {
            const u = (w.bbox.x0 + w.bbox.x1) / 2 / img.width;
            const v = 1 - (w.bbox.y0 + w.bbox.y1) / 2 / img.height;
            const [x, y] = aplicar(ctm, u, v);
            salida.push({ texto: w.text, x, y });
          }
        }
      }
    }
  }
  return salida;
}

/**
 * Lee con OCR las páginas pedidas. `porPagina(numero, palabras)` recibe cada
 * una al terminarla. Corre en la cola del servidor.
 */
function leerPaginas(pdf, OPS, numeros, porPagina) {
  return enCola(async () => {
    try {
      for (const n of numeros) {
        const pagina = await pdf.getPage(n);
        const operaciones = await pagina.getOperatorList();
        await porPagina(n, await palabrasDeLaPagina(pagina, operaciones, OPS));
      }
    } finally {
      dormir();
    }
  });
}

module.exports = { imagenesDe, aPng, leerPaginas };
