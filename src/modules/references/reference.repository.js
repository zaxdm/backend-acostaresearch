'use strict';

const { randomUUID } = require('node:crypto');
const prisma = require('../../lib/prisma');
const { normalizar } = require('./zotero.mapper');

/** Etiquetas de Zotero que significan «esta fuente es de este producto». */
const ETIQUETAS_DE_PRODUCTO = {
  tesis: 'METODO_9_SKILLS',
  articulo: 'ARTICULO_SCIENTIFICOS',
  articulos: 'ARTICULO_SCIENTIFICOS',
};

/**
 * Cuántas filas van en cada sentencia.
 *
 * Con 24.000 fuentes, escribirlas de una en una son 24.000 idas y vueltas a una
 * base que está en otro proveedor: horas. En lotes de 200 son 120 sentencias y
 * unos segundos. No sube más porque cada fila lleva catorce valores, y las
 * sentencias enormes empeoran el tiempo de análisis del servidor.
 */
const POR_LOTE = 200;

const COLUMNAS = [
  'id',
  'zoteroKey',
  'version',
  'itemType',
  'title',
  'authors',
  'year',
  'source',
  'doi',
  'url',
  'abstract',
  'notes',
  'tags',
  'busqueda',
];

/**
 * A qué productos pertenece una fuente, según sus etiquetas de Zotero.
 *
 * Devolver una lista vacía es lo normal y lo correcto: una fuente sin etiqueta
 * de producto la ven todas las licencias. En una biblioteca de trabajo real,
 * donde las etiquetas son las palabras clave que trae cada artículo de Scopus,
 * esto sale vacío casi siempre, y así debe ser. Ver `ReferenceGroup`.
 */
function gruposDeEtiquetas(etiquetas = []) {
  const codigos = new Set();
  for (const etiqueta of etiquetas) {
    const codigo = ETIQUETAS_DE_PRODUCTO[String(etiqueta).trim().toLowerCase()];
    if (codigo) codigos.add(codigo);
  }
  return [...codigos];
}

/** El marcador de sincronización. Siempre la fila 1; se crea si no está. */
async function estadoSync() {
  return prisma.referenceSync.upsert({ where: { id: 1 }, update: {}, create: { id: 1 } });
}

function guardarSync({ libraryVersion, lastCount }) {
  return prisma.referenceSync.update({
    where: { id: 1 },
    data: { libraryVersion, lastCount, lastRunAt: new Date() },
  });
}

/**
 * Horas tras las cuales se da por muerto un cerrojo y se puede pisar.
 *
 * Una pasada completa de 48.000 fuentes ronda los veinte minutos. Tres horas
 * son de sobra para la más lenta y lo bastante poco para que un proceso que
 * murió a media noche no bloquee la sincronización del día siguiente.
 */
const TURNO_CADUCA_HORAS = 3;

/**
 * Toma el turno para sincronizar, si no lo tiene nadie.
 *
 * Es un UPDATE condicional a propósito: leer y luego escribir deja un hueco
 * entre las dos operaciones por el que se cuelan dos procesos a la vez. Así la
 * decisión la toma MySQL en una sola sentencia, y el que llega segundo ve cero
 * filas cambiadas.
 *
 * Devuelve `true` solo si lo consiguió. Quien lo consigue está OBLIGADO a
 * soltarlo, pase lo que pase.
 */
async function tomarElTurno() {
  await estadoSync();

  const cambiadas = await prisma.$executeRaw`
    UPDATE reference_sync
       SET runningSince = NOW(3)
     WHERE id = 1
       AND (runningSince IS NULL
            OR runningSince < DATE_SUB(NOW(3), INTERVAL ${TURNO_CADUCA_HORAS} HOUR))
  `;

  return cambiadas === 1;
}

function soltarElTurno() {
  return prisma.referenceSync.update({ where: { id: 1 }, data: { runningSince: null } });
}

