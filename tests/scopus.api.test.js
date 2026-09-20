'use strict';

/**
 * Scopus por API: de la ficha de Elsevier a la biblioteca del tesista.
 *
 * Seis cosas tienen que ser ciertas, y son las seis que se pueden romper sin
 * que salte nada evidente:
 *
 *   · Una fuente traída por la API y la misma subida dentro de un CSV son UNA
 *     fila. Los dos caminos calculan la `sourceRef` igual —DOI primero, EID
 *     después— y si alguien toca uno de los dos, el tesista empieza a ver
 *     duplicados que no puso.
 *   · Al importar viajan IDENTIFICADORES, no fichas. Si el servidor guardara
 *     lo que manda el navegador, cualquiera podría meterse en su bibliografía
 *     fuentes inventadas y citarlas en su tesis.
 *   · Un EID que no tiene forma de EID no llega a la ecuación. Con paréntesis
 *     o un `OR` dentro cambiaría la consulta entera.
 *   · Cero resultados no es un artículo llamado «undefined». Elsevier devuelve
 *     una ficha con `error` dentro en vez de una lista vacía.
 *   · Las credenciales van en cabeceras y NUNCA en la URL, que acaba en el
 *     registro del proxy y en el historial.
 *   · Apagado quiere decir apagado: sin `SCOPUS_API_ENABLED` no se llama a
 *     Elsevier ni una vez.
 *
 * Elsevier, la base y el cifrado se sustituyen antes de cargar nada: lo que se
 * comprueba es qué se pide y qué se escribe, no cómo se habla con nadie.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const ruta = (m) => require.resolve(m);
const sustituir = (modulo, exports) => {
  const id = ruta(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

// ── Lo que se sustituye ─────────────────────────────────────────────────────

const env = {
  scopusApiEnabled: true,
  scopusOauthEnabled: false,
  scopusView: 'COMPLETE',
  ELSEVIER_API_KEY: 'clave-de-la-casa',
  ELSEVIER_INSTTOKEN: 'token-institucional',
  APP_URL: 'https://acostaresearch.com',
};
sustituir('../src/config/env', env);
sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

/** Lo que se le pidió a Elsevier y lo que se le contestó. */
const elsevier = { peticiones: [], responder: null };

const anotarYResponder = async (url, opciones) => {
  elsevier.peticiones.push({ url: new URL(url), cabeceras: opciones?.headers ?? {} });
  return elsevier.responder();
};

global.fetch = anotarYResponder;

const respuestaCon = (fichas, total = fichas.length) => () => ({
  ok: true,
  status: 200,
  json: async () => ({
    'search-results': {
      'opensearch:totalResults': String(total),
      'opensearch:startIndex': '0',
      entry: fichas,
    },
  }),
});

/** La biblioteca del tesista, en memoria. */
const biblioteca = { filas: [] };

sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 5000,
  contar: async () => biblioteca.filas.length,
  contarSinResumen: async () => biblioteca.filas.filter((f) => !f.abstract).length,
  cualesTiene: async (_userId, claves) =>
    biblioteca.filas.filter((f) => claves.includes(f.sourceRef)).map((f) => f.sourceRef),
  guardarLote: async (_userId, filas) => {
    let guardadas = 0;
    let repetidas = 0;
    for (const fila of filas) {
      if (biblioteca.filas.some((f) => f.sourceRef === fila.sourceRef)) {
        repetidas += 1;
      } else {
        biblioteca.filas.push(fila);
        guardadas += 1;
      }
    }
    return { guardadas, repetidas };
  },
});

/** Lo que contestan los catálogos abiertos, y a qué DOI se les preguntó. */
const abierto = { openalex: null, crossref: null, preguntados: [], enlaces: new Map() };

