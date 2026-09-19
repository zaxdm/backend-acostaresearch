'use strict';

/**
 * La codificación: el libro de códigos y las citas, y las reglas para cambiarlos.
 *
 * Todo aquí es puro, sin disco ni base: recibe lo guardado y lo que manda Claude,
 * y devuelve lo nuevo o los errores. Lo usa `cualitativo.service`.
 *
 * LA REGLA QUE IMPORTA
 * --------------------
 * Una cita es un fragmento de la entrevista, y tiene que estar en ella. Claude
 * manda el párrafo y el texto; aquí se busca ese texto en ese párrafo y, si no
 * está, la codificación entera se rechaza diciendo cuál falló. No se arregla ni
 * se aproxima: una frase que el entrevistado no dijo, puesta entre comillas en
 * el capítulo de resultados, es exactamente lo que un jurado no perdona.
 *
 * Lo único que se tolera es lo que Claude no puede ver: los espacios y las
 * variantes de comillas y guiones, igual que al citar el Word subido
 * (`project.documento.esqueleto`). La cita se guarda con el texto del párrafo,
 * no con el que mandó Claude, y con su posición: el .qdpx la necesita.
 *
 * UNA ENTREVISTA A LA VEZ
 * -----------------------
 * Guardar la codificación de una entrevista REEMPLAZA la que tenía. Así corregir
 * es volver a mandarla, y nunca quedan dos versiones de la misma cita.
 */

const EQUIVALENTES = {
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'",
  '–': '-', '—': '-', '‑': '-', '−': '-',
};

const MAXIMO_CODIGOS = 300;
const MAXIMO_CITAS_POR_ENTREVISTA = 400;
const MINIMO_CARACTERES_CITA = 3;

class CodificacionNoValida extends Error {
  constructor(errores) {
    super(errores.join('\n'));
    this.errores = errores;
  }
}

/**
 * El texto sin espacios, y de qué posición del original sale cada carácter.
 *
 * Las posiciones son índices de JavaScript (unidades UTF-16), las mismas de
 * `slice`.
 */
function esqueletoConPosiciones(texto) {
  const original = String(texto).normalize('NFC');
  let esqueleto = '';
  const posiciones = [];
  let i = 0;
  for (const caracter of original) {
    if (!/\s/.test(caracter)) {
      const equivalente = EQUIVALENTES[caracter] ?? caracter;
      for (let k = 0; k < equivalente.length; k += 1) posiciones.push(i);
      esqueleto += equivalente;
    }
    i += caracter.length;
  }
  return { esqueleto, posiciones, original };
}

/**
 * Dónde está `fragmento` dentro de `parrafo`: `{ inicio, fin, texto }` con el
 * texto tal cual está en el párrafo, o null si no está.
 */
function localizar(parrafo, fragmento) {
  const p = esqueletoConPosiciones(parrafo);
  const f = esqueletoConPosiciones(fragmento).esqueleto;
  if (f.length === 0) return null;
  const donde = p.esqueleto.indexOf(f);
  if (donde < 0) return null;
  const inicio = p.posiciones[donde];
  const ultimo = p.posiciones[donde + f.length - 1];
  const fin = ultimo + String.fromCodePoint(p.original.codePointAt(ultimo)).length;
  return { inicio, fin, texto: p.original.slice(inicio, fin) };
}