/**
 * Guarda un lote de fuentes.
 *
 * Va en SQL crudo y no por Prisma porque `upsert` no sabe hacer esto en una
 * sentencia: haría una lectura y una escritura por fila. `ON DUPLICATE KEY`
 * resuelve las dos cosas de golpe contra el índice único de `zoteroKey`, que es
 * la identidad de una fuente.
 *
 * El `id` que se genera aquí solo se usa si la fila es nueva: al chocar con una
 * existente, MySQL se queda con el suyo y este se descarta. Por eso los grupos
 * se escriben aparte, releyendo el identificador de verdad.
 */
async function guardarLote(filas) {
  if (filas.length === 0) return 0;

  const columnas = COLUMNAS.map((c) => '`' + c + '`').join(', ');
  const hueco = '(' + COLUMNAS.map(() => '?').join(', ') + ', NOW(3), NOW(3))';

  // `notes` NO se pisa, y `busqueda` se rearma con las notas que ya había.
  //
  // Esta pasada trae las fuentes sin sus notas —las notas son ítems aparte y
  // llegan en la segunda—, así que escribir aquí lo que trae dejaría a cero las
  // de una fuente que se modificó sin tocar su nota: la segunda pasada tampoco
  // la traería, porque a Zotero solo se le pide lo que cambió. En un incremental
  // eso se come, en silencio, justo lo que más valor tiene del corpus.
  const actualiza = COLUMNAS.filter(
    (c) => c !== 'id' && c !== 'zoteroKey' && c !== 'notes' && c !== 'busqueda',
  )
    .map((c) => '`' + c + '` = VALUES(`' + c + '`)')
    .join(', ');

  // Sin asignar, `notes` dentro de la expresión es el valor que ya estaba.
  const rearmaBusqueda = "`busqueda` = CONCAT(VALUES(`busqueda`), ' ', COALESCE(`notes`, ''))";

  const sql =
    'INSERT INTO `references` (' + columnas + ', `createdAt`, `updatedAt`) VALUES ' +
    filas.map(() => hueco).join(', ') +
    ' ON DUPLICATE KEY UPDATE ' + actualiza + ', ' + rearmaBusqueda + ', `updatedAt` = NOW(3)';

  const valores = filas.flatMap((fila) => [
    randomUUID(),
    fila.zoteroKey,
    fila.version,
    fila.itemType,
    fila.title,
    fila.authors,
    fila.year,
    fila.source,
    fila.doi,
    fila.url,
    fila.abstract,
    fila.notes,
    fila.tags,
    fila.busqueda,
  ]);

  await prisma.$executeRawUnsafe(sql, ...valores);
  return filas.length;
}

/**
 * Escribe a qué productos pertenece cada fuente etiquetada.
 *
 * Solo se llama con las que llevan etiqueta de producto, que son pocas: releer
 * los identificadores de las 24.000 en cada pasada costaría más que todo lo
 * demás junto, y para nada, porque la inmensa mayoría no pertenece a ninguna
 * ruta concreta.
 */
async function escribirGrupos(porClave) {
  const claves = Object.keys(porClave);
  if (claves.length === 0) return;

  const filas = await prisma.reference.findMany({
    where: { zoteroKey: { in: claves } },
    select: { id: true, zoteroKey: true },
  });

  await prisma.referenceGroup.deleteMany({
    where: { referenceId: { in: filas.map((f) => f.id) } },
  });

  const nuevas = filas.flatMap((fila) =>
    (porClave[fila.zoteroKey] ?? []).map((productCode) => ({ referenceId: fila.id, productCode })),
  );

  if (nuevas.length > 0) {
    await prisma.referenceGroup.createMany({ data: nuevas, skipDuplicates: true });
  }
}

/**
 * Pega a cada fuente las notas que cuelgan de ella.
 *
 * Se relee la fila y se recompone la columna de búsqueda entera, en vez de
 * añadir el texto al que ya había. Añadir parece más barato, pero una nota
 * corregida en Zotero dejaría las dos versiones dentro, y sincronizar dos veces
 * iría engordando la columna con el mismo texto repetido.
 */
