'use strict';

/**
 * Las cuentas del análisis cualitativo: frecuencias y coocurrencia de códigos.
 *
 * Todo puro: recibe las entrevistas y la codificación y devuelve números y tablas
 * en Markdown, con el formato de tabla que ya entiende el Word (`project.docx`).
 * Claude las pega en el capítulo tal cual; así ninguna cifra la escribe él.
 *
 * LA COOCURRENCIA
 * ---------------
 * Dos códigos coocurren cuando se asignaron a la MISMA cita. Es la regla más
 * estricta y la que da los mismos números que ATLAS.ti cuando el tesista abre
 * el .qdpx allí. Con cada par van:
 *
 *   - n: cuántas citas llevan los dos;
 *   - c: el coeficiente c de ATLAS.ti, n12 / (n1 + n2 − n12), entre 0 (nunca
 *     juntos) y 1 (siempre juntos). Con pocas citas engaña, y así se dice en la
 *     nota de la tabla.
 */

/** Entre los dos nombres de un par: un carácter que ningún nombre de código trae. */
const SEPARADOR = String.fromCharCode(0);

/** Lo que ordena al final a los códigos sin categoría. */
const AL_FINAL = String.fromCharCode(65535);

/** Cuántas filas de coocurrencia van en la tabla: más no se leen en una página. */
const MAXIMO_PARES = 20;
/** A partir de aquí el libro ya no se lee de un vistazo ni cabe en una red. */
const MAXIMO_CODIGOS_COMODOS = 30;

/** Hasta cuántas entrevistas van como columnas en la tabla de frecuencias. */
const MAXIMO_COLUMNAS = 8;

/** Un decimal con coma y dos cifras: 0,43. */
const coeficiente = (valor) => valor.toFixed(2).replace('.', ',');

/** «|» dentro de una celda la partiría: se escapa. */
const celda = (texto) => String(texto).replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

const fila = (celdas) => `| ${celdas.map(celda).join(' | ')} |`;

function tablaMarkdown({ titulo, cabecera, filas, nota }) {
  return [
    '**Tabla X**',
    `*${titulo}*`,
    fila(cabecera),
    `|${cabecera.map(() => '---').join('|')}|`,
    ...filas.map(fila),
    `*Nota.* ${nota}`,
  ].join('\n');
}

/**
 * Por código: cuántas citas tiene, en cuántas entrevistas aparece y cuántas en
 * cada una. Ordenados por categoría y, dentro, de más a menos citas.
 */
function frecuencias(entrevistas, codificacion) {
  const citas = codificacion?.citas ?? [];
  const codigos = (codificacion?.codigos ?? []).map((codigo) => {
    const suyas = citas.filter((c) => c.codigos.includes(codigo.nombre));
    const porEntrevista = Object.fromEntries(
      entrevistas.map((e) => [e.id, suyas.filter((c) => c.entrevista === e.id).length]),
    );
    return {
      nombre: codigo.nombre,
      categoria: codigo.categoria ?? null,
      citas: suyas.length,
      entrevistas: Object.values(porEntrevista).filter((n) => n > 0).length,
      porEntrevista,
    };
  });
  const categoria = (c) => c.categoria ?? AL_FINAL;
  codigos.sort(
    (a, b) => categoria(a).localeCompare(categoria(b), 'es') || b.citas - a.citas || a.nombre.localeCompare(b.nombre, 'es'),
  );
  return codigos;
}

/** Los pares de códigos que comparten alguna cita, de más a menos. */
function coocurrencias(codificacion) {
  const citas = codificacion?.citas ?? [];
  const porCodigo = new Map();
  for (const cita of citas) for (const c of cita.codigos) porCodigo.set(c, (porCodigo.get(c) ?? 0) + 1);

  const pares = new Map();
  for (const cita of citas) {
    const lista = [...new Set(cita.codigos)].sort((a, b) => a.localeCompare(b, 'es'));
    for (let i = 0; i < lista.length; i += 1) {
      for (let j = i + 1; j < lista.length; j += 1) {
        const clave = `${lista[i]}${SEPARADOR}${lista[j]}`;
        pares.set(clave, (pares.get(clave) ?? 0) + 1);
      }
    }
  }

  return [...pares]
    .map(([clave, n]) => {
      const [a, b] = clave.split(SEPARADOR);
      const n1 = porCodigo.get(a);
      const n2 = porCodigo.get(b);
      return { a, b, n, c: n / (n1 + n2 - n) };
    })
    .sort((x, y) => y.n - x.n || y.c - x.c || x.a.localeCompare(y.a, 'es'));
}

