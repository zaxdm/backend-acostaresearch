'use strict';

/**
 * Los usuarios beta de «Preparar documento»: sin tope y sin membresía.
 *
 * Los que están en `PREPARAR_ILIMITADO_EMAILS` (24-sep-2026). Lo que se fija
 * aquí es que la lista abre la puerta a quien está y a nadie más, y que sus
 * trabajos no cuelgan de una membresía: si tiene una comprada, no le gastan de
 * ella.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

let correo;
let pack;
let creadas;

falsificar('../src/modules/preparar/preparar.repository', {
  correoDe: async () => correo,
  membresiaDe: async () => pack,
  usadosEn: async () => 0,
  listarDe: async () => [],
  rescatables: async () => [],
  // El trabajo arranca solo detrás del encargo; aquí no se sigue, se para en seco.
  marcar: async () => null,
  crear: async (data) => {
    creadas.push(data);
    return { id: 'p1', ...data };
  },
});

falsificar('../src/modules/preparar/preparar.storage', {
  guardarEntrada: async () => {},
  // Lo que pide el trabajo de fondo al arrancar: sin entrada, se para ahí.
  leerEntrada: async () => {
    throw new Error('sin entrada en la prueba');
  },
});

// Una copia de la configuración que se pueda cambiar prueba a prueba: la de
// verdad está congelada.
const env = { ...require('../src/config/env') };
falsificar('../src/config/env', env);

const prepararService = require('../src/modules/preparar/preparar.service');

const PACK_COMPRADO = {
  id: 'pack-1',
  status: 'ACTIVE',
  docsPorMes: 10,
  activatedAt: new Date('2026-09-01T00:00:00Z'),
  expiresAt: new Date('2026-10-01T00:00:00Z'),
  plan: { code: 'DOCS_MES', name: 'Mensual', durationDays: 30 },
};

test.beforeEach(() => {
  env.PREPARAR_ILIMITADO_EMAILS = 'beta@ejemplo.pe, otra@ejemplo.pe';
  correo = null;
  pack = null;
  creadas = [];
});

const AHORA = new Date('2026-09-24T12:00:00Z');

test('el correo de la lista puede mandar sin membresía, sin mayúsculas que valgan', async () => {
  correo = 'Beta@Ejemplo.pe';

  const { cupo, motivo, ilimitado } = await prepararService.cupoDe('u1', AHORA);

  assert.equal(ilimitado, true);
  assert.equal(motivo, null);
  assert.equal(cupo, null);
});

test('quien no está en la lista sigue necesitando su membresía', async () => {
  correo = 'cliente@ejemplo.pe';

  const { motivo, ilimitado } = await prepararService.cupoDe('u2', AHORA);

  assert.notEqual(ilimitado, true);
  assert.match(motivo, /Necesitas una membresía/);
});

test('con la variable vacía no es ilimitado nadie', async () => {
  env.PREPARAR_ILIMITADO_EMAILS = '';
  correo = 'beta@ejemplo.pe';

  const { motivo } = await prepararService.cupoDe('u1', AHORA);

  assert.match(motivo, /Necesitas una membresía/);
});

test('el panel lo dice, para que la web no le ofrezca comprar', async () => {
  correo = 'otra@ejemplo.pe';

  const panel = await prepararService.panel('u1', AHORA);

  assert.equal(panel.ilimitado, true);
  assert.equal(panel.motivo, null);
});

test('un beta con membresía comprada no gasta de ella: su trabajo no cuelga de ninguna', async () => {
  correo = 'beta@ejemplo.pe';
  pack = PACK_COMPRADO;
  env.prepararEnabled = true;

  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>` +
        '<w:p><w:r><w:t xml:space="preserve">The results shows a clear effect.</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));

  const { cupo } = await prepararService.encargar(
    { userId: 'u1', servicio: 'EDICION', buffer: zip.toBuffer(), nombre: 'tesis.docx' },
    AHORA,
  );

  assert.equal(creadas.length, 1);
  assert.equal(creadas[0].docPackId, null);
  assert.equal(cupo, null);
});