async function aplicarNotas(porClavePadre) {
  const claves = Object.keys(porClavePadre);
  if (claves.length === 0) return 0;

  const padres = await prisma.reference.findMany({
    where: { zoteroKey: { in: claves } },
    select: {
      id: true,
      zoteroKey: true,
      title: true,
      authors: true,
      source: true,
      year: true,
      abstract: true,
      tags: true,
    },
  });

  const escrituras = padres.map((padre) => {
    const notas = porClavePadre[padre.zoteroKey].join('\n\n');
    const busqueda = normalizar(
      [padre.title, padre.authors, padre.source, padre.year, padre.abstract, notas, padre.tags]
        .filter(Boolean)
        .join(' '),
    );
    return prisma.reference.update({ where: { id: padre.id }, data: { notes: notas, busqueda } });
  });

  // Una sola ida y vuelta para las cien de la página, en vez de cien.
  await prisma.$transaction(escrituras);
  return escrituras.length;
}

function borrarPorClaves(claves) {
  if (claves.length === 0) return { count: 0 };
  // Acotado al fondo de la casa. Hoy lo importado lleva `zoteroKey` nulo y no
  // podría coincidir, pero esto se ejecuta en la fase de retiradas de cada
  // sincronización y borra sin preguntar: el día que una fuente importada tenga
  // clave por lo que sea, la diferencia entre estas dos versiones es que una se
  // lleva por delante la biblioteca de un tesista y la otra no.
  return prisma.reference.deleteMany({ where: { zoteroKey: { in: claves }, ownerUserId: null } });
}

/** Solo el fondo de la casa: es lo que enseña el panel del administrador. */
const contar = () => prisma.reference.count({ where: { ownerUserId: null } });

/**
 * Busca en el corpus.
 *
 * Usa el índice de texto completo, no un LIKE. Con 24.000 fuentes —y creciendo
 * cada vez que se exporta una búsqueda de Scopus— un LIKE recorre la tabla
 * entera en cada pregunta que hace un tesista desde Claude, y eso se nota
 * dentro de la conversación.
 *
 * Cada palabra lleva `+` y `*`: todas tienen que aparecer, y valen sus plurales
 * y derivadas. Con OR llegaría media biblioteca —«validez» sale en casi todo lo
 * metodológico— y ninguna de las buenas quedaría arriba.
 *
 * Si el índice no devuelve nada se reintenta con LIKE. No es redundancia: el
 * buscador de texto completo tiene su propia lista de palabras vacías y un
 * mínimo de longitud, y es preferible una respuesta lenta a una biblioteca que
 * parece vacía.
 */
/**
 * Quita el mismo artículo repetido.
 *
 * La biblioteca se llenó exportando búsquedas de Scopus, y dos búsquedas
 * distintas devuelven artículos en común: el mismo trabajo entra otra vez, con
 * otra clave de Zotero, y para la base son dos fuentes. No es un fallo de la
 * sincronización —en Zotero también están los dos— pero en una respuesta de seis
 * resultados, dos gastados en repetir el mismo artículo son dos que el tesista
 * no recibe. El propio asistente lo notó antes que nosotros.
 *
 * El DOI es la identidad real de un artículo. Sin DOI se compara el título, que
 * es lo único que queda.
 */
function sinRepetidos(filas, limite) {
  const vistos = new Set();
  const unicas = [];

  for (const fila of filas) {
    const identidad = fila.doi
      ? 'doi:' + String(fila.doi).toLowerCase()
      : 'titulo:' + normalizar(fila.title).replace(/[^a-z0-9]/g, '');

    if (vistos.has(identidad)) continue;
    vistos.add(identidad);
    unicas.push(fila);
    if (unicas.length >= limite) break;
  }

  return unicas;
}