/** La tabla de frecuencias en Markdown. Null si no hay nada codificado. */
function tablaDeFrecuencias(entrevistas, codificacion) {
  const lista = frecuencias(entrevistas, codificacion).filter((c) => c.citas > 0);
  if (lista.length === 0) return null;

  const conCategorias = lista.some((c) => c.categoria);
  const porColumnas = entrevistas.length <= MAXIMO_COLUMNAS;
  const cabecera = [
    ...(conCategorias ? ['Categoría'] : []),
    'Código',
    ...(porColumnas ? entrevistas.map((e) => e.id) : []),
    'Citas',
    'Entrevistas',
  ];
  let anterior = null;
  const filas = lista.map((c) => {
    // La categoría solo en su primera fila, como en las tablas de resultados cualitativos.
    const cat = c.categoria ?? 'Sin categoría';
    const mostrar = cat === anterior ? '' : cat;
    anterior = cat;
    return [
      ...(conCategorias ? [mostrar] : []),
      c.nombre,
      ...(porColumnas ? entrevistas.map((e) => String(c.porEntrevista[e.id])) : []),
      String(c.citas),
      `${c.entrevistas} de ${entrevistas.length}`,
    ];
  });

  const total = (codificacion?.citas ?? []).length;
  return tablaMarkdown({
    titulo: 'Frecuencia de los códigos por entrevista',
    cabecera,
    filas,
    nota:
      `Citas: fragmentos de las transcripciones asignados al código; una cita puede llevar más de un ` +
      `código. Total de citas codificadas: ${total}.` +
      (porColumnas ? ` ${entrevistas.map((e) => `${e.id}: ${e.nombre}`).join('; ')}.` : ''),
  });
}

/** La tabla de coocurrencia en Markdown. Null si ningún par comparte cita. */
function tablaDeCoocurrencia(codificacion) {
  const pares = coocurrencias(codificacion);
  if (pares.length === 0) return null;
  const mostrados = pares.slice(0, MAXIMO_PARES);
  return tablaMarkdown({
    titulo: 'Coocurrencia de códigos en las mismas citas',
    cabecera: ['Código', 'Código', 'Coocurrencias', 'Coeficiente c'],
    filas: mostrados.map((p) => [p.a, p.b, String(p.n), coeficiente(p.c)]),
    nota:
      'Dos códigos coocurren cuando se asignaron al mismo fragmento de la entrevista. El coeficiente c ' +
      'es n12 / (n1 + n2 − n12): 0 si nunca aparecen juntos y 1 si siempre lo hacen; con pocas citas ' +
      'debe leerse con cautela.' +
      (pares.length > MAXIMO_PARES ? ` Se muestran los ${MAXIMO_PARES} pares más frecuentes de ${pares.length}.` : ''),
  });
}

/**
 * Lo que hay que decirle a Claude del libro, o null si está bien.
 *
 * Los dos vicios de la codificación asistida, y los dos se ven en la red: un
 * código por cada matiz, y una sola etiqueta por cita. Sin citas con dos
 * códigos no hay coocurrencia, y la red queda en puntos sueltos.
 */
function avisos(codificacion) {
  const libro = codificacion ?? { codigos: [], citas: [] };
  const dichos = [];

  if (libro.codigos.length > MAXIMO_CODIGOS_COMODOS) {
    const sueltos = libro.codigos.filter(
      (c) => libro.citas.filter((cita) => cita.codigos.includes(c.nombre)).length === 1,
    ).length;
    dichos.push(
      `El libro tiene ${libro.codigos.length} códigos, y por encima de ${MAXIMO_CODIGOS_COMODOS} ni la tabla ni la red se leen` +
        (sueltos > 0 ? `; ${sueltos} tienen una sola cita` : '') +
        '. Proponle al usuario juntar los que dicen lo mismo con "renombrar".',
    );
  }

  const conVarios = libro.citas.filter((c) => c.codigos.length > 1).length;
  if (libro.citas.length >= 10 && conVarios < libro.citas.length / 5) {
    dichos.push(
      `Solo ${conVarios} de ${libro.citas.length} citas llevan más de un código, así que casi no hay ` +
        'coocurrencia y la red sale en puntos sueltos. Cuando un fragmento habla de dos cosas —el asesor ' +
        'que no responde Y la ayuda que busca fuera—, ponle los dos códigos. Revísalo con el usuario y ' +
        'vuelve a codificar las entrevistas que haga falta.',
    );
  }

  return dichos.length > 0 ? dichos : null;
}

module.exports = {
  frecuencias,
  coocurrencias,
  avisos,
  MAXIMO_CODIGOS_COMODOS,
  tablaDeFrecuencias,
  tablaDeCoocurrencia,
  coeficiente,
  MAXIMO_PARES,
  MAXIMO_COLUMNAS,
};
