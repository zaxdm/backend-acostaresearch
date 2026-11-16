'use strict';

/** CPU del Word, sin base, configuración del servidor ni lecturas de archivos.
 * Las funciones síncronas conservan la vía directa para comprobar equivalencia.
 * Packer.toBuffer sigue siendo asíncrono, pero se ejecuta entero en el worker.
 */
const documento = require('./project.documento');
const docx = require('./project.docx');
const reescritura = require('./project.reescritura');
const citas = require('./project.citas');
const csl = require('./project.csl');
const mendeleyCampos = require('./project.mendeley-campos');
const contarMarcas = (texto) => [...String(texto).matchAll(citas.MARCA)].length;
const contarFaltas = (texto) => String(texto).match(documento.FALTA)?.length ?? 0;

/** Sólo los Buffer pierden su prototipo en structuredClone (Map/Date se conservan). */
function restaurarBuffers(valor) {
  if (valor instanceof Uint8Array) return Buffer.from(valor.buffer, valor.byteOffset, valor.byteLength);
  if (valor instanceof Map) return new Map([...valor].map(([k, v]) => [k, restaurarBuffers(v)]));
  if (Array.isArray(valor)) return valor.map(restaurarBuffers);
  if (valor && Object.getPrototypeOf(valor) === Object.prototype) {
    return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, restaurarBuffers(v)]));
  }
  return valor;
}

function armarEnLaNorma({ estiloCitas, idiomaCitas, capitulos, fuentes, recursos, uris, preferenciasZotero, mendeley }) {
  if (recursos?.error) throw new Error(recursos.error);
  const porClave = new Map(fuentes.map((f) => [f.ref, f]));
  const porUri = new Map(uris ?? []);
  const r = csl.renderizar({
    norma: estiloCitas, idioma: idiomaCitas, capitulos, porClave, recursos,
    ...(uris ? { urisDe: (fuente) => porUri.get(fuente.ref) } : {}),
  });
  let zotero = null;
  if (preferenciasZotero) {
    const codigos = new Map([...r.citas].map(([numero, cita]) => [String(numero), cita.codigo]));
    if (r.bibliografia) codigos.set('BIB', r.bibliografia.codigo);
    zotero = { preferencias: preferenciasZotero, codigos };
  } else if (mendeley) {
    zotero = { mendeley: {
      citas: mendeleyCampos.datosDeCitas(r.citas, porClave, { comoCsl: csl.comoCsl, perfil: mendeley.profileId }),
      estilo: mendeleyCampos.estiloDe(r.norma.id),
    } };
  }
  return {
    documento: {
      capitulos: capitulos.map((capitulo, i) => ({ ...capitulo, texto: r.textos[i] })),
      citas: r.citas, referencias: r.bibliografia ?? [], zotero,
      fuentes: [...r.usadas.values()], norma: r.norma.id,
    },
    usadas: r.usadas.size, perdidas: r.perdidas, norma: r.norma.id,
  };
}

/** El mismo APA de respaldo si falla el motor de citas. */
function armarEnApa(capitulos, porClave) {
  const usadas = new Map();
  const perdidas = new Set();

  const resueltos = capitulos.map((capitulo) => {
    const resuelto = citas.resolver(capitulo.texto, porClave);
    for (const [clave, fuente] of resuelto.usadas) usadas.set(clave, fuente);
    for (const clave of resuelto.perdidas) perdidas.add(clave);
    return { ...capitulo, texto: resuelto.texto };
  });

  return {
    documento: {
      capitulos: resueltos,
      referencias: citas.bibliografiaConCursivas([...usadas.values()]),
      fuentes: [...usadas.values()],
      norma: 'apa',
    },
    usadas: usadas.size,
    perdidas: [...perdidas],
    norma: 'apa',
  };
}

