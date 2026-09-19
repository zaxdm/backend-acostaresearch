'use strict';

/**
 * El Mendeley de cada tesista: traducir sus documentos, el OAuth 2, la
 * paginación, y la pasada —cupo, carpeta, limpieza y token que caduca—.
 *
 * Sin base de datos ni red: se sustituyen el repositorio, el de fuentes
 * propias y `fetch`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (modulo, exports) => {
  const id = require.resolve(modulo);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

sustituir('../src/config/env', {
  mendeleyOauthEnabled: true,
  APP_URL: 'https://acostaresearch.com',
  MENDELEY_CLIENT_ID: '1234',
  MENDELEY_CLIENT_SECRET: 'secreto',
  API_PREFIX: '/api/v1',
});

sustituir('../src/config/logger', { info: () => {}, warn: () => {}, error: () => {} });

// Cifrar de mentira: basta con que se note que pasó por aquí.
sustituir('../src/shared/utils/secretos', {
  cifrar: (texto) => `cifrado:${texto}`,
  descifrar: (texto) => String(texto).replace(/^cifrado:/, ''),
});

// ── La base, de mentira ────────────────────────────────────────────────────

const base = {
  cuenta: null,
  estados: new Map(),
  guardadas: [],
  conocidas: new Set(),
  borrado: null,
  tokens: null,
  conexion: null,
  fallo: null,
  total: 0,
  turno: true,
};

sustituir('../src/modules/mendeley/mendeley.repository', {
  prefijoDe: (id) => `mendeley:${id}:`,
  deUsuario: async () => base.cuenta,
  guardarConexion: async (datos) => {
    base.conexion = datos;
  },
  guardarTokens: async (_userId, datos) => {
    base.tokens = datos;
  },
  elegirCarpeta: async () => {},
  guardarPasada: async () => {},
  anotarFallo: async (_userId, mensaje) => {
    base.fallo = mensaje;
  },
  tomarElTurno: async () => base.turno,
  soltarElTurno: async () => {},
  borrarLasQueYaNoEstan: async (userId, profileId, vivos, citadas) => {
    base.borrado = { userId, profileId, vivos, citadas };
    return 0;
  },
  contarDeMendeley: async () => base.total,
  desconectar: async () => {},
  guardarEstado: async ({ state, userId }) => base.estados.set(state, { state, userId }),
  tomarEstado: async (state) => {
    const fila = base.estados.get(state) ?? null;
    base.estados.delete(state);
    return fila;
  },
});

sustituir('../src/modules/references/propias.repository', {
  TOPE_POR_USUARIO: 5000,
  contar: async () => base.yaTiene ?? 0,
  cualesTiene: async (_userId, refs) => refs.filter((r) => base.conocidas.has(r)),
  guardarLote: async (_userId, filas) => {
    base.guardadas.push(...filas);
    const nuevas = filas.filter((f) => !base.conocidas.has(f.sourceRef)).length;
    return { guardadas: nuevas, repetidas: filas.length - nuevas };
  },
});

sustituir('../src/modules/references/citadas', { clavesCitadas: async () => ['ARCITADA01'] });

// ── La red, de mentira ─────────────────────────────────────────────────────

/** Cada petición se apunta; la respuesta sale de `red.responder`. */
const red = { pedidas: [], responder: () => respuesta(404, {}) };

function respuesta(status, cuerpo, cabeceras = {}) {
  return new Response(JSON.stringify(cuerpo), {
    status,
    headers: { 'content-type': 'application/json', ...cabeceras },
  });
}

global.fetch = async (url, opciones = {}) => {
  const pedida = { url: String(url), opciones };
  red.pedidas.push(pedida);
  return red.responder(pedida);
};

const mapper = require('../src/modules/mendeley/mendeley.mapper');
const oauth = require('../src/modules/mendeley/mendeley.oauth');
const cliente = require('../src/modules/mendeley/mendeley.client');
const servicio = require('../src/modules/mendeley/mendeley.service');

const documento = (id, extra = {}) => ({
  id,
  title: `Título ${id}`,
  type: 'journal',
  authors: [{ first_name: 'Juan', last_name: 'García' }],
  year: 2021,
  source: 'Revista de Pruebas',
  identifiers: { doi: `10.1000/${id}` },
  ...extra,
});