/** «  apoyo   docente » → «apoyo docente»: el nombre que se enseña. */
const nombreLimpio = (nombre) => String(nombre ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

/** Lo que decide si dos nombres son el mismo código: sin mayúsculas ni tildes de más. */
const claveDe = (nombre) =>
  nombreLimpio(nombre)
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');

function vacia() {
  return { codigos: [], citas: [], siguiente: 1 };
}

/** El código del libro con ese nombre, sin mirar mayúsculas ni tildes. */
function buscarCodigo(libro, nombre) {
  const clave = claveDe(nombre);
  return libro.codigos.find((c) => claveDe(c.nombre) === clave) ?? null;
}

/**
 * La codificación de una entrevista, comprobada y puesta en su sitio.
 *
 * - `codificacion`: lo guardado (`{ codigos, citas, siguiente }`), o null.
 * - `entrevista`: `{ id, parrafos }`.
 * - `envio`: lo que manda Claude: `{ codigos: [{ nombre, definicion, categoria }],
 *   citas: [{ parrafo, texto, codigos: [nombre] }] }`.
 *
 * Devuelve `{ codificacion, nuevos, citas }` o lanza `CodificacionNoValida` con
 * TODOS los errores, para que Claude los arregle de una vez.
 */
function codificar(codificacion, entrevista, envio) {
  const libro = structuredClone(codificacion ?? vacia());
  const errores = [];
  const ahora = new Date().toISOString();
  const nuevos = [];

  // 1. Los códigos que define o redefine este envío.
  for (const [i, definido] of (envio.codigos ?? []).entries()) {
    const nombre = nombreLimpio(definido?.nombre);
    const definicion = String(definido?.definicion ?? '').trim();
    const categoria = nombreLimpio(definido?.categoria) || null;
    if (!nombre) {
      errores.push(`Código ${i + 1}: falta el nombre.`);
      continue;
    }
    if (nombre.length > 80) {
      errores.push(`Código «${nombre.slice(0, 40)}…»: el nombre pasa de 80 caracteres; acórtalo.`);
      continue;
    }
    const existente = buscarCodigo(libro, nombre);
    if (existente) {
      if (definicion) existente.definicion = definicion;
      if (categoria) existente.categoria = categoria;
      continue;
    }
    if (!definicion) {
      errores.push(`Código «${nombre}»: es nuevo y no tiene definición. Todo código lleva la suya.`);
      continue;
    }
    libro.codigos.push({ nombre, definicion, categoria, creadoAt: ahora });
    nuevos.push(nombre);
  }
  if (libro.codigos.length > MAXIMO_CODIGOS) {
    errores.push(`El libro pasaría de ${MAXIMO_CODIGOS} códigos. Agrupa los parecidos antes de seguir.`);
  }

  // 2. Las citas: cada una en su párrafo, con códigos que existan.
  const enviadas = envio.citas ?? [];
  if (enviadas.length > MAXIMO_CITAS_POR_ENTREVISTA) {
    errores.push(`Son ${enviadas.length} citas; el máximo por entrevista es ${MAXIMO_CITAS_POR_ENTREVISTA}.`);
  }
  const citas = [];
  let siguiente = libro.siguiente ?? 1;
  for (const [i, enviada] of enviadas.entries()) {
    const n = i + 1;
    const numero = Number(enviada?.parrafo);
    const parrafo = Number.isInteger(numero) ? entrevista.parrafos[numero - 1] : undefined;
    if (parrafo === undefined) {
      errores.push(`Cita ${n}: la entrevista no tiene el párrafo ¶${enviada?.parrafo}; tiene ${entrevista.parrafos.length}.`);
      continue;
    }
    const fragmento = String(enviada?.texto ?? '');
    if (fragmento.replace(/\s/g, '').length < MINIMO_CARACTERES_CITA) {
      errores.push(`Cita ${n} (¶${numero}): el texto está vacío o es demasiado corto.`);
      continue;
    }
    const lugar = localizar(parrafo, fragmento);
    if (!lugar) {
      errores.push(
        `Cita ${n} (¶${numero}): ese texto no está en el párrafo. Cópialo tal cual del ¶${numero}, sin ` +
          `resumirlo ni corregirlo: «${fragmento.slice(0, 60)}${fragmento.length > 60 ? '…' : ''}».`,
      );
      continue;
    }
    const nombres = [];
    for (const nombre of enviada?.codigos ?? []) {
      const codigo = buscarCodigo(libro, nombre);
      if (!codigo) {
        errores.push(`Cita ${n} (¶${numero}): el código «${nombreLimpio(nombre)}» no existe; defínelo en "codigos".`);
      } else if (!nombres.includes(codigo.nombre)) {
        nombres.push(codigo.nombre);
      }
    }
    if (nombres.length === 0) {
      if ((enviada?.codigos ?? []).length === 0) errores.push(`Cita ${n} (¶${numero}): no tiene ningún código.`);
      continue;
    }
    citas.push({
      id: `c${siguiente}`,
      entrevista: entrevista.id,
      parrafo: numero,
      inicio: lugar.inicio,
      fin: lugar.fin,
      texto: lugar.texto,
      codigos: nombres,
    });
    siguiente += 1;
  }

  if (errores.length > 0) throw new CodificacionNoValida(errores);

  // La misma cita dos veces, con los mismos límites: una sola, con los códigos juntos.
  const unicas = [];
  for (const cita of citas) {
    const igual = unicas.find((u) => u.parrafo === cita.parrafo && u.inicio === cita.inicio && u.fin === cita.fin);
    if (igual) igual.codigos = [...new Set([...igual.codigos, ...cita.codigos])];
    else unicas.push(cita);
  }
  unicas.sort((a, b) => a.parrafo - b.parrafo || a.inicio - b.inicio);

  libro.citas = [...libro.citas.filter((c) => c.entrevista !== entrevista.id), ...unicas];
  libro.siguiente = siguiente;
  return { codificacion: libro, nuevos, citas: unicas };
}

/**
 * Cambia el nombre de un código en el libro y en todas sus citas. Si el nuevo
 * nombre ya es otro código, los junta: quedan las citas de los dos y la
 * definición del que ya existía.
 */
function renombrar(codificacion, de, a) {
  const libro = structuredClone(codificacion ?? vacia());
  const origen = buscarCodigo(libro, de);
  if (!origen) throw new CodificacionNoValida([`No hay ningún código «${nombreLimpio(de)}».`]);
  const nombre = nombreLimpio(a);
  if (!nombre || nombre.length > 80) throw new CodificacionNoValida(['El nombre nuevo está vacío o pasa de 80 caracteres.']);

  const viejo = origen.nombre;
  const destino = buscarCodigo(libro, nombre);
  const junta = destino !== null && destino !== origen;
  if (junta) {
    libro.codigos = libro.codigos.filter((c) => c !== origen);
  } else {
    origen.nombre = nombre;
  }
  const final = junta ? destino.nombre : nombre;
  for (const cita of libro.citas) {
    cita.codigos = [...new Set(cita.codigos.map((c) => (c === viejo ? final : c)))];
  }
  return { codificacion: libro, junto: junta, nombre: final };
}

/** Quita un código del libro y de las citas; las citas que se quedan sin código se van. */
function quitarCodigo(codificacion, nombre) {
  const libro = structuredClone(codificacion ?? vacia());
  const codigo = buscarCodigo(libro, nombre);
  if (!codigo) throw new CodificacionNoValida([`No hay ningún código «${nombreLimpio(nombre)}».`]);
  libro.codigos = libro.codigos.filter((c) => c !== codigo);
  const antes = libro.citas.length;
  libro.citas = libro.citas
    .map((c) => ({ ...c, codigos: c.codigos.filter((x) => x !== codigo.nombre) }))
    .filter((c) => c.codigos.length > 0);
  return { codificacion: libro, nombre: codigo.nombre, citasQuitadas: antes - libro.citas.length };
}

/** Las citas de una entrevista fuera: cuando se quita o se vuelve a subir. */
function sinEntrevista(codificacion, entrevistaId) {
  if (!codificacion) return null;
  return { ...codificacion, citas: codificacion.citas.filter((c) => c.entrevista !== entrevistaId) };
}

/**
 * El libro con sus cuentas: cuántas citas y en cuántas entrevistas tiene cada
 * código, agrupados por categoría.
 */
function resumen(codificacion) {
  const libro = codificacion ?? vacia();
  const codigos = libro.codigos.map((codigo) => {
    const suyas = libro.citas.filter((c) => c.codigos.includes(codigo.nombre));
    return {
      nombre: codigo.nombre,
      definicion: codigo.definicion,
      categoria: codigo.categoria,
      citas: suyas.length,
      entrevistas: new Set(suyas.map((c) => c.entrevista)).size,
    };
  });
  const porEntrevista = {};
  for (const cita of libro.citas) porEntrevista[cita.entrevista] = (porEntrevista[cita.entrevista] ?? 0) + 1;
  return { codigos, citas: libro.citas.length, porEntrevista };
}

module.exports = {
  codificar,
  renombrar,
  quitarCodigo,
  sinEntrevista,
  resumen,
  localizar,
  esqueletoConPosiciones,
  claveDe,
  CodificacionNoValida,
  MAXIMO_CODIGOS,
  MAXIMO_CITAS_POR_ENTREVISTA,
};
