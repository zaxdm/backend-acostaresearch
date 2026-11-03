'use strict';

/**
 * El autor lee lo que cita.
 *
 * EL PROBLEMA
 * -----------
 * `revisar_evidencia` dice si una frase tiene una fuente detrás, y las claves
 * [AR…] garantizan que esa fuente existe. Ninguna de las dos cosas dice si la
 * fuente afirma lo que la frase le atribuye. Eso no lo puede comprobar un
 * programa (ver `project.evidencia`), y tampoco debe darlo por bueno Claude: un
 * modelo que lee un resumen y contesta «sí, lo dice» es la misma máquina que
 * escribió la frase.
 *
 * Lo comprueba el AUTOR. Aquí se le pone delante, cita por cita, lo que su
 * texto le atribuye a cada fuente, junto con lo necesario para ir a leerla —el
 * enlace, la página si la cita la lleva, el resumen— y se guarda lo que él
 * responde: «lo dice», «no lo dice» o «no pude leerla».
 *
 * POR CAPÍTULO Y CON HUELLA
 * -------------------------
 * Se verifica la pareja capítulo + fuente, no la fuente sola: la misma fuente
 * puede sostener bien una frase de la introducción y mal otra de la discusión.
 * Y cada confirmación lleva la huella de las frases que el autor vio: si
 * después se reescriben, la huella deja de casar y la cita vuelve a pedir
 * lectura. Confirmar una frase no confirma la que la sustituya.
 */

const crypto = require('node:crypto');
const { MARCA, modificadoresDe } = require('./project.citas');
const { frasesDe } = require('./project.evidencia');

/** Lo que el autor puede responder. */
const ESTADOS = ['lo_dice', 'no_lo_dice', 'no_pude_leer'];

/** Cómo se dice cada estado en la respuesta del conector. */
const NOMBRE_ESTADO = {
  lo_dice: 'verificada por el autor',
  no_lo_dice: 'el autor dice que la fuente NO dice eso',
  no_pude_leer: 'el autor no pudo leerla',
  pendiente: 'sin verificar',
  cambio: 'el texto cambió desde que la verificó',
  sin_ficha: 'la clave no corresponde a ninguna fuente',
};

/** Qué estados obligan a hacer algo antes de entregar. */
const PENDIENTES = new Set(['pendiente', 'cambio', 'no_pude_leer']);