// ── El traductor ───────────────────────────────────────────────────────────

test('un documento de Mendeley se traduce a una ficha con los nombres de Zotero', () => {
  const fila = mapper.aFila(
    documento('d1', {
      type: 'book_section',
      authors: [
        { first_name: 'Roberto', last_name: 'Hernández' },
        { last_name: 'UNESCO' },
      ],
      identifiers: { doi: 'https://doi.org/10.1000/ABC' },
      websites: ['https://ejemplo.org/a'],
      abstract: 'Un resumen.',
      tags: ['tesis'],
      keywords: ['clima', 'tesis'],
      volume: '12',
      issue: '3',
      pages: '10-20',
    }),
  );

  assert.equal(fila.itemType, 'bookSection', 'un capítulo no puede leerse como libro');
  assert.equal(fila.authors, 'Hernández, R.; UNESCO');
  assert.equal(fila.doi, '10.1000/ABC');
  assert.equal(fila.url, 'https://ejemplo.org/a');
  assert.equal(fila.tags, 'tesis, clima', 'etiquetas y palabras clave juntas y sin repetir');
  assert.equal(fila.origin, 'MENDELEY');
  assert.equal(fila.zoteroKey, null);
  assert.equal(fila.notes, null, 'la nota es de Acosta: lo del tesista no la lleva');
  assert.match(fila.busqueda, /hernandez/, 'se busca sin tildes');
});

test('sin autores se firma con los editores, y un año absurdo queda sin año', () => {
  const fila = mapper.aFila(
    documento('d2', { authors: [], editors: [{ first_name: 'Ana', last_name: 'Ruiz' }], year: 20 }),
  );
  assert.equal(fila.authors, 'Ruiz, A.');
  assert.equal(fila.year, null);
});

test('un documento sin título no es una fuente', () => {
  assert.equal(mapper.esFuente(documento('d3', { title: '  ' })), false);
  assert.equal(mapper.esFuente(documento('d3')), true);
});

// ── El OAuth ───────────────────────────────────────────────────────────────

test('la dirección de autorización es la que documenta Mendeley', () => {
  const { state, url } = oauth.empezar();
  const u = new URL(url);

  assert.equal(`${u.origin}${u.pathname}`, 'https://api.mendeley.com/oauth/authorize');
  assert.equal(u.searchParams.get('client_id'), '1234');
  assert.equal(u.searchParams.get('response_type'), 'code');
  assert.equal(u.searchParams.get('scope'), 'all');
  assert.equal(u.searchParams.get('state'), state);
  assert.equal(
    u.searchParams.get('redirect_uri'),
    'https://acostaresearch.com/api/v1/mi-mendeley/vuelta',
  );
  assert.ok(state.length >= 40, 'un state que no se adivina');
});

test('el canje manda el cliente por Basic y el código en el cuerpo', async () => {
  red.pedidas = [];
  red.responder = () =>
    respuesta(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600, token_type: 'bearer' });

  const tokens = await oauth.canjear('CODIGO');
  const { url, opciones } = red.pedidas[0];
  const cuerpo = new URLSearchParams(opciones.body);

  assert.equal(url, 'https://api.mendeley.com/oauth/token');
  assert.equal(opciones.headers.Authorization, `Basic ${Buffer.from('1234:secreto').toString('base64')}`);
  assert.equal(cuerpo.get('grant_type'), 'authorization_code');
  assert.equal(cuerpo.get('code'), 'CODIGO');
  assert.ok(!cuerpo.has('client_secret'), 'el secreto no va en el cuerpo');
  assert.deepEqual(tokens, { accessToken: 'AT', refreshToken: 'RT', expiraEn: 3600 });
});

test('un refresco rechazado queda marcado como conexión revocada', async () => {
  red.responder = () => respuesta(400, { error: 'invalid_grant' });
  await assert.rejects(oauth.refrescar('RT'), (fallo) => fallo.revocada === true);
});

// ── El cliente ─────────────────────────────────────────────────────────────