sustituir('../src/modules/references/openalex.client', {
  porDoi: async (doi) => {
    abierto.preguntados.push(`openalex:${doi}`);
    return abierto.openalex;
  },
  /** Dónde se lee gratis cada uno, para el enlace abierto de los resultados. */
  enlacesAbiertosPorDoi: async (dois) => {
    abierto.preguntados.push(`enlaces:${dois.join(',')}`);
    return new Map(dois.map((doi) => [doi, abierto.enlaces.get(doi) ?? null]));
  },
});
sustituir('../src/modules/references/unpaywall.client', {
  enlacesAbiertosPorDoi: async () => new Map(),
});
sustituir('../src/modules/references/crossref.client', {
  porDoi: async (doi) => {
    abierto.preguntados.push(`crossref:${doi}`);
    return abierto.crossref;
  },
});

const conexion = { fila: { userId: 'u1', mode: 'APIKEY', status: 'ACTIVA', imported: 0 }, creadas: [] };

sustituir('../src/modules/scopus/scopus.repository', {
  deUsuario: async () => conexion.fila,
  anotarBusqueda: async () => {},
  sumarImportadas: async () => {},
  guardarConexion: async (datos) => {
    conexion.creadas.push(datos);
  },
  desconectar: async () => {},
});

const servicio = require('../src/modules/scopus/scopus.service');
const mapper = require('../src/modules/scopus/scopus.mapper');
// El lector de exports, de verdad y sin sustituir: la prueba que importa es que
// las dos vías calculen la misma identidad, y eso solo se ve con las dos.
const parser = require('../src/modules/references/scopus.parser');

// ── Las fichas de ejemplo ───────────────────────────────────────────────────

const EID = '2-s2.0-85012345678';
const DOI = '10.1016/j.compedu.2020.103850';

const FICHA = {
  '@_fa': 'true',
  'dc:identifier': `SCOPUS_ID:85012345678`,
  eid: EID,
  'dc:title': 'Mobile applications in higher education: a systematic review',
  'dc:creator': 'Sánchez R.',
  author: [
    { surname: 'Sánchez', 'given-name': 'Rosa María', authname: 'Sánchez R.M.' },
    { surname: 'Okoye', 'given-name': 'Kingsley', authname: 'Okoye K.' },
  ],
  'prism:publicationName': 'Computers and Education',
  'prism:coverDate': '2020-05-01',
  'prism:doi': DOI,
  'prism:volume': '152',
  'prism:issueIdentifier': '3',
  'prism:pageRange': '103850-103862',
  'dc:description': 'This review examines the use of mobile applications in education.',
  authkeywords: 'mobile learning | higher education | systematic review',
  subtypeDescription: 'Review',
  'citedby-count': '214',
  openaccessFlag: true,
  link: [
    { '@ref': 'self', '@href': 'https://api.elsevier.com/content/abstract/scopus_id/85012345678' },
    { '@ref': 'scopus', '@href': 'https://www.scopus.com/inward/record.uri?eid=2-s2.0-85012345678' },
  ],
};

/**
 * La MISMA ficha tal como llega sin token institucional (vista STANDARD).
 *
 * Es lo que Elsevier devuelve de verdad con la clave sola: se comprobó contra
 * api.elsevier.com el 17 de septiembre de 2026. Sin `author`, sin
 * `dc:description` y sin `authkeywords`; `dc:creator` trae UN solo autor.
 */
const FICHA_REDUCIDA = (() => {
  const reducida = { ...FICHA };
  delete reducida.author;
  delete reducida['dc:description'];
  delete reducida.authkeywords;
  return reducida;
})();

function empezar() {
  biblioteca.filas = [];
  elsevier.peticiones = [];
  elsevier.responder = respuestaCon([FICHA]);
  abierto.openalex = null;
  abierto.crossref = null;
  abierto.preguntados = [];
  abierto.enlaces = new Map();
  conexion.fila = { userId: 'u1', mode: 'APIKEY', status: 'ACTIVA', imported: 0 };
  conexion.creadas = [];
  env.scopusApiEnabled = true;
  env.scopusOauthEnabled = false;
  env.scopusView = 'COMPLETE';
}

// ── La identidad compartida con el lector de exports ─────────────────────────

