'use strict';

/**
 * Lo que sale de la codificación: tablas, red, citas del capítulo y .qdpx.
 *
 * Lo que tiene que ser cierto:
 *
 *   · las frecuencias y la coocurrencia cuentan citas, y el coeficiente c es el
 *     de ATLAS.ti;
 *   · las tablas salen en el Markdown que entiende el Word;
 *   · una cita del capítulo que no está en las entrevistas se detecta; los
 *     cortes con […], la mayúscula inicial y los nombres de código, no;
 *   · en el .qdpx cada cita apunta, por sus posiciones, exactamente a su texto;
 *   · la red no mete ningún nombre de código en el código de R;
 *   · una cita en bloque «> …» sale en el Word sangrada y sin el «>».
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const tablas = require('../src/modules/cualitativo/cualitativo.tablas');
const citas = require('../src/modules/cualitativo/cualitativo.citas');
const qdpx = require('../src/modules/cualitativo/cualitativo.qdpx');
const red = require('../src/modules/cualitativo/cualitativo.red');
const reglas = require('../src/modules/cualitativo/cualitativo.codificacion');
const informeWord = require('../src/modules/r/r.informe');

const ENTREVISTAS = [
  {
    id: 'E1',
    nombre: 'Ana.docx',
    parrafos: [
      'Entrevistador: ¿Cómo fue su experiencia con el asesor?',
      'Participante: El profesor nunca respondía mis correos, tuve que buscar ayuda afuera. Me dio “mucha” pena.',
    ],
  },
  { id: 'E2', nombre: 'Luis.pdf', parrafos: ['P: Trabajo de día y estudio de noche; no me alcanza el tiempo 😩 para nada.'] },
];

function codificado() {
  let { codificacion } = reglas.codificar(null, ENTREVISTAS[0], {
    codigos: [
      { nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.', categoria: 'Barreras' },
      { nombre: 'Ayuda externa', definicion: 'Busca apoyo fuera.', categoria: 'Estrategias' },
      { nombre: 'Vergüenza', definicion: 'Siente pena.', categoria: 'Emociones' },
    ],
    citas: [
      { parrafo: 2, texto: 'El profesor nunca respondía mis correos', codigos: ['Falta de apoyo docente'] },
      { parrafo: 2, texto: 'tuve que buscar ayuda afuera.', codigos: ['Ayuda externa', 'Falta de apoyo docente'] },
      { parrafo: 2, texto: 'Me dio “mucha” pena.', codigos: ['Vergüenza', 'Falta de apoyo docente'] },
    ],
  });
  ({ codificacion } = reglas.codificar(codificacion, ENTREVISTAS[1], {
    codigos: [{ nombre: 'Falta de tiempo', definicion: 'No le alcanza.', categoria: 'Barreras' }],
    citas: [{ parrafo: 1, texto: 'no me alcanza el tiempo 😩 para nada.', codigos: ['Falta de tiempo'] }],
  }));
  return codificacion;
}

// ── Tablas ─────────────────────────────────────────────────────────────────

test('frecuencias: citas y entrevistas por código, agrupados por categoría', () => {
  const f = tablas.frecuencias(ENTREVISTAS, codificado());
  const apoyo = f.find((c) => c.nombre === 'Falta de apoyo docente');
  assert.equal(apoyo.citas, 3);
  assert.equal(apoyo.entrevistas, 1);
  assert.deepEqual(apoyo.porEntrevista, { E1: 3, E2: 0 });
  assert.equal(f[0].categoria, 'Barreras', 'ordenados por categoría');
});

test('coocurrencia: pares en la misma cita, con el coeficiente c de ATLAS.ti', () => {
  const pares = tablas.coocurrencias(codificado());
  assert.equal(pares.length, 2);
  const par = pares.find((p) => p.a === 'Ayuda externa');
  assert.equal(par.b, 'Falta de apoyo docente');
  assert.equal(par.n, 1);
  // n12 / (n1 + n2 − n12) = 1 / (1 + 3 − 1)
  assert.equal(par.c, 1 / 3);
});

test('las tablas salen en el Markdown que entiende el Word', () => {
  const md = tablas.tablaDeFrecuencias(ENTREVISTAS, codificado());
  const lineas = md.split('\n');
  const partida = require('../src/modules/projects/project.docx').partirTabla(lineas);
  assert.ok(partida, 'el Word reconoce la tabla');
  assert.deepEqual(partida.antes, ['**Tabla X**', '*Frecuencia de los códigos por entrevista*']);
  assert.deepEqual(partida.cabecera, ['Categoría', 'Código', 'E1', 'E2', 'Citas', 'Entrevistas']);
  assert.match(partida.despues[0], /^\*Nota\.\* .*Total de citas codificadas: 4\./);
  assert.match(tablas.tablaDeCoocurrencia(codificado()), /\| Ayuda externa \| Falta de apoyo docente \| 1 \| 0,33 \|/);
});

test('sin pares que compartan cita no hay tabla de coocurrencia', () => {
  const { codificacion } = reglas.codificar(null, ENTREVISTAS[1], {
    codigos: [{ nombre: 'Tiempo', definicion: 'x' }],
    citas: [{ parrafo: 1, texto: 'no me alcanza el tiempo', codigos: ['Tiempo'] }],
  });
  assert.equal(tablas.tablaDeCoocurrencia(codificacion), null);
});

// ── Citas del capítulo ─────────────────────────────────────────────────────

test('citas del capítulo: detecta la inventada y acepta cortes, mayúscula y nombres de código', () => {
  const capitulo = [
    '## Barreras institucionales',
    'Sobre el asesor, una participante contó que «el profesor nunca respondía mis correos, tuve que buscar ayuda afuera» (E1, ¶2).',
    'Otro dijo: "Trabajo de día […] no me alcanza el tiempo 😩 para nada" (E2, ¶1).',
    'El código «Falta de apoyo docente del asesor principal» agrupa estas menciones.',
    'Y también que "el asesor me gritaba en todas las reuniones" (E1, ¶2).',
    '',
    '> Participante: El profesor nunca respondía mis correos, tuve que buscar ayuda afuera. (E1, ¶2)',
  ].join('\n\n');
  const codificacion = codificado();
  codificacion.codigos.push({ nombre: 'Falta de apoyo docente del asesor principal', definicion: 'x', categoria: null });

  const { revisadas, faltan } = citas.comprobar(capitulo, ENTREVISTAS, codificacion);
  assert.deepEqual(faltan, ['el asesor me gritaba en todas las reuniones']);
  assert.equal(revisadas, 4);
});

test('una cita corta (menos de cinco palabras) no se comprueba', () => {
  assert.deepEqual(citas.comprobar('Lo llamó «un desastre total».', ENTREVISTAS, null).faltan, []);
});

// ── .qdpx ──────────────────────────────────────────────────────────────────

test('.qdpx: cada cita apunta, por sus posiciones, exactamente a su texto', () => {
  const codificacion = codificado();
  const zip = new AdmZip(qdpx.armar({ entrevistas: ENTREVISTAS, codificacion, titulo: 'Tesis & "pruebas"' }));
  const xml = zip.getEntry('project.qde').getData().toString('utf8');

  assert.match(xml, /^<\?xml version="1.0" encoding="utf-8"\?>\n<Project xmlns="urn:QDA-XML:project:1.0"/);
  assert.match(xml, /name="Tesis &amp; &quot;pruebas&quot;"/);
  assert.match(xml, /<Code guid="[^"]+" name="Barreras" isCodable="false"/);
  assert.match(xml, /<Description>El docente no orienta\.<\/Description>/);

  const fuentes = [...xml.matchAll(/<TextSource guid="([^"]+)" name="([^"]+)" plainTextPath="internal:\/\/([^"]+)"/g)];
  assert.equal(fuentes.length, 2);

  let comprobadas = 0;
  for (const [, id, , archivo] of fuentes) {
    assert.equal(archivo, `${id}.txt`);
    const plano = [...zip.getEntry(`sources/${archivo}`).getData().toString('utf8')];
    const bloque = xml.slice(xml.indexOf(`<TextSource guid="${id}"`), xml.indexOf('</TextSource>', xml.indexOf(id)));
    for (const [, inicio, fin] of bloque.matchAll(/startPosition="(\d+)" endPosition="(\d+)"/g)) {
      const trozo = plano.slice(Number(inicio), Number(fin)).join('');
      assert.ok(
        codificacion.citas.some((c) => c.texto === trozo),
        `la posición ${inicio}-${fin} da «${trozo}», que no es ninguna cita`,
      );
      comprobadas += 1;
    }
  }
  assert.equal(comprobadas, codificacion.citas.length);

  // Cada Coding apunta a un código que existe.
  const guids = new Set([...xml.matchAll(/<Code guid="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...xml.matchAll(/<CodeRef targetGUID="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(refs.length, 6);
  assert.ok(refs.every((r) => guids.has(r)));
});

test('.qdpx: el texto plano va sin BOM y con los párrafos por líneas', () => {
  const zip = new AdmZip(qdpx.armar({ entrevistas: ENTREVISTAS, codificacion: codificado() }));
  const fuente = zip.getEntries().find((e) => e.entryName.startsWith('sources/'));
  const bytes = fuente.getData();
  assert.notEqual(bytes[0], 0xef);
  assert.ok(bytes.toString('utf8').split('\n').length >= 1);
});

// ── Red ────────────────────────────────────────────────────────────────────

test('red: los nombres de código van en el CSV, nunca en el código de R', () => {
  const codificacion = codificado();
  codificacion.codigos[0].nombre = 'x"); system("rm -rf /'; // un nombre malicioso
  for (const c of codificacion.citas) c.codigos = c.codigos.map((n) => (n === 'Falta de apoyo docente' ? codificacion.codigos[0].nombre : n));
  const datos = red.datos(ENTREVISTAS, codificacion);
  assert.match(datos.nodos, /"x""\); system\(""rm -rf \/"/);
  assert.ok(!red.GUION.includes('system('));
  assert.equal(datos.codigos, 4);
  assert.equal(datos.lazos, 2);
});

// ── Word ───────────────────────────────────────────────────────────────────

test('Word: la cita en bloque sale sangrada entera y sin el «>»', async () => {
  const buffer = await informeWord.armar({
    texto: 'Texto normal.\n\n> El profesor nunca respondía mis correos, tuve que buscar ayuda afuera. (E1, ¶2)',
  });
  const xml = new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');
  assert.ok(!xml.includes('&gt;'), 'el > no se imprime');
  const parrafo = xml.slice(xml.lastIndexOf('<w:p>', xml.indexOf('El profesor nunca')), xml.indexOf('El profesor nunca'));
  assert.match(parrafo, /<w:ind w:left="720"/);
});

// ── Avisos ─────────────────────────────────────────────────────────────────

test('avisos: sin citas con dos códigos se avisa que la red saldrá en puntos sueltos', () => {
  const codigos = Array.from({ length: 6 }, (_, i) => ({ nombre: `C${i}`, categoria: null }));
  const citas = Array.from({ length: 12 }, (_, i) => ({ entrevista: 'E1', codigos: [`C${i % 6}`] }));
  const dichos = tablas.avisos({ codigos, citas });
  assert.equal(dichos.length, 1);
  assert.match(dichos[0], /Solo 0 de 12 citas llevan más de un código/);
  assert.match(dichos[0], /puntos sueltos/);
});

test('avisos: un libro con demasiados códigos pide juntarlos', () => {
  const codigos = Array.from({ length: 34 }, (_, i) => ({ nombre: `C${i}`, categoria: null }));
  const citas = codigos.map((c, i) => ({ entrevista: 'E1', codigos: [c.nombre, `C${(i + 1) % 34}`] }));
  const dichos = tablas.avisos({ codigos, citas });
  assert.equal(dichos.length, 1, 'aquí sí hay coocurrencia, así que solo sobra el tamaño');
  assert.match(dichos[0], /34 códigos/);
  assert.match(dichos[0], /"renombrar"/);
});

test('avisos: un libro sano no dice nada', () => {
  assert.equal(tablas.avisos(codificado()), null);
});

test('red: se cuentan los códigos que no coocurren con ninguno', () => {
  const codificacion = codificado();
  codificacion.codigos.push({ nombre: 'Aislado', definicion: 'x', categoria: null });
  codificacion.citas.push({ entrevista: 'E2', parrafo: 1, inicio: 0, fin: 5, texto: 'P: Tr', codigos: ['Aislado'] });
  // «Falta de tiempo» ya estaba suelto: es el único código de su entrevista.
  assert.equal(red.datos(ENTREVISTAS, codificado()).sueltos, 1);
  assert.equal(red.datos(ENTREVISTAS, codificacion).sueltos, 2);
});