test('la paginación sigue el Link de Mendeley y nunca a otro dominio', async () => {
  assert.equal(
    cliente.siguiente(
      new Response('', {
        headers: { link: '<https://api.mendeley.com/documents?marker=x>; rel="next", <https://api.mendeley.com/documents>; rel="first"' },
      }),
    ),
    'https://api.mendeley.com/documents?marker=x',
  );

  red.responder = () =>
    respuesta(200, [documento('a')], { link: '<https://malo.example/documents?m=1>; rel="next"' });

  const paginas = cliente.paginasDeDocumentos('AT');
  await paginas.next();
  await assert.rejects(paginas.next(), /dirección ajena/);
});

test('las carpetas salen en plano, con el camino de las anidadas', async () => {
  red.responder = () =>
    respuesta(200, [
      { id: 'p', name: 'Tesis', parent_id: null },
      { id: 'h', name: 'Antecedentes', parent_id: 'p' },
    ]);

  const carpetas = await cliente.carpetas('AT');
  assert.deepEqual(
    carpetas.map((c) => c.nombre),
    ['Tesis', 'Tesis › Antecedentes'],
  );
});

test('un 401 de Mendeley es una conexión revocada, no un error cualquiera', async () => {
  red.responder = () => respuesta(401, { message: 'expired' });
  await assert.rejects(cliente.carpetas('AT'), (fallo) => fallo.revocada === true);
});

// ── Conectar ───────────────────────────────────────────────────────────────

test('volver en otro navegador no conecta nada', async () => {
  const { state } = await servicio.empezar('U1');
  await assert.rejects(
    servicio.terminar({ codigo: 'C', state, stateDelNavegador: 'otro' }),
    /otro navegador/,
  );
});