test('la misma fuente por API y por archivo es UNA fila, no dos', () => {
  const porApi = mapper.comoFila(FICHA);

  // El mismo artículo, tal como sale de un CSV exportado de Scopus.
  const csv = Buffer.from(
    'Authors,Title,Year,Source title,Volume,Issue,DOI,EID,Abstract,Document Type\r\n' +
      `"Sánchez R.M., Okoye K.","${FICHA['dc:title']}",2020,"Computers and Education",152,3,` +
      `${DOI},${EID},"This review examines the use of mobile applications in education.",Review\r\n`,
    'utf8',
  );
  const porArchivo = parser.leer(csv).filas[0];

  assert.equal(
    porApi.sourceRef,
    porArchivo.sourceRef,
    'las dos vías tienen que calcular la misma identidad, o se duplican',
  );
  assert.equal(porApi.origin, porArchivo.origin);
  assert.equal(porApi.origin, 'SCOPUS');
  assert.equal(porApi.zoteroKey, null);
  // Nunca lleva nota: la nota es de Acosta y esto no lo escribió Acosta.
  assert.equal(porApi.notes, null);
});

test('sin DOI la identidad es el EID, y sin ninguno de los dos, el título', () => {
  const sinDoi = mapper.comoFila({ ...FICHA, 'prism:doi': undefined });
  assert.equal(sinDoi.sourceRef, `eid:${EID}`);

  const suelto = mapper.comoFila({ 'dc:title': 'Un título cualquiera' });
  assert.match(suelto.sourceRef, /^titulo:untitulocualquiera$/);
});

test('los autores salen en el formato de la bibliografía, no como los manda Elsevier', () => {
  const fila = mapper.comoFila(FICHA);
  assert.equal(fila.authors, 'Sánchez, R.M.; Okoye, K.');
});

test('el enlace guardado es el del registro de Scopus, no el de la API', () => {
  assert.equal(
    mapper.comoFila(FICHA).url,
    'https://www.scopus.com/inward/record.uri?eid=2-s2.0-85012345678',
  );
});

// ── Buscar ──────────────────────────────────────────────────────────────────

test('las credenciales van en cabeceras y nunca en la dirección', async () => {
  empezar();
  await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY("mobile applications")' });

  const { url, cabeceras } = elsevier.peticiones[0];
  assert.equal(cabeceras['X-ELS-APIKey'], 'clave-de-la-casa');
  assert.equal(cabeceras['X-ELS-Insttoken'], 'token-institucional');

  const direccion = url.toString();
  assert.ok(!direccion.includes('clave-de-la-casa'), 'la clave no puede viajar en la URL');
  assert.ok(!direccion.includes('token-institucional'), 'el token tampoco');
  assert.ok(!direccion.includes('apiKey'), 'ni siquiera el parámetro');
});

test('la ecuación llega a Elsevier tal como la escribió el tesista', async () => {
  empezar();
  const ecuacion = 'TITLE-ABS-KEY("mobile applications" AND education) AND PUBYEAR > 2019';
  await servicio.buscar('u1', { ecuacion });

  assert.equal(elsevier.peticiones[0].url.searchParams.get('query'), ecuacion);
});

test('cero resultados es una lista vacía, no un artículo sin título', async () => {
  empezar();
  elsevier.responder = respuestaCon([{ error: 'Result set was empty' }], 0);

  const busqueda = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(xyzzy)' });

  assert.equal(busqueda.total, 0);
  assert.deepEqual(busqueda.resultados, []);
});

test('lo que ya tiene sale marcado, pero no se le esconde', async () => {
  empezar();
  biblioteca.filas.push({ sourceRef: `doi:${DOI}`, abstract: 'x' });

  const busqueda = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' });

  assert.equal(busqueda.resultados.length, 1, 'sigue apareciendo en la lista');
  assert.equal(busqueda.resultados[0].yaLaTienes, true);
});

