'use strict';

/**
 * Las figuras incrustadas y los índices de tablas y de figuras.
 *
 * Las dos últimas diferencias que quedaban entre el Word del servidor y el que
 * armaba Claude en el chat: el servidor dejaba una marca amarilla para que el
 * tesista pegara a mano una imagen que él mismo acababa de dibujar en R, y no
 * generaba los dos índices que pide casi cualquier reglamento.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.docx');

/** Un PNG de verdad, del tamaño que se le pida: lo que devolvería R. */
function png(ancho, alto) {
  const crc = (datos) => {
    let c = ~0;
    for (const byte of datos) {
      c ^= byte;
      for (let i = 0; i < 8; i += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const trozo = (tipo, datos) => {
    const cabecera = Buffer.alloc(8);
    cabecera.writeUInt32BE(datos.length, 0);
    cabecera.write(tipo, 4, 'ascii');
    const cola = Buffer.alloc(4);
    cola.writeUInt32BE(crc(Buffer.concat([Buffer.from(tipo, 'ascii'), datos])), 0);
    return Buffer.concat([cabecera, datos, cola]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ancho, 0);
  ihdr.writeUInt32BE(alto, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 2; // color verdadero
  const pixeles = Buffer.alloc(alto * (1 + ancho * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(pixeles)),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

const CON_FIGURA = [
  '**Figura 1**',
  '*Distribución de la motivación*',
  '[Insertar aquí la Figura 1: histograma.png]',
  '*Nota.* Elaboración propia.',
].join('\n');

async function wordDe(capitulos, opciones = {}) {
  const buffer = await documento.armar({ tema: 'Tema', nombre: 'Alguien', capitulos, ...opciones });
  const zip = new AdmZip(buffer);
  return {
    zip,
    cuerpo: zip.getEntry('word/document.xml').getData().toString('utf8'),
  };
}

/** El texto de cada <w:t>, en orden. */
const textos = (xml) => [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]);

// ── Las figuras ─────────────────────────────────────────────────────────────

test('con el PNG en la sesión, la figura se incrusta en su sitio', async () => {
  const { zip, cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_FIGURA }], {
    figuras: new Map([['histograma.png', png(1600, 1100)]]),
  });

  // La imagen está dentro del documento, y el archivo va en el paquete.
  assert.match(cuerpo, /<w:drawing>/);
  assert.ok(
    zip.getEntries().some((e) => /^word\/media\//.test(e.entryName)),
    zip.getEntries().map((e) => e.entryName).join(' | '),
  );

  // Y ya no hay marca que pegar a mano.
  assert.ok(!textos(cuerpo).some((t) => t.includes('Insertar aquí')));
  assert.ok(!cuerpo.includes('w:highlight'));

  // El rótulo y la nota se quedan donde estaban.
  assert.ok(textos(cuerpo).includes('Figura 1'));
  assert.ok(textos(cuerpo).includes('Distribución de la motivación'));
  assert.ok(textos(cuerpo).includes('Nota.'));
});

test('la figura se encoge hasta el ancho de la caja de texto, sin deformarse', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_FIGURA }], {
    figuras: new Map([['histograma.png', png(1600, 1100)]]),
  });

  const extension = cuerpo.match(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/);
  const [ancho, alto] = [Number(extension[1]), Number(extension[2])];
  // docx trabaja en EMU: 9525 por píxel. 560 px es el ancho máximo.
  assert.equal(Math.round(ancho / 9525), 560);
  assert.equal(Math.round(alto / 9525), Math.round((560 * 1100) / 1600));
});

test('sin el PNG, la figura sigue saliendo con su marca para pegarla a mano', async () => {
  for (const figuras of [null, new Map(), new Map([['otra.png', png(10, 10)]])]) {
    const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_FIGURA }], { figuras });
    assert.ok(textos(cuerpo).some((t) => t.includes('Insertar aquí la Figura 1: histograma.png')));
    assert.ok(!cuerpo.includes('<w:drawing>'));
  }
});

test('unos bytes que no son un PNG no rompen el Word: sale la marca', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_FIGURA }], {
    figuras: new Map([['histograma.png', Buffer.from('esto no es una imagen')]]),
  });
  assert.ok(textos(cuerpo).some((t) => t.includes('Insertar aquí')));
});

test('se sabe qué archivos pide un capítulo, en las dos formas de escribirlos', () => {
  const texto = [
    '**Figura 1**\n*Uno*\n[Insertar aquí la Figura 1: uno.png]',
    '**Figura 2**\n*Dos*\n![](dos.png)',
    '**Figura 3**\n*Tres*\n[Insertar aquí la Figura 3: uno.png]',
    'La Figura 1 muestra que foto.png no es una figura.',
  ].join('\n\n');

  assert.deepEqual(documento.figurasDe(texto), ['uno.png', 'dos.png']);
});

// ── Los índices de tablas y de figuras ──────────────────────────────────────

const CON_TABLA_Y_FIGURA = [
  'Un párrafo del capítulo.',
  '',
  '**Tabla 1**',
  '*Estudiantes por ciclo*',
  '| Ciclo | Frecuencia |',
  '|---|---|',
  '| I | 43 |',
  '',
  '**Figura 1**',
  '*Evolución de la matrícula*',
  '[Insertar aquí la Figura 1: matricula.png]',
  '',
  '**Tabla 2**',
  '*Alfa de Cronbach*',
  '| Escala | Alfa |',
  '|---|---|',
  '| Clima | 0,87 |',
].join('\n');