/** Las marcas conservan su posición al dividir párrafos reescritos. */
function recolocarCitas(citados, partes, reescritos) {
  const partidos = Object.keys(partes)
    .map(Number)
    .filter((id) => partes[id] > 1)
    .sort((a, b) => a - b);
  const corrimiento = (id) => partidos.filter((x) => x < id).reduce((suma, x) => suma + partes[x] - 1, 0);

  const nuevos = {};
  for (const [id, texto] of Object.entries(citados)) {
    const n = Number(id);
    const destino = n + corrimiento(n);
    if (!(partes[n] > 1)) {
      nuevos[destino] = texto;
      continue;
    }
    const largos = reescritura.partesDe(reescritos[n].texto).map((parte) => documento.esqueleto(parte).length);
    partirCitado(texto, largos).forEach((trozo, i) => {
      if (contarMarcas(trozo) + contarFaltas(trozo) > 0) nuevos[destino + i] = trozo;
    });
  }
  return nuevos;
}

const MARCA_AQUI = /\[AR[0-9A-F]{8}(?::[^\]\n]{1,40})?\]|\[FALTA FUENTE\]/iy;

/** Un párrafo con marcas, en trozos de `largos` caracteres visibles cada uno. */
function partirCitado(texto, largos) {
  const trozos = [];
  let actual = '';
  let cuenta = 0;
  let i = 0;

  while (i < texto.length) {
    MARCA_AQUI.lastIndex = i;
    const marca = MARCA_AQUI.exec(texto);
    if (marca) {
      actual += marca[0];
      i += marca[0].length;
      continue;
    }
    const caracter = String.fromCodePoint(texto.codePointAt(i));
    if (!/\s/.test(caracter)) {
      if (trozos.length < largos.length - 1 && cuenta >= largos[trozos.length]) {
        trozos.push(actual.trim());
        actual = '';
        cuenta = 0;
      }
      cuenta += 1;
    }
    actual += caracter;
    i += caracter.length;
  }
  trozos.push(actual.trim());
  return trozos;
}


/** Reescritura, recolocación, citeproc y ZIP del Word subido, sin I/O. */
function armarSubido({ buffer, citados, reescritos, fuentes, estiloCitas, idiomaCitas, recursos }) {
  buffer = restaurarBuffers(buffer);
  let humanizados = 0;
  if (Object.keys(reescritos).length > 0) {
    const hecho = reescritura.reescribir(buffer, reescritos);
    buffer = hecho.buffer;
    humanizados = Object.keys(hecho.partes).length;
    citados = recolocarCitas(citados, hecho.partes, reescritos);
  }
  const tieneCitas = Object.keys(citados).length > 0;
  if (!tieneCitas) return {
    buffer, parrafos: 0, citas: 0, referencias: 0, faltas: 0, perdidas: 0, humanizados, tieneCitas,
  };
  const hecho = documento.citar(buffer, {
    citados, norma: estiloCitas, idioma: idiomaCitas, recursos,
    porClave: new Map(fuentes.map((f) => [f.ref, f])),
  });
  return { ...hecho, humanizados, tieneCitas };
}

async function armarDirecto(tipo, datos) {
  datos = restaurarBuffers(datos);
  if (tipo === 'documento') return armarSubido(datos);
  if (tipo !== 'proyecto') throw new Error('Tipo de Word desconocido: ' + tipo);
  let armado;
  let normaError;
  try {
    armado = armarEnLaNorma(datos);
  } catch (error) {
    normaError = { name: error.name, message: error.message, stack: error.stack };
    armado = armarEnApa(datos.capitulos, new Map(datos.fuentes.map((f) => [f.ref, f])));
  }
  const buffer = await docx.armar({ ...datos.opciones, ...armado.documento });
  return { buffer, usadas: armado.usadas, perdidas: armado.perdidas, norma: armado.norma,
    ...(normaError ? { normaError } : {}) };
}

module.exports = { armarDirecto, armarEnLaNorma, armarSubido, partirCitado };