test('el orden elegido llega a Elsevier, y uno desconocido cae en «más citados»', async () => {
  empezar();
  const recientes = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)', orden: 'recientes' });
  assert.equal(elsevier.peticiones[0].url.searchParams.get('sort'), '-coverDate');
  assert.equal(recientes.orden, 'recientes');

  empezar();
  const raro = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)', orden: 'constructor' });
  assert.equal(elsevier.peticiones[0].url.searchParams.get('sort'), '-citedby-count');
  assert.equal(raro.orden, 'citas');
});

test('la segunda página se pide por desplazamiento, no repitiendo la primera', async () => {
  empezar();
  await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)', pagina: 3 });

  assert.equal(elsevier.peticiones[0].url.searchParams.get('start'), '50');
  assert.equal(elsevier.peticiones[0].url.searchParams.get('count'), '25');
});

/**
 * Dónde se lee gratis, pegado a cada resultado.
 *
 * Scopus dice SI un artículo es de acceso abierto —la etiqueta ya estaba— pero
 * no DÓNDE está la copia, y sin el dónde el cartel no le servía de nada al
 * tesista: le quedaba chocarse con el muro de pago de la editorial y buscar el
 * PDF por su cuenta. Lo ponen los catálogos abiertos, que no tocan la cuota de
 * Elsevier ni piden permiso a nadie.
 */
test('el resultado llega con el enlace al texto abierto, y con qué versión es', async () => {
  empezar();
  abierto.enlaces.set(DOI.toLowerCase(), {
    url: 'https://repositorio.edu.pe/articulo.pdf',
    esPdf: true,
    version: 'acceptedVersion',
    licencia: 'cc-by',
    donde: 'Repositorio institucional',
  });

  const busqueda = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' });
  const [resultado] = busqueda.resultados;

  assert.equal(resultado.enlaceAbierto.url, 'https://repositorio.edu.pe/articulo.pdf');
  assert.equal(resultado.enlaceAbierto.esPdf, true);
  // La versión llega hasta la vista: un manuscrito aceptado tiene otra
  // paginación, y quien cite una página de ahí la va a citar mal.
  assert.equal(resultado.enlaceAbierto.version, 'acceptedVersion');
  assert.equal(resultado.enlaceAbierto.mismoQueEditorial, false);
  // Y no se le preguntó nada más a Elsevier por ello.
  assert.equal(elsevier.peticiones.length, 1);
});

test('sin copia abierta el resultado sale igual que siempre', async () => {
  empezar();

  const busqueda = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' });
  const [resultado] = busqueda.resultados;

  assert.equal(resultado.enlaceAbierto, null);
  assert.equal(resultado.titulo, FICHA['dc:title']);
  assert.equal(resultado.eid, EID);
});

/**
 * Sin OAuth no hay nada que conectar, y por eso no se pide.
 *
 * Se pregunta con la clave de la casa, que es de este servidor: «conectar» era
 * un clic de trámite entre el tesista y el buscador que no establecía nada. Se
 * quitó el 17 de septiembre de 2026, y esta prueba fija las dos mitades —porque
 * con OAuth SÍ hace falta, y aflojarlo ahí dejaría buscar sin credencial suya—.
 */
test('sin OAuth se busca sin conectar nada; con OAuth se exige la conexión', async () => {
  empezar();
  conexion.fila = null;

  // Modo de clave compartida: no hay fila y se busca igual.
  const busqueda = await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' });
  assert.equal(busqueda.resultados.length, 1);
  assert.equal(elsevier.peticiones.length, 1);

  // Con el OAuth de Elsevier habilitado, la conexión vuelve a ser obligatoria.
  env.scopusOauthEnabled = true;
  elsevier.peticiones = [];

  await assert.rejects(
    () => servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' }),
    /No tienes Scopus conectado/,
  );
  assert.equal(elsevier.peticiones.length, 0, 'y no se le pregunta nada a Elsevier');
});

/**
 * La fila se crea al IMPORTAR, no al mirar.
 *
 * Es el contador de lo que ha traído, no un permiso. Crearla al entrar en la
 * pantalla dejaría una fila por cada visita que solo pasó a mirar.
 */