async function buscar({ palabras, productCode, ownerUserId = null, limite = 8 }) {
  // Una fuente sin grupos la ven todas las licencias; con grupos, solo las de
  // su producto. Es el mismo criterio que el catálogo de capítulos.
  const filtroProducto = productCode
    ? 'AND (NOT EXISTS (SELECT 1 FROM `reference_groups` g WHERE g.referenceId = r.id) ' +
      'OR EXISTS (SELECT 1 FROM `reference_groups` g WHERE g.referenceId = r.id ' +
      'AND g.productCode = ?)) '
    : '';

  // EL FILTRO QUE NO PUEDE FALLAR.
  //
  // El fondo de la casa lleva `ownerUserId` nulo y lo ve todo el mundo; lo que
  // sube un comprador solo lo ve él. Sin la segunda mitad de esta condición, la
  // búsqueda de un tesista devolvería las fuentes que subió otro, que es lo
  // único de este módulo que no admite un fallo.
  //
  // Va escrito así —y no como un parámetro opcional que se pueda olvidar— para
  // que quien lea la consulta vea la regla entera de un vistazo.
  const filtroDueño = ownerUserId
    ? 'AND (r.ownerUserId IS NULL OR r.ownerUserId = ?) '
    : 'AND r.ownerUserId IS NULL ';

  /**
   * Dos formas de preguntar lo mismo, y se usan en este orden.
   *
   * ESTRICTA: `+cada* +palabra*` exige TODAS. Es la buena cuando acierta, porque
   * lo que devuelve va del tema y no de una palabra suelta.
   *
   * FLOJA: sin los `+`, MySQL trata las palabras como opcionales y puntúa por
   * cuántas y cuáles aparecen. Devuelve de más, así que solo se usa si la
   * estricta se queda a cero.
   *
   * POR QUÉ HACE FALTA LA SEGUNDA
   * -----------------------------
   * Con las 24.000 fichas del fondo de la casa, exigirlas todas se sostiene:
   * siempre hay algo que cumple. Con las trescientas que sube un tesista, no.
   * Un tesista pide «employability of computer science graduates» —cuatro
   * palabras— contra cinco fuentes suyas de las que ninguna lleva las cuatro, y
   * la biblioteca responde cero pese a tener justo lo que buscaba.
   *
   * Y ese cero no es inofensivo: el conector sale entonces al catálogo abierto y
   * le sirve fuentes SIN REVISAR, avisándole de que las verifique, teniendo en
   * casa las que él mismo eligió. Es el peor desenlace posible del producto, y
   * ocurría por una palabra de cuatro.
   */
  const consultaEstricta = palabras.map((palabra) => '+' + palabra + '*').join(' ');
  const consultaFloja = palabras.map((palabra) => palabra + '*').join(' ');

  // La expresión va dos veces: una para filtrar y otra para puntuar. Ordenar
  // solo por año devolvía lo más reciente de entre lo que coincidía, y con seis
  // resultados eso no es lo mismo que lo mejor: un artículo de 2027 que roza el
  // tema desplazaba al de 2019 que va justo de eso. El año sigue contando, pero
  // por detrás de la relevancia.
  // Se piden más de las que se van a devolver porque después se quitan las
  // repetidas: con el límite justo, una respuesta de seis podría quedarse en
  // tres. El triple cubre de sobra lo que se ha visto duplicado.
  const margen = limite * 3;

  const porIndice = (consulta) =>
    prisma.$queryRawUnsafe(
      'SELECT r.*, MATCH(r.busqueda) AGAINST (? IN BOOLEAN MODE) AS relevancia ' +
        'FROM `references` r ' +
        'WHERE MATCH(r.busqueda) AGAINST (? IN BOOLEAN MODE) ' +
        filtroProducto +
        filtroDueño +
        // Las suyas primero: es su tema y las eligió él. Después las de la casa,
        // que llevan nota. Dentro de cada grupo manda la relevancia.
        'ORDER BY (r.ownerUserId IS NULL), relevancia DESC, r.year DESC LIMIT ?',
      consulta,
      consulta,
      ...(productCode ? [productCode] : []),
      ...(ownerUserId ? [ownerUserId] : []),
      margen,
    );

  const exactas = await porIndice(consultaEstricta);
  if (exactas.length > 0) return sinRepetidos(exactas, limite);

  // Nada cumplía con todas. Se repite pidiendo menos ANTES de darse por vencido:
  // el siguiente paso, arriba en el conector, es salir al catálogo abierto, y
  // hacerlo teniendo fuentes propias sin usar sería el peor cambio posible.
  //
  // Solo con dos palabras o más. Con una sola, la floja y la estricta preguntan
  // lo mismo y esto sería repetir la consulta para nada.
  if (palabras.length > 1) {
    const aproximadas = await porIndice(consultaFloja);

    // DOS PALABRAS COMO MÍNIMO, y esta es la línea que separa «aflojar» de
    // «devolver cualquier cosa».
    //
    // Sin ella, «employability of computer science graduates» daría por buena
    // una fuente cuyo único parecido es la palabra «science», y el tesista
    // recibiría como pertinente algo que no lo es. Peor que no encontrar nada:
    // cuando la biblioteca dice que no hay, él lo sabe y busca en otro lado;
    // cuando le da un resultado malo, se lo cree.
    //
    // Se cuenta aquí y no en SQL porque MySQL no sabe exigir «al menos N de
    // estas» en modo booleano, y contar sobre las filas que ya volvieron es
    // exacto y cuesta nada: son como mucho tres docenas.
    const suficientes = aproximadas.filter((fila) => {
      const texto = fila.busqueda ?? '';
      return palabras.filter((palabra) => texto.includes(palabra)).length >= 2;
    });

    if (suficientes.length > 0) return sinRepetidos(suficientes, limite);
  }

  const porTexto = await prisma.reference.findMany({
    where: {
      AND: [
        ...palabras.map((palabra) => ({ busqueda: { contains: palabra } })),
        productCode
          ? { OR: [{ groups: { none: {} } }, { groups: { some: { productCode } } }] }
          : {},
        // La misma regla de dueño que arriba. Este camino es el de reserva
        // —cuando el índice de texto completo no encuentra nada— y saltárselo
        // aquí filtraría bien en la consulta rápida y mal en la lenta.
        ownerUserId ? { OR: [{ ownerUserId: null }, { ownerUserId }] } : { ownerUserId: null },
      ],
    },
    orderBy: [{ ownerUserId: 'desc' }, { year: 'desc' }, { title: 'asc' }],
    take: margen,
  });

  return sinRepetidos(porTexto, limite);
}

