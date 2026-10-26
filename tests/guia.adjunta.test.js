'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * El correo del código de activación lleva la guía de instalación en PDF. Se
 * lee de GUIAS_DIR, la misma carpeta que sirve /guias/guia-instalacion.pdf, y
 * si falta el correo tiene que salir igual, sin adjunto.
 */

const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'guias-'));
process.env.GUIAS_DIR = carpeta;

const { guiaDeInstalacion } = require('../src/lib/guiaAdjunta');

test('sin el PDF en la carpeta no adjunta nada y no falla', async () => {
  assert.deepEqual(await guiaDeInstalacion(), []);
});

test('con el PDF lo adjunta como guia-de-instalacion.pdf', async () => {
  const pdf = Buffer.from('%PDF-1.7 prueba');
  fs.writeFileSync(path.join(carpeta, 'guia-instalacion.pdf'), pdf);

  const [adjunto, ...resto] = await guiaDeInstalacion();
  assert.equal(resto.length, 0);
  assert.equal(adjunto.filename, 'guia-de-instalacion.pdf');
  assert.equal(adjunto.contentType, 'application/pdf');
  assert.deepEqual(adjunto.content, pdf);
});