test('sin OAuth, buscar no deja rastro; importar sí crea el contador', async () => {
  empezar();
  conexion.fila = null;
  conexion.creadas = [];

  await servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' });
  assert.deepEqual(conexion.creadas, [], 'mirar no crea nada');

  await servicio.importar('u1', { eids: [EID] });
  assert.deepEqual(conexion.creadas, [{ userId: 'u1', mode: 'APIKEY' }]);
});

test('apagado en el servidor quiere decir apagado', async () => {
  empezar();
  env.scopusApiEnabled = false;

  await assert.rejects(
    () => servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' }),
    /todavía no está disponible/,
  );
  assert.equal(elsevier.peticiones.length, 0);
});

// ── Importar ────────────────────────────────────────────────────────────────

test('importar vuelve a preguntarle a Elsevier: no guarda lo que mande el navegador', async () => {
  empezar();
  const parte = await servicio.importar('u1', { eids: [EID] });

  assert.equal(elsevier.peticiones.length, 1, 'se le pregunta a Scopus antes de guardar');
  assert.equal(elsevier.peticiones[0].url.searchParams.get('query'), `EID(${EID})`);
  assert.equal(parte.guardadas, 1);
  assert.equal(biblioteca.filas[0].title, FICHA['dc:title']);
});

test('un EID con forma de ecuación no llega a la consulta', async () => {
  empezar();

  await assert.rejects(
    () => servicio.importar('u1', { eids: ['2-s2.0-1) OR ALL(x'] }),
    /No marcaste ningún artículo/,
  );
  assert.equal(elsevier.peticiones.length, 0);

  assert.equal(mapper.esEid('2-s2.0-85012345678'), true);
  assert.equal(mapper.esEid('2-s2.0-1) OR ALL(x'), false);
  assert.equal(mapper.esEid('ALL(covid)'), false);
});

test('importar dos veces lo mismo refresca la ficha en vez de duplicarla', async () => {
  empezar();
  await servicio.importar('u1', { eids: [EID] });
  const segunda = await servicio.importar('u1', { eids: [EID] });

  assert.equal(segunda.guardadas, 0);
  assert.equal(segunda.repetidas, 1);
  assert.equal(biblioteca.filas.length, 1);
});

test('lo que Scopus ya no devuelve se cuenta y se puede decir', async () => {
  empezar();
  const otro = '2-s2.0-85099999999';
  const parte = await servicio.importar('u1', { eids: [EID, otro] });

  assert.equal(parte.pedidas, 2);
  assert.equal(parte.guardadas, 1);
  assert.equal(parte.noEncontradas, 1);
});

test('no se pueden importar más de las que caben en una página', async () => {
  empezar();
  const muchos = Array.from({ length: 30 }, (_, i) => `2-s2.0-8501234${String(i).padStart(4, '0')}`);

  await assert.rejects(() => servicio.importar('u1', { eids: muchos }), /hasta 25 de una vez/);
  assert.equal(elsevier.peticiones.length, 0);
});

// ── Scopus busca, el catálogo abierto completa ──────────────────────────────
//
// Sin token institucional, Elsevier devuelve UN solo autor y ningún resumen.
// Guardarlo así deja dos destrozos que no se ven hasta semanas después: una
// bibliografía con un firmante donde el artículo tiene treinta, y una fuente
// que Claude no encuentra nunca porque solo queda el título para buscarla.

test('la ficha reducida se completa con el catálogo abierto antes de guardarla', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA_REDUCIDA]);
  abierto.crossref = { authors: 'Sánchez, R.M.; Okoye, K.; Tercero, A.' };
  abierto.openalex = { authors: 'Sánchez, R.M.; Okoye, K.', abstract: 'Resumen del catálogo abierto.' };

  await servicio.importar('u1', { eids: [EID] });

  const guardada = biblioteca.filas[0];
  // Los autores, de Crossref: es donde el editor los depositó con apellido y
  // nombre separados, y ese campo acaba en la bibliografía del Word.
  assert.equal(guardada.authors, 'Sánchez, R.M.; Okoye, K.; Tercero, A.');
  assert.equal(guardada.abstract, 'Resumen del catálogo abierto.');
});