/**
 * Las fuentes de una lista de claves de cita.
 *
 * El filtro de dueño es el mismo que en la búsqueda y por el mismo motivo: el
 * fondo de la casa lo ve todo el mundo, y lo que subió un comprador solo lo ve
 * él. Aquí la clave la escribe el asistente en el texto, así que hay que
 * comprobarlo igual —adivinar ocho caracteres es improbable, no imposible, y
 * «improbable» no es un permiso—.
 */
function porClaves(claves, ownerUserId = null) {
  if (claves.length === 0) return Promise.resolve([]);

  return prisma.reference.findMany({
    where: {
      ref: { in: claves },
      OR: ownerUserId ? [{ ownerUserId: null }, { ownerUserId }] : [{ ownerUserId: null }],
    },
    select: {
      ref: true,
      title: true,
      authors: true,
      year: true,
      source: true,
      doi: true,
      url: true,
    },
  });
}

/** Lo que enseña el panel: página a página, con el buscador del administrador. */
async function listarParaPanel({ pagina = 1, tamano = 20, texto = '' }) {
  const where = texto ? { busqueda: { contains: texto } } : {};

  const [total, filas] = await Promise.all([
    prisma.reference.count({ where }),
    prisma.reference.findMany({
      where,
      orderBy: [{ year: 'desc' }, { title: 'asc' }],
      skip: (pagina - 1) * tamano,
      take: tamano,
      include: { groups: { select: { productCode: true } } },
    }),
  ]);

  return { total, filas, pagina, tamano };
}

module.exports = {
  POR_LOTE,
  gruposDeEtiquetas,
  sinRepetidos,
  estadoSync,
  guardarSync,
  tomarElTurno,
  soltarElTurno,
  guardarLote,
  escribirGrupos,
  aplicarNotas,
  borrarPorClaves,
  contar,
  buscar,
  porClaves,
  listarParaPanel,
};
