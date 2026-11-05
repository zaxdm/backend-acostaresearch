'use strict';

/**
 * Zotero y Mendeley desde AcostaIA (5-nov-2026).
 *
 * Lo que se prueba: el pase sirve una sola vez y caduca a los 2 minutos; sin
 * `ACOSTAIA_URL` no se dan pases; canjearlo empieza el intercambio de siempre
 * con el titular espejo; la vuelta reconoce UNA vez el intercambio que salió de
 * AcostaIA (y uno ajeno no); y sin titular todavía, nada está conectado.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const envFalso = {
  ACOSTAIA_URL: 'https://ia.ejemplo.pe',
  APP_URL: 'https://acostaresearch.com',
  API_PREFIX: '/api/v1',
  zoteroOauthEnabled: true,
  mendeleyOauthEnabled: true,
};
sustituir('../src/config/env', envFalso);

sustituir('../src/lib/prisma', {
  user: {
    findUnique: async ({ where }) => (where.acostaiaId === 'usr_12345678' ? { id: 'espejo-1' } : null),
  },
});

const empezados = [];
sustituir('../src/modules/zotero/biblioteca.service', {
  empezar: async (userId) => {
    empezados.push(userId);
    return { url: 'https://www.zotero.org/oauth/authorize?oauth_token=tok-1', token: 'tok-1' };
  },
  estado: async () => ({ disponible: true, conectado: true, usuario: 'ana' }),
});
sustituir('../src/modules/mendeley/mendeley.service', {
  empezar: async () => ({ url: 'https://api.mendeley.com/oauth/authorize?state=st-1', state: 'st-1' }),
  estado: async () => ({ disponible: true, conectado: false }),
});

const conectores = require('../src/modules/acostaia/acostaia.conectores');

const paseDe = (url) => new URL(url).searchParams.get('pase');

test('el pase lleva a la ruta de ir del backend y empieza el intercambio del titular espejo', async () => {
  const { url } = await conectores.pase({ acostaiaId: 'usr_12345678', cual: 'zotero' });
  assert.ok(url.startsWith('https://acostaresearch.com/api/v1/acostaia/conectores/ir?pase='));
  const ido = await conectores.ir(paseDe(url));
  assert.deepEqual(ido, { cual: 'zotero', url: 'https://www.zotero.org/oauth/authorize?oauth_token=tok-1', marca: 'tok-1' });
  assert.deepEqual(empezados, ['espejo-1']);
});

test('el pase sirve una sola vez', async () => {
  const { url } = await conectores.pase({ acostaiaId: 'usr_12345678', cual: 'mendeley' });
  await conectores.ir(paseDe(url));
  await assert.rejects(conectores.ir(paseDe(url)), /ya se usó o caducó/);
});

test('el pase caduca a los 2 minutos', async () => {
  const ahora = Date.now();
  const { url } = await conectores.pase({ acostaiaId: 'usr_12345678', cual: 'zotero' }, ahora);
  await assert.rejects(conectores.ir(paseDe(url), ahora + 2 * 60 * 1000 + 1), /ya se usó o caducó/);
});

test('la vuelta reconoce una vez el intercambio de AcostaIA; uno ajeno, no', async () => {
  const { url } = await conectores.pase({ acostaiaId: 'usr_12345678', cual: 'mendeley' });
  await conectores.ir(paseDe(url));
  assert.equal(conectores.esDeAcostaIA('mendeley', 'st-1'), true);
  assert.equal(conectores.esDeAcostaIA('mendeley', 'st-1'), false, 'solo una vez');
  assert.equal(conectores.esDeAcostaIA('zotero', 'de-un-tesista-del-perfil'), false);
  assert.equal(conectores.esDeAcostaIA('zotero', undefined), false);
  assert.equal(
    conectores.urlDeVuelta('mendeley', 'ok'),
    'https://ia.ejemplo.pe/personalizacion?ver=conectores&mendeley=ok',
  );
});

test('sin titular todavía no se da pase, y nada está conectado', async () => {
  await assert.rejects(conectores.pase({ acostaiaId: 'usr_nuevo0000', cual: 'zotero' }), /Abre tu primer chat/);
  assert.deepEqual(await conectores.estado({ acostaiaId: 'usr_nuevo0000' }), {
    zotero: { disponible: true, conectado: false },
    mendeley: { disponible: true, conectado: false },
  });
});

test('sin ACOSTAIA_URL, conectar desde AcostaIA está apagado', async () => {
  const antes = envFalso.ACOSTAIA_URL;
  envFalso.ACOSTAIA_URL = undefined;
  try {
    await assert.rejects(conectores.pase({ acostaiaId: 'usr_12345678', cual: 'zotero' }), /no está configurado/);
  } finally {
    envFalso.ACOSTAIA_URL = antes;
  }
});