/**
 * Un artículo de cincuenta firmantes no puede tumbar la importación entera.
 *
 * `comoFila` recorta cada campo a la longitud de su columna, pero `completar`
 * los REEMPLAZA por los del catálogo abierto. Crossref devuelve la lista
 * completa de autores sin tope, y con 500 caracteres de columna MySQL no
 * trunca: rechaza la fila con un 1406 que sale como «Ocurrió un error
 * inesperado» y se lleva por delante las fichas que sí cabían, porque
 * `guardarLote` va de una en una.
 *
 * Se mide aquí y no en la base porque aquí se ve por qué: la columna es la de
 * `prisma/schema.prisma`, y es la misma que respetan `comoFila` y el lector de
 * exports.
 */
test('los autores que da Crossref se recortan a lo que cabe en la columna', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA_REDUCIDA]);
  const cincuenta = Array.from({ length: 50 }, (_, i) => `Apellido${i}, N.`).join('; ');
  abierto.crossref = {
    authors: cincuenta,
    source: 'S'.repeat(400),
    volume: 'V'.repeat(60),
    issue: 'I'.repeat(60),
    pages: 'P'.repeat(60),
  };
  abierto.openalex = { abstract: 'Resumen del catálogo abierto.', tags: 'T'.repeat(700) };

  await servicio.importar('u1', { eids: [EID] });

  const guardada = biblioteca.filas[0];
  assert.ok(cincuenta.length > 500, 'la lista de prueba tiene que pasarse de largo');
  assert.equal(guardada.authors.length, 500);
  assert.ok(guardada.authors.startsWith('Apellido0, N.;'), 'se recorta por el final, no por el principio');
  // La revista y la paginación llegan de Scopus en esta ficha, así que Crossref
  // no las pisa; lo que se fija es que ninguna columna se pase si algún día sí.
  assert.ok((guardada.source ?? '').length <= 300);
  assert.ok((guardada.volume ?? '').length <= 40);
  assert.ok((guardada.issue ?? '').length <= 40);
  assert.ok((guardada.pages ?? '').length <= 40);
  assert.ok(guardada.tags.length <= 500);
  // Y el resumen sigue entrando: es TEXT, y recortarlo sería perderlo.
  assert.equal(guardada.abstract, 'Resumen del catálogo abierto.');
});

test('el resumen completado entra en la columna con la que se busca', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA_REDUCIDA]);
  abierto.openalex = { abstract: 'Aprendizaje móvil en la educación superior peruana.' };

  await servicio.importar('u1', { eids: [EID] });

  // Sin esto la fuente se guarda con resumen y sin poder encontrarse por él:
  // ocupa sitio y no sirve, que es el peor de los dos mundos.
  assert.ok(biblioteca.filas[0].busqueda.includes('aprendizaje movil'));
});

test('lo que Scopus decide no se lo pisa nadie: título, revista y tipo', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA_REDUCIDA]);
  abierto.crossref = { source: 'Otra Revista Cualquiera', volume: '999' };
  abierto.openalex = { source: 'Y Otra Más', abstract: 'x' };

  await servicio.importar('u1', { eids: [EID] });

  const guardada = biblioteca.filas[0];
  assert.equal(guardada.source, 'Computers and Education', 'la revista la dice Scopus');
  assert.equal(guardada.volume, '152', 'el volumen también, si lo trae');
  assert.equal(guardada.title, FICHA['dc:title'], 'y el título es el que vio al marcar');
});

test('con la ficha entera no se molesta al catálogo abierto', async () => {
  empezar(); // `FICHA` trae `author` y `dc:description`: es la vista COMPLETE.

  await servicio.importar('u1', { eids: [EID] });

  assert.deepEqual(abierto.preguntados, [], 'con insttoken no hacen falta más peticiones');
  assert.equal(biblioteca.filas[0].authors, 'Sánchez, R.M.; Okoye, K.');
});