test('la vuelta buena guarda los tokens cifrados y el perfil de quien autorizó', async () => {
  const { state } = await servicio.empezar('U1');
  red.responder = ({ url }) =>
    url.endsWith('/oauth/token')
      ? respuesta(200, { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
      : respuesta(200, { id: 'perfil-1', display_name: 'Juana Pérez' });

  const { userId } = await servicio.terminar({ codigo: 'C', state, stateDelNavegador: state });

  assert.equal(userId, 'U1', 'la identidad sale de la fila del state');
  assert.equal(base.conexion.profileId, 'perfil-1');
  assert.equal(base.conexion.displayName, 'Juana Pérez');
  assert.equal(base.conexion.accessTokenCipher, 'cifrado:AT');
  assert.equal(base.conexion.refreshTokenCipher, 'cifrado:RT');

  await assert.rejects(
    servicio.terminar({ codigo: 'C', state, stateDelNavegador: state }),
    /ya se usó/,
    'un state sirve una vez',
  );
});

// ── La pasada ──────────────────────────────────────────────────────────────

const cuentaViva = (extra = {}) => ({
  userId: 'U1',
  profileId: 'perfil-1',
  accessTokenCipher: 'cifrado:AT',
  refreshTokenCipher: 'cifrado:RT',
  expiresAt: new Date(Date.now() + 30 * 60 * 1000),
  folderId: 'carpeta-1',
  ...extra,
});

/** Una biblioteca de tres documentos, de los que la carpeta tiene dos. */
function bibliotecaDeTres({ token = 'AT' } = {}) {
  return ({ url, opciones }) => {
    if (opciones.headers?.Authorization && opciones.headers.Authorization !== `Bearer ${token}`) {
      return respuesta(401, {});
    }
    if (url.includes('/folders/carpeta-1/documents')) return respuesta(200, [{ id: 'd1' }, { id: 'd2' }]);
    if (url.includes('/documents')) return respuesta(200, [documento('d1'), documento('d2'), documento('d3')]);
    return respuesta(404, {});
  };
}

test('trae solo lo de la carpeta y limpia contra sus ids, sin tocar lo citado', async () => {
  base.cuenta = cuentaViva();
  base.guardadas = [];
  base.conocidas = new Set();
  red.pedidas = [];
  red.responder = bibliotecaDeTres();

  const resultado = await servicio.sincronizar('U1');

  assert.deepEqual(
    base.guardadas.map((f) => f.sourceRef),
    ['mendeley:perfil-1:d1', 'mendeley:perfil-1:d2'],
  );
  assert.equal(resultado.guardadas, 2);
  assert.deepEqual(base.borrado.vivos, ['d1', 'd2']);
  assert.deepEqual(base.borrado.citadas, ['ARCITADA01']);
  assert.ok(
    red.pedidas.every((p) => !p.opciones.method || p.opciones.method === 'GET'),
    'a su biblioteca solo se le lee',
  );
});

test('con toda la biblioteca, la limpieza usa lo que se vio en el recorrido', async () => {
  base.cuenta = cuentaViva({ folderId: '*' });
  base.guardadas = [];
  red.responder = bibliotecaDeTres();

  await servicio.sincronizar('U1');
  assert.deepEqual(base.borrado.vivos, ['d1', 'd2', 'd3']);
});

test('sin cupo no entra nada nuevo, pero lo que ya tenía se refresca y nada se borra de más', async () => {
  base.cuenta = cuentaViva({ folderId: '*' });
  base.guardadas = [];
  base.yaTiene = 5000;
  base.conocidas = new Set(['mendeley:perfil-1:d2']);
  red.responder = bibliotecaDeTres();

  const resultado = await servicio.sincronizar('U1');

  assert.deepEqual(base.guardadas.map((f) => f.sourceRef), ['mendeley:perfil-1:d2']);
  assert.equal(resultado.guardadas, 0);
  assert.deepEqual(base.borrado.vivos, ['d1', 'd2', 'd3'], 'el recorrido sigue entero sin cupo');
  base.yaTiene = 0;
  base.conocidas = new Set();
});

test('un token vencido se renueva antes de la pasada y se guarda cifrado', async () => {
  base.cuenta = cuentaViva({ expiresAt: new Date(Date.now() - 1000) });
  base.tokens = null;
  const biblioteca = bibliotecaDeTres({ token: 'AT2' });
  red.responder = (pedida) =>
    pedida.url.endsWith('/oauth/token')
      ? respuesta(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 })
      : biblioteca(pedida);

  await servicio.sincronizar('U1');

  assert.equal(base.tokens.accessTokenCipher, 'cifrado:AT2');
  assert.equal(base.tokens.refreshTokenCipher, 'cifrado:RT2');
  assert.ok(base.tokens.expiresAt > new Date());
});

test('si Mendeley rechaza el refresco, el panel dice que vuelva a conectar', async () => {
  base.cuenta = cuentaViva({ expiresAt: new Date(Date.now() - 1000) });
  base.fallo = null;
  red.responder = () => respuesta(400, { error: 'invalid_grant' });

  await assert.rejects(servicio.sincronizar('U1'));
  assert.equal(base.fallo, 'Mendeley ya no acepta la conexión. Vuelve a conectar tu cuenta.');
});

test('dos pasadas a la vez no: la segunda se rechaza', async () => {
  base.turno = false;
  await assert.rejects(servicio.sincronizar('U1'), /Ya se está trayendo/);
  base.turno = true;
});

test('el panel ve el estado sin un solo token', async () => {
  base.cuenta = cuentaViva({ displayName: 'Juana', folderName: 'Tesis', lastCount: 2 });
  const estado = await servicio.estado('U1');

  assert.equal(estado.conectado, true);
  assert.deepEqual(estado.coleccion, { clave: 'carpeta-1', nombre: 'Tesis' });
  assert.ok(!JSON.stringify(estado).includes('AT'), 'ni el token ni su cifrado');
});

// ── La vuelta, vista desde el navegador ────────────────────────────────────

const controlador = require('../src/modules/mendeley/mendeley.controller');

/** Llama a la vuelta como lo haría Express y devuelve a dónde redirige. */
async function volver(query, cookies = {}) {
  let destino = null;
  const res = {
    clearCookie: () => {},
    redirect: (url) => {
      destino = url;
    },
  };
  await new Promise((listo, fallo) => {
    const r = controlador.vuelta({ query, cookies }, res, fallo);
    Promise.resolve(r).then(listo, fallo);
  });
  return destino;
}

test('si el tesista pulsa «Deny», vuelve al panel diciendo que no autorizó', async () => {
  assert.equal(
    await volver({ error: 'access_denied', state: 'x' }),
    'https://acostaresearch.com/perfil?mendeley=cancelado',
  );
});

test('una vuelta con el state de otro navegador acaba en el panel con error, no en JSON', async () => {
  const { state } = await servicio.empezar('U1');
  assert.equal(
    await volver({ code: 'C', state }, { mendeley_oauth: 'otro' }),
    'https://acostaresearch.com/perfil?mendeley=error',
  );
});
