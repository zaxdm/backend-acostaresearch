'use strict';

/**
 * El proyecto en .qdpx: el formato de intercambio REFI-QDA 1.0, que abren
 * ATLAS.ti, NVivo, MAXQDA y QualCoder.
 *
 * Es un zip con:
 *
 *   project.qde        el proyecto en XML: el libro de códigos, las fuentes y,
 *                      dentro de cada fuente, sus citas con los códigos puestos;
 *   sources/<guid>.txt cada transcripción en texto plano, UTF-8 sin BOM.
 *
 * El tesista que tiene uno de esos programas lo abre y encuentra su análisis ya
 * codificado, para seguir trabajando ahí. No hace falta para nada más: el
 * capítulo y las tablas salen del servidor.
 *
 * LAS POSICIONES
 * --------------
 * Cada cita se ubica por el carácter donde empieza y donde termina dentro del
 * texto plano de su fuente. El texto es el de los párrafos unidos por un salto
 * de línea, así que la posición es la de la cita en su párrafo más lo que ocupan
 * los párrafos anteriores. Se cuenta por caracteres de Unicode, no por unidades
 * de JavaScript: en castellano no cambia nada, con un emoji sí.
 *
 * LAS CATEGORÍAS
 * --------------
 * Van como códigos padre, con los códigos de la categoría dentro. Es lo que
 * importan todos esos programas; los «grupos de códigos» de ATLAS.ti no tienen
 * equivalente común en el formato.
 */

const crypto = require('node:crypto');
const AdmZip = require('adm-zip');

const NOMBRE = 'analisis-cualitativo.qdpx';
const COLORES = ['#E15759', '#4E79A7', '#59A14F', '#F28E2B', '#B07AA1', '#76B7B2', '#EDC948', '#FF9DA7', '#9C755F', '#BAB0AC'];

const guid = () => crypto.randomUUID();