test('un catálogo que no contesta no tumba la importación', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA_REDUCIDA]);
  // Los dos caídos: se pierde el resumen de esa ficha, no la ficha.
  abierto.openalex = null;
  abierto.crossref = null;

  const parte = await servicio.importar('u1', { eids: [EID] });

  assert.equal(parte.guardadas, 1);
  assert.equal(parte.sinResumen, 1, 'y se cuenta, para poder decírselo');
  assert.equal(biblioteca.filas[0].authors, 'Sánchez, R.', 'se queda el único que dio Scopus');
});

test('sin DOI no se le pregunta a nadie: no hay por dónde', async () => {
  empezar();
  elsevier.responder = respuestaCon([{ ...FICHA_REDUCIDA, 'prism:doi': undefined }]);

  await servicio.importar('u1', { eids: [EID] });

  assert.deepEqual(abierto.preguntados, []);
  assert.equal(biblioteca.filas[0].sourceRef, `eid:${EID}`);
});

// ── Lo que se le dice al tesista ────────────────────────────────────────────

test('sin token institucional se avisa de que las fichas llegarán sin resumen', async () => {
  empezar();
  env.scopusView = 'STANDARD';

  const estado = await servicio.estado('u1');
  assert.equal(estado.conResumenes, false);

  env.scopusView = 'COMPLETE';
  assert.equal((await servicio.estado('u1')).conResumenes, true);
});

/**
 * La diferencia entre «Elsevier dijo que no» y «no se pudo preguntar».
 *
 * La marca viaja EN LA INSTANCIA del error, porque `AppError` solo conserva
 * `statusCode`, `code` y `details`: pasarla como opción del constructor la
 * perdería en silencio, y entonces un corte de red dejaría la conexión marcada
 * como revocada y al tesista rehaciendo algo que no estaba roto.
 */
test('un canje que Elsevier rechaza se distingue de uno que no llegó a salir', async () => {
  empezar();
  env.ELSEVIER_CLIENT_ID = 'id';
  env.ELSEVIER_CLIENT_SECRET = 'secreto';
  env.ELSEVIER_TOKEN_URL = 'https://elsevier.example/token';

  const oauth = require('../src/modules/scopus/scopus.oauth');

  elsevier.responder = () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: 'invalid_grant' }),
  });
  await assert.rejects(
    () => oauth.refrescar('lo-que-sea'),
    (fallo) => fallo.rechazadoPorElsevier === true,
  );

  global.fetch = async () => {
    throw new Error('se cayó la red');
  };
  try {
    await assert.rejects(
      () => oauth.refrescar('lo-que-sea'),
      (fallo) => fallo.rechazadoPorElsevier !== true,
    );
  } finally {
    // Se devuelve, o las pruebas de después heredarían una red caída.
    global.fetch = anotarYResponder;
  }
});

/**
 * La vuelta de Elsevier tiene que caer en una ruta QUE EXISTA.
 *
 * `/mi-conector` es el nombre del componente que pinta la tarjeta, no una ruta
 * de la web; las que hay son `/perfil` y `/admin`. Y el comodín `**` de Angular
 * manda a la portada todo lo que no reconoce, así que equivocarse aquí no da
 * ningún error: deja al tesista en la página de inicio sin saber si autorizó.
 * Pasó el 17 de septiembre de 2026.
 */
test('la vuelta lleva a /perfil, que es donde está la tarjeta', () => {
  for (const resultado of ['ok', 'cancelado', 'rechazado', 'error']) {
    assert.equal(
      servicio.urlDelPanel(resultado),
      `https://acostaresearch.com/perfil?scopus=${resultado}`,
    );
  }
});