function normalizar(frase) {
  return frase.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** La huella de lo que el autor tuvo delante al confirmar. */
function huellaDe(frases) {
  const base = [...frases].map(normalizar).sort().join('\n');
  return crypto.createHash('sha1').update(base).digest('hex').slice(0, 16);
}

/** Identificador de una pareja capítulo + fuente en el registro. */
const idDe = (capitulo, clave) => `${capitulo}:${clave}`;

/**
 * Cada fuente citada en cada capítulo, con las frases donde se cita y su estado.
 *
 * `capitulos`: [{ code, titulo, texto }]. `porClave`: fuentes por clave.
 * `registro`: lo que el autor ya confirmó, `{ "capitulo:clave": { estado, huella, fecha, nota } }`.
 */
function inventario(capitulos, porClave = new Map(), registro = {}) {
  const items = [];

  for (const capitulo of capitulos) {
    const porFuente = new Map();

    for (const frase of frasesDe(capitulo.texto ?? '')) {
      if (/^\s*#{1,6}\s/.test(frase)) continue;
      for (const m of frase.matchAll(MARCA)) {
        const clave = m[1].toUpperCase();
        if (!porFuente.has(clave)) porFuente.set(clave, { frases: [], paginas: new Set() });
        const entrada = porFuente.get(clave);
        if (!entrada.frases.includes(frase)) entrada.frases.push(frase);
        const pagina = modificadoresDe(m[2]).localizador;
        if (pagina) entrada.paginas.add(pagina);
      }
    }

    for (const [clave, { frases, paginas }] of porFuente) {
      const fuente = porClave.get(clave) ?? null;
      const huella = huellaDe(frases);
      const previo = registro[idDe(capitulo.code, clave)];

      let estado;
      if (!fuente) estado = 'sin_ficha';
      else if (!previo) estado = 'pendiente';
      else if (previo.huella !== huella) estado = 'cambio';
      else estado = previo.estado;

      items.push({
        capitulo: capitulo.code,
        tituloCapitulo: capitulo.titulo ?? capitulo.code,
        clave,
        fuente,
        frases,
        paginas: [...paginas],
        huella,
        estado,
        nota: previo && previo.huella === huella ? previo.nota ?? null : null,
        fecha: previo && previo.huella === huella ? previo.fecha ?? null : null,
      });
    }
  }

  return items;
}

/** Cuántas hay en cada estado. */
function recuento(items) {
  const cuenta = { total: items.length, lo_dice: 0, no_lo_dice: 0, no_pude_leer: 0, pendiente: 0, cambio: 0, sin_ficha: 0 };
  for (const item of items) cuenta[item.estado] += 1;
  cuenta.porLeer = cuenta.pendiente + cuenta.cambio + cuenta.no_pude_leer;
  return cuenta;
}

/**
 * Orden en que se le enseñan al autor: lo que está mal primero, después lo que
 * cambió, y al final lo nuevo, capítulo a capítulo.
 */
const PRIORIDAD = { sin_ficha: 0, no_lo_dice: 1, cambio: 2, pendiente: 3, no_pude_leer: 4, lo_dice: 5 };

function porRevisar(items) {
  return items
    .filter((i) => i.estado !== 'lo_dice')
    .sort((a, b) => PRIORIDAD[a.estado] - PRIORIDAD[b.estado]);
}

/**
 * Guarda lo que respondió el autor.
 *
 * Solo se acepta una confirmación de una cita que existe AHORA en el texto, y
 * se guarda con la huella de las frases de ahora: la que el autor tuvo delante.
 * Devuelve el registro nuevo y lo que no se pudo aplicar, con el motivo.
 */
function aplicar(registro, confirmaciones, items, ahora = new Date()) {
  const nuevo = { ...registro };
  const aplicadas = [];
  const rechazadas = [];

  for (const c of confirmaciones ?? []) {
    const clave = String(c.clave ?? '').trim().replace(/^\[|\]$/g, '').toUpperCase();
    const estado = String(c.estado ?? '').trim();

    if (!ESTADOS.includes(estado)) {
      rechazadas.push({ ...c, motivo: `estado desconocido; usa ${ESTADOS.join(', ')}` });
      continue;
    }

    const candidatos = items.filter(
      (i) => i.clave === clave && (!c.capitulo || i.capitulo === c.capitulo),
    );

    if (candidatos.length === 0) {
      rechazadas.push({ ...c, motivo: 'esa cita no está en el texto guardado de ese capítulo' });
      continue;
    }
    if (!c.capitulo && candidatos.length > 1) {
      rechazadas.push({
        ...c,
        motivo:
          `se cita en ${candidatos.length} capítulos (${candidatos.map((i) => i.capitulo).join(', ')}); ` +
          'di en cuál, porque en cada uno se le atribuye algo distinto',
      });
      continue;
    }

    const item = candidatos[0];
    if (item.estado === 'sin_ficha') {
      rechazadas.push({ ...c, motivo: 'la clave no corresponde a ninguna fuente: no hay nada que leer' });
      continue;
    }

    const nota = c.nota ? String(c.nota).slice(0, 400) : null;
    nuevo[idDe(item.capitulo, item.clave)] = { estado, huella: item.huella, fecha: ahora.toISOString(), nota };
    aplicadas.push({ capitulo: item.capitulo, clave: item.clave, estado });
  }

  return { registro: nuevo, aplicadas, rechazadas };
}

/** Dónde leerla. El DOI primero: es el que no caduca. */
function enlaceDe(fuente) {
  if (!fuente) return null;
  if (fuente.doi) return `https://doi.org/${String(fuente.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')}`;
  if (fuente.url) return fuente.url;
  return null;
}

function recortar(texto, largo) {
  const limpio = String(texto ?? '').replace(/\s+/g, ' ').trim();
  return limpio.length <= largo ? limpio : `${limpio.slice(0, largo).trimEnd()}…`;
}

/** Una cita, como se le enseña al autor. */
function ficha(item, n) {
  const f = item.fuente;
  const lineas = [`[${n}] ${item.tituloCapitulo} · [${item.clave}] · ${NOMBRE_ESTADO[item.estado]}`];

  if (!f) {
    lineas.push('    Esta clave no sale de ninguna ficha: no se puede leer porque no se sabe qué es.');
  } else {
    const anio = f.year ? ` (${f.year})` : '';
    lineas.push(`    Fuente: ${recortar(f.authors, 160)}${anio}. ${recortar(f.title, 220)}.${f.source ? ` ${recortar(f.source, 120)}.` : ''}`);
    const enlace = enlaceDe(f);
    lineas.push(
      enlace
        ? `    Para leerla: ${enlace}`
        : `    Sin enlace: búscala por el título en https://scholar.google.com/scholar?q=${encodeURIComponent(f.title ?? '')}`,
    );
    if (item.paginas.length > 0) lineas.push(`    Página que cita el texto: ${item.paginas.join(', ')}`);
    if (f.abstract) lineas.push(`    Resumen (orienta, no sustituye la lectura): «${recortar(f.abstract, 700)}»`);
    else lineas.push('    No tenemos su resumen: hay que abrirla.');
    if (f.notes) lineas.push(`    Nota de Acosta sobre esta fuente: «${recortar(f.notes, 300)}»`);
  }

  lineas.push(`    Lo que el texto le atribuye (${item.frases.length}):`);
  for (const frase of item.frases.slice(0, 4)) lineas.push(`      · «${recortar(frase, 320)}»`);
  if (item.frases.length > 4) lineas.push(`      · …y ${item.frases.length - 4} frases más en este capítulo.`);
  if (item.nota) lineas.push(`    Nota del autor: ${item.nota}`);

  return lineas.join('\n');
}

module.exports = {
  ESTADOS,
  NOMBRE_ESTADO,
  PENDIENTES,
  inventario,
  recuento,
  porRevisar,
  aplicar,
  ficha,
  enlaceDe,
  huellaDe,
};