/** Un texto para un atributo o un elemento de XML. */
function escapar(texto) {
  return String(texto ?? '')
    // Los caracteres de control no caben en XML 1.0: fuera, salvo el tabulador y los saltos.
    .split('')
    .filter((c) => c.charCodeAt(0) >= 32 || [9, 10, 13].includes(c.charCodeAt(0)))
    .join('')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * «E1 Ana García» a partir de «Ana García.docx»: QualCoder usa el nombre de la
 * fuente como nombre de archivo, y «.docx.txt» confunde.
 */
const nombreDeFuente = (e) => `${e.id} ${String(e.nombre).replace(/[.](docx|pdf|txt)$/i, '')}`.trim();

/** Cuántos caracteres de Unicode hay en un trozo de texto. */
const caracteres = (texto) => [...String(texto)].length;

/** El texto plano de la fuente y dónde empieza cada párrafo, en caracteres. */
function textoPlano(parrafos) {
  const inicios = [];
  let posicion = 0;
  for (const parrafo of parrafos) {
    inicios.push(posicion);
    posicion += caracteres(parrafo) + 1;
  }
  return { texto: parrafos.join('\n'), inicios };
}

/**
 * El .qdpx del proyecto, como Buffer.
 *
 * - `entrevistas`: `[{ id, nombre, parrafos }]`.
 * - `codificacion`: `{ codigos, citas }` (ver `cualitativo.codificacion`).
 * - `titulo`: el nombre del proyecto, el tema de la tesis.
 * - `ahora`: la fecha que se pone en todo; se pasa en las pruebas.
 */
function armar({
  entrevistas,
  codificacion,
  memos = [],
  titulo = 'Análisis cualitativo',
  autor = 'Tesista',
  ahora = new Date(),
}) {
  const fecha = ahora.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const usuario = guid();
  const quien = `creatingUser="${usuario}" creationDateTime="${fecha}"`;

  // El libro: cada categoría es un código padre, con los suyos dentro.
  const guidDe = new Map();
  const porCategoria = new Map();
  for (const codigo of codificacion?.codigos ?? []) {
    guidDe.set(codigo.nombre, guid());
    const categoria = codigo.categoria ?? null;
    if (!porCategoria.has(categoria)) porCategoria.set(categoria, []);
    porCategoria.get(categoria).push(codigo);
  }

  /** La definición del código y, debajo, los memos que el investigador escribió sobre él. */
  const descripcionDe = (codigo) => {
    const suyos = memos
      .filter((m) => m.tipo === 'codigo' && m.sobre === codigo.nombre)
      .map((m) => `Memo: ${m.texto}`);
    return [codigo.definicion, ...suyos].filter(Boolean).join('\n\n');
  };

  const codigoXml = (codigo, color, sangria) => {
    const descripcion = descripcionDe(codigo);
    return (
      `${sangria}<Code guid="${guidDe.get(codigo.nombre)}" name="${escapar(codigo.nombre)}" isCodable="true" color="${color}">` +
      (descripcion ? `<Description>${escapar(descripcion)}</Description>` : '') +
      '</Code>'
    );
  };

  const libro = [];
  let i = 0;
  for (const [categoria, codigos] of porCategoria) {
    const color = COLORES[i % COLORES.length];
    i += 1;
    if (categoria === null) {
      for (const codigo of codigos) libro.push(codigoXml(codigo, color, '      '));
      continue;
    }
    libro.push(
      `      <Code guid="${guid()}" name="${escapar(categoria)}" isCodable="false" color="${color}">`,
      ...codigos.map((codigo) => codigoXml(codigo, color, '        ')),
      '      </Code>',
    );
  }

  // Los atributos de los participantes viajan como variables de cada fuente:
  // es lo que ATLAS.ti enseña como grupos y lo que NVivo llama clasificaciones.
  const variables = [...new Set(entrevistas.flatMap((e) => Object.keys(e.atributos ?? {})))];
  const guidDeVariable = new Map(variables.map((v) => [v, guid()]));

  // Las fuentes, cada una con sus citas.
  const zip = new AdmZip();
  const fuentes = [];
  for (const entrevista of entrevistas) {
    const id = guid();
    const { texto, inicios } = textoPlano(entrevista.parrafos);
    zip.addFile(`sources/${id}.txt`, Buffer.from(texto, 'utf8'));

    const suyas = (codificacion?.citas ?? [])
      .filter((c) => c.entrevista === entrevista.id)
      .sort((a, b) => a.parrafo - b.parrafo || a.inicio - b.inicio);
    const selecciones = suyas.map((cita) => {
      const parrafo = entrevista.parrafos[cita.parrafo - 1] ?? '';
      const inicio = inicios[cita.parrafo - 1] + caracteres(parrafo.slice(0, cita.inicio));
      const fin = inicio + caracteres(parrafo.slice(cita.inicio, cita.fin));
      const nombre = cita.texto.length > 60 ? `${cita.texto.slice(0, 57)}…` : cita.texto;
      const codigos = cita.codigos
        .filter((c) => guidDe.has(c))
        .map((c) => `<Coding guid="${guid()}" ${quien}><CodeRef targetGUID="${guidDe.get(c)}"/></Coding>`)
        .join('');
      return (
        `      <PlainTextSelection guid="${guid()}" name="${escapar(nombre)}" startPosition="${inicio}" ` +
        `endPosition="${fin}" ${quien}>${codigos}</PlainTextSelection>`
      );
    });

    // El orden de los hijos lo fija el esquema: primero la descripción —donde
    // van los memos de la entrevista—, luego las citas y al final los atributos.
    const suyosMemos = memos
      .filter((m) => m.tipo === 'entrevista' && m.sobre === entrevista.id)
      .map((m) => `Memo: ${m.texto}`)
      .join('\n\n');
    const valores = Object.entries(entrevista.atributos ?? {}).map(
      ([nombre, valor]) =>
        `      <VariableValue><VariableRef targetGUID="${guidDeVariable.get(nombre)}"/>` +
        `<TextValue>${escapar(valor)}</TextValue></VariableValue>`,
    );

    fuentes.push(
      `    <TextSource guid="${id}" name="${escapar(nombreDeFuente(entrevista))}" ` +
        `plainTextPath="internal://${id}.txt" ${quien}>`,
      ...(suyosMemos ? [`      <Description>${escapar(suyosMemos)}</Description>`] : []),
      ...selecciones,
      ...valores,
      '    </TextSource>',
    );
  }

  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<Project xmlns="urn:QDA-XML:project:1.0" name="${escapar(titulo)}" origin="Acosta | IA &amp; Research" ` +
      `creatingUserGUID="${usuario}" creationDateTime="${fecha}">`,
    '  <Users>',
    `    <User guid="${usuario}" name="${escapar(autor)}"/>`,
    '  </Users>',
    '  <CodeBook>',
    '    <Codes>',
    ...libro,
    '    </Codes>',
    '  </CodeBook>',
    ...(variables.length > 0
      ? [
          '  <Variables>',
          ...variables.map(
            (v) =>
              `    <Variable guid="${guidDeVariable.get(v)}" name="${escapar(v)}" typeOfVariable="Text"/>`,
          ),
          '  </Variables>',
        ]
      : []),
    '  <Sources>',
    ...fuentes,
    '  </Sources>',
    // Los memos del análisis entero: en la descripción del proyecto, que es lo
    // único que abren igual todos los programas.
    ...(memos.some((m) => m.tipo === 'analisis')
      ? [
          `  <Description>${escapar(
            memos
              .filter((m) => m.tipo === 'analisis')
              .map((m) => `Memo (${m.escritoAt?.slice(0, 10) ?? ''}): ${m.texto}`)
              .join('\n\n'),
          )}</Description>`,
        ]
      : []),
    '</Project>',
    '',
  ].join('\n');

  zip.addFile('project.qde', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

module.exports = { armar, textoPlano, escapar, NOMBRE };