test('una conexión revocada no se presenta como conectada', async () => {
  empezar();
  // Solo se puede revocar lo que se autorizó: este caso es del modo OAuth.
  env.scopusOauthEnabled = true;
  conexion.fila = { userId: 'u1', mode: 'OAUTH', status: 'REVOCADA', imported: 12 };

  const estado = await servicio.estado('u1');
  assert.equal(estado.conectado, false);
  assert.equal(estado.estado, 'REVOCADA');
  // Lo que ya trajo sigue contando: sus fuentes no se fueron a ninguna parte.
  assert.equal(estado.importadas, 12);

  await assert.rejects(
    () => servicio.buscar('u1', { ecuacion: 'TITLE-ABS-KEY(mobile)' }),
    /dejó de aceptar tu conexión/,
  );
});

// ── Los números de los filtros ─────────────────────────────────────────────

test('cuentas exactas: una consulta de un resultado por opción, y lo contado no se repite', async () => {
  empezar();
  elsevier.responder = respuestaCon([FICHA], 7);

  const ecuacion = 'TITLE-ABS-KEY(cuentas-unicas)';
  const { cuentas } = await servicio.cuentas('u1', { ecuacion, faceta: 'etapa' });

  assert.deepEqual(cuentas, { final: 7, aip: 7 });
  const pedidas = elsevier.peticiones.map((p) => p.url.searchParams.get('query')).sort();
  assert.deepEqual(pedidas, [`(${ecuacion}) AND PUBSTAGE(aip)`, `(${ecuacion}) AND PUBSTAGE(final)`]);
  assert.ok(elsevier.peticiones.every((p) => p.url.searchParams.get('count') === '1'));

  elsevier.peticiones = [];
  await servicio.cuentas('u1', { ecuacion, faceta: 'etapa' });
  assert.equal(elsevier.peticiones.length, 0, 'la segunda vez sale de lo guardado');
});

test('los años que se cuentan son los diez últimos, uno a uno', () => {
  const opciones = servicio.opcionesDeLaFaceta('anio');
  const este = new Date().getFullYear();
  assert.equal(opciones.length, 10);
  assert.equal(opciones.at(-1).clausula, `PUBYEAR = ${este}`);
  assert.equal(opciones[0].valor, String(este - 9));
});

// ── La búsqueda semántica ──────────────────────────────────────────────────

test('por significado: se ordenan por cercanía a la pregunta, no por el orden de Scopus', async () => {
  empezar();
  env.asistenteEnabled = true;
  const cercana = { ...FICHA, eid: '2-s2.0-1', 'dc:title': 'Cerca', 'prism:doi': '10.1/cerca' };
  const lejana = { ...FICHA, eid: '2-s2.0-2', 'dc:title': 'Lejos', 'prism:doi': '10.1/lejos' };
  elsevier.responder = respuestaCon([lejana, cercana], 2);

  const embeber = async (textos, { tarea }) =>
    tarea === 'RETRIEVAL_QUERY' ? [[1, 0]] : textos.map((t) => (t.startsWith('Cerca') ? [1, 0.1] : [0, 1]));
  const resumenes = async () => new Map([['10.1/cerca', 'resumen']]);

  const busqueda = await servicio.buscarSemantica(
    'u1',
    { ecuacion: 'TITLE-ABS-KEY(x)', pregunta: '¿qué?' },
    { embeber, resumenes },
  );

  assert.equal(busqueda.semantica, true);
  assert.deepEqual(busqueda.resultados.map((r) => r.titulo), ['Cerca', 'Lejos']);
  assert.ok(busqueda.resultados[0].afinidad > busqueda.resultados[1].afinidad);
  assert.equal(elsevier.peticiones[0].url.searchParams.get('sort'), 'relevancy');
});

test('si Gemini no da los vectores, 503 del asistente y no un 500', async () => {
  empezar();
  env.asistenteEnabled = true;
  const embeber = async () => {
    throw new Error('caído');
  };

  await assert.rejects(
    () => servicio.buscarSemantica('u1', { ecuacion: 'TITLE-ABS-KEY(x)', pregunta: '¿qué?' }, { embeber, resumenes: async () => new Map() }),
    (error) => error.statusCode === 503 && error.code === 'ASSISTANT_UNAVAILABLE',
  );
});
