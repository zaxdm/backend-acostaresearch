'use strict';

/**
 * La lectura de las entrevistas: de Word, de texto y de PDF a párrafos.
 *
 * Lo que tiene que ser cierto:
 *
 *   · de un Word sale un párrafo por párrafo, en orden y sin los vacíos;
 *   · de un .txt, uno por línea, también si viene en Latin-1;
 *   · de un PDF, las líneas de una misma frase se juntan, cada turno empieza
 *     párrafo y los números de página se van;
 *   · un PDF sin texto, una imagen o un .doc se rechazan diciendo qué hacer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { Document, Packer, Paragraph } = require('docx');

const { leer, juntarLineas, partirLargo, EntrevistaNoValida, PARRAFO_MAXIMO } = require(
  '../src/modules/cualitativo/cualitativo.lectura',
);

/** Un PDF mínimo, a mano, con una línea de texto por elemento de `lineas` (una página cada `porPagina`). */
function pdfCon(lineas, { porPagina = 40 } = {}) {
  const paginas = [];
  for (let i = 0; i < lineas.length; i += porPagina) paginas.push(lineas.slice(i, i + porPagina));
  if (paginas.length === 0) paginas.push([]);

  const objetos = [];
  const agregar = (cuerpo) => objetos.push(cuerpo) && objetos.length;
  const catalogo = agregar(null);
  const arbol = agregar(null);
  const fuente = agregar('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const hijos = [];
  for (const pagina of paginas) {
    const escapar = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const flujo = ['BT', '/F1 11 Tf', '14 TL', '50 780 Td', ...pagina.map((l) => `(${escapar(l)}) Tj T*`), 'ET'].join('\n');
    const contenido = agregar(`<< /Length ${Buffer.byteLength(flujo, 'latin1')} >>\nstream\n${flujo}\nendstream`);
    hijos.push(
      agregar(
        `<< /Type /Page /Parent ${arbol} 0 R /MediaBox [0 0 595 842] ` +
          `/Resources << /Font << /F1 ${fuente} 0 R >> >> /Contents ${contenido} 0 R >>`,
      ),
    );
  }
  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${arbol} 0 R >>`;
  objetos[arbol - 1] = `<< /Type /Pages /Kids [${hijos.map((h) => `${h} 0 R`).join(' ')}] /Count ${hijos.length} >>`;

  let salida = '%PDF-1.4\n';
  const posiciones = [];
  objetos.forEach((cuerpo, i) => {
    posiciones.push(Buffer.byteLength(salida, 'latin1'));
    salida += `${i + 1} 0 obj\n${cuerpo}\nendobj\n`;
  });
  const xref = Buffer.byteLength(salida, 'latin1');
  salida += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const p of posiciones) salida += `${String(p).padStart(10, '0')} 00000 n \n`;
  salida += `trailer\n<< /Size ${objetos.length + 1} /Root ${catalogo} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(salida, 'latin1');
}

test('Word: un párrafo por párrafo, sin los vacíos', async () => {
  const doc = new Document({
    sections: [
      {
        children: [
          new Paragraph('Entrevistador: ¿Cómo fue su experiencia con el asesor?'),
          new Paragraph(''),
          new Paragraph('Participante: Nunca respondía mis correos, tuve que buscar ayuda afuera.'),
        ],
      },
    ],
  });
  const { formato, parrafos } = await leer(await Packer.toBuffer(doc));
  assert.equal(formato, 'docx');
  assert.deepEqual(parrafos, [
    'Entrevistador: ¿Cómo fue su experiencia con el asesor?',
    'Participante: Nunca respondía mis correos, tuve que buscar ayuda afuera.',
  ]);
});

test('texto: una línea por párrafo, con espacios normalizados', async () => {
  const { formato, parrafos } = await leer(Buffer.from('﻿E: Hola.\r\n\r\nP:   Buenos días.\n', 'utf8'));
  assert.equal(formato, 'txt');
  assert.deepEqual(parrafos, ['E: Hola.', 'P: Buenos días.']);
});

test('texto en Latin-1: las tildes se leen bien', async () => {
  const { parrafos } = await leer(Buffer.from('P: Sí, la tesis me costó.', 'latin1'));
  assert.deepEqual(parrafos, ['P: Sí, la tesis me costó.']);
});

test('PDF: junta las líneas de una frase, corta en cada turno y quita el número de página', async () => {
  const buffer = pdfCon([
    'Entrevistador: ¿Cómo fue su experiencia',
    'con el asesor de tesis?',
    'Participante: Nunca respondía mis correos, así que',
    'tuve que buscar ayuda afuera.',
    '2',
  ]);
  const { formato, parrafos } = await leer(buffer);
  assert.equal(formato, 'pdf');
  assert.deepEqual(parrafos, [
    'Entrevistador: ¿Cómo fue su experiencia con el asesor de tesis?',
    'Participante: Nunca respondía mis correos, así que tuve que buscar ayuda afuera.',
  ]);
});

test('PDF sin texto: se rechaza como escaneado', async () => {
  await assert.rejects(leer(pdfCon([])), (e) => e instanceof EntrevistaNoValida && /escaneado/.test(e.message));
});

test('juntarLineas: una palabra partida con guion se vuelve a unir', () => {
  assert.deepEqual(juntarLineas(['Fue una entre-', 'vista larga.']), ['Fue una entrevista larga.']);
});

test('juntarLineas: la línea en blanco separa párrafos', () => {
  assert.deepEqual(juntarLineas(['Primera idea', '', 'segunda idea']), ['Primera idea', 'segunda idea']);
});

test('partirLargo: un párrafo enorme se parte por frases, sin perder texto', () => {
  const frase = 'Esta es una frase de prueba bastante normal. ';
  const largo = frase.repeat(Math.ceil((PARRAFO_MAXIMO * 2.5) / frase.length)).trim();
  const partes = partirLargo(largo);
  assert.ok(partes.length >= 3);
  assert.ok(partes.every((p) => p.length <= PARRAFO_MAXIMO));
  assert.ok(partes.every((p) => p.endsWith('.')));
  assert.equal(partes.join(' ').replace(/\s+/g, ' '), largo.replace(/\s+/g, ' '));
});

test('imagen y .doc antiguo: se rechazan diciendo qué hacer', async () => {
  await assert.rejects(leer(Buffer.from('89504e470d0a1a0a0000', 'hex')), /imagen/);
  await assert.rejects(leer(Buffer.from('d0cf11e0a1b11ae10000', 'hex')), /\.doc antiguo/);
  await assert.rejects(leer(Buffer.alloc(0)), /vacío/);
});

test('juntarLineas: un punto al borde de un renglón lleno no corta el párrafo', () => {
  const lleno = 'Participante: Mi asesor sabe mucho del tema técnico, pero de metodología casi nada.';
  const lineas = [
    'Entrevistador: ¿Cómo ha sido la relación con tu asesor de tesis durante el proceso?',
    lleno,
    'Cuando le pregunté cómo redactar los objetivos me dijo que eso lo viera con el otro,',
    'y el metodólogo me dijo que eso era cosa del asesor. Me mandaban de un lado a otro.',
    'Así estuve casi todo el semestre pasado sin saber a quién hacerle caso de verdad ya.',
    'Al final.',
    'Otra idea que empieza aquí mismo.',
  ];
  const parrafos = juntarLineas(lineas);
  assert.equal(parrafos.length, 3);
  assert.match(parrafos[1], /casi nada\. Cuando le pregunté/);
  assert.equal(parrafos[2], 'Otra idea que empieza aquí mismo.');
});