/** Las entradas de un índice del documento, por su título. */
function entradasDe(cuerpo, titulo) {
  const desde = cuerpo.indexOf(`>${titulo}<`);
  if (desde === -1) return null;
  const resto = cuerpo.slice(desde);
  const hasta = resto.slice(1).search(/<w:pStyle w:val="(?:TOCHeading|Heading1)"\/>/);
  return textos(hasta === -1 ? resto : resto.slice(0, hasta)).filter((t) => /^(Tabla|Figura)\s/.test(t));
}

test('el Word trae índice de tablas y de figuras, con su rótulo y su título', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_TABLA_Y_FIGURA }]);

  assert.deepEqual(entradasDe(cuerpo, 'Índice de tablas'), [
    'Tabla 1. Estudiantes por ciclo',
    'Tabla 2. Alfa de Cronbach',
  ]);
  assert.deepEqual(entradasDe(cuerpo, 'Índice de figuras'), ['Figura 1. Evolución de la matrícula']);
});

test('cada entrada lleva su número de página como campo, para que Word lo rehaga', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_TABLA_Y_FIGURA }]);

  // Un marcador por rótulo, y su PAGEREF en la entrada.
  assert.match(cuerpo, /<w:bookmarkStart w:id="\d+" w:name="_RotAR0001"\/>/);
  assert.match(cuerpo, /PAGEREF _RotAR0001/);
  // Y el número que se ve mientras Word no lo actualice.
  const entrada = cuerpo.slice(cuerpo.indexOf('PAGEREF _RotAR0001'));
  assert.match(entrada.slice(0, 400), /<w:t xml:space="preserve">\d+<\/w:t>/);
});

test('los índices van entre el general y el primer capítulo, y empiezan hoja', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto: CON_TABLA_Y_FIGURA }]);

  // El título del capítulo se busca por su estilo: «Capítulo IV» a secas sale
  // antes, dentro del índice general, que es su entrada.
  const orden = [
    cuerpo.indexOf('>Índice<'),
    cuerpo.indexOf('>Índice de tablas<'),
    cuerpo.indexOf('>Índice de figuras<'),
    cuerpo.indexOf('<w:pStyle w:val="Heading1"/>'),
  ];
  assert.ok(
    orden.every((pos, i) => pos !== -1 && (i === 0 || pos > orden[i - 1])),
    `orden: ${orden.join(', ')}`,
  );

  // Cada uno en su hoja: si no, el índice de tablas sigue al general a media página.
  const deTablas = cuerpo.lastIndexOf('<w:p>', cuerpo.indexOf('>Índice de tablas<'));
  assert.match(cuerpo.slice(deTablas, cuerpo.indexOf('>Índice de tablas<')), /<w:pageBreakBefore\/>/);
});

test('una tesis sin tablas ni figuras no gana dos hojas en blanco', async () => {
  const { cuerpo } = await wordDe([{ titulo: 'Capítulo I', texto: 'Solo texto, sin nada que listar.' }]);

  assert.ok(!cuerpo.includes('Índice de tablas'));
  assert.ok(!cuerpo.includes('Índice de figuras'));
  // Y el índice general sigue ahí.
  assert.ok(cuerpo.includes('>Índice<'));
});

test('las hojas de los dos índices corren la numeración del cuerpo', async () => {
  const numeroDelCapitulo = async (texto) => {
    const { cuerpo } = await wordDe([{ titulo: 'Capítulo IV', texto }]);
    const entrada = cuerpo.slice(cuerpo.indexOf('PAGEREF _TocAR0001'));
    return Number(entrada.match(/<w:t xml:space="preserve">(\d+)<\/w:t>/)[1]);
  };

  // El mismo capítulo, con y sin cosas que listar: con dos índices por delante,
  // empieza dos hojas más allá. Antes se contaban como si no existieran.
  const sinNada = await numeroDelCapitulo('Un párrafo del capítulo.');
  const conListas = await numeroDelCapitulo(CON_TABLA_Y_FIGURA);
  assert.equal(conListas, sinNada + 2, `sin listas: ${sinNada}, con listas: ${conListas}`);
});

test('la numeración por capítulo también entra en los índices', async () => {
  // «Tabla 1.1» es una de las dos numeraciones que ofrece el método, y sin el
  // punto no se reconocía como rótulo: quien la elegía se quedaba sin índice de
  // tablas y sin números de página, sin que nada se lo dijera.
  const { cuerpo } = await wordDe([
    {
      titulo: 'Capítulo I',
      texto: [
        '**Tabla 1.1**',
        '*Matriz de consistencia*',
        '| Problema | Objetivo |',
        '|---|---|',
        '| PG | OG |',
        '',
        '**Figura 1.2**',
        '*Modelo del estudio*',
        '[Insertar aquí la Figura 1.2: modelo.png]',
      ].join('\n'),
    },
  ]);

  assert.deepEqual(entradasDe(cuerpo, 'Índice de tablas'), ['Tabla 1.1. Matriz de consistencia']);
  assert.deepEqual(entradasDe(cuerpo, 'Índice de figuras'), ['Figura 1.2. Modelo del estudio']);
});
