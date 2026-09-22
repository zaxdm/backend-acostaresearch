'use strict';

/**
 * De dónde saca el Word las figuras de R.
 *
 * EL FALLO QUE ARREGLA
 * --------------------
 * Los PNG vivían SOLO en la sesión de R, que es efímera. Mientras la sesión
 * existía, el Word salía con las imágenes dentro; en cuanto se limpiaba, la
 * misma tesis empezaba a descargarse con «[figura1_histogramas.png]» escrito en
 * medio del capítulo de Resultados. Se vio en una tesis de verdad con el
 * análisis de hacía ocho días: el índice de figuras montado, los rótulos
 * puestos y ninguna imagen, sin nada roto que mirar en el registro.
 *
 * Un documento no puede empeorar con el tiempo estando todo guardado. Ahora la
 * figura se archiva junto al script y la consola, y la sesión es solo el
 * respaldo de los análisis anteriores a que esto existiera.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const AdmZip = require('adm-zip');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

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
  ihdr[8] = 8;
  ihdr[9] = 2;
  const pixeles = Buffer.alloc(alto * (1 + ancho * 3));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    trozo('IHDR', ihdr),
    trozo('IDAT', zlib.deflateSync(pixeles)),
    trozo('IEND', Buffer.alloc(0)),
  ]);
}

const TESIS = 'METODO_9_SKILLS';
const FIGURA = 'figura1_histogramas.png';

const CAPITULO = [
  '## Resultados',
  '',
  '**Figura 1**',
  '',
  '*Distribución de los puntajes*',
  '',
  `[${FIGURA}]`,
  '',
  '*Nota.* Elaboración propia.',
].join('\n');

/** El disco y la sesión de R, los dos falsos, para poder vaciarlos por separado. */
const estado = { archivo: new Map(), sesion: new Map(), motorCaido: false };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => ({
    id: 'p1',
    productCode: TESIS,
    tema: 'Un tema',
    carrera: 'Educación',
    universidad: 'UPAO',
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    fichaInforme: null,
    stages: [{ skillCode: 'analisis-datos-rstudio', estado: 'EN_CURSO', palabras: 40 }],
  }),
  asegurar: async () => null,
  nombreDe: async () => 'La Tesista',
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});

sustituir('../src/modules/projects/project.storage', {
  leer: async (projectId, clave) => (clave === 'analisis-datos-rstudio' ? CAPITULO : null),
  palabrasDe: (texto) => String(texto).split(/\s+/).filter(Boolean).length,
  leerPlantilla: async () => null,
  leerPagina: async () => null,
  leerPartes: async () => null,
  leerFichaDeDocumento: async () => null,
  fechaDeAnalisis: async () => null,
  leerMaterial: async () => null,
  figuraValida: (nombre) => /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.png$/i.test(nombre),
  leerFigura: async (projectId, nombre) => estado.archivo.get(nombre) ?? null,
  guardarFigura: async (projectId, nombre, bytes) => {
    estado.archivo.set(nombre, bytes);
    return true;
  },
});

sustituir('../src/modules/r/r.service', {
  leerArchivoDeSesion: async (sesion, nombre) => {
    if (estado.motorCaido) throw new Error('el motor de R está apagado');
    return estado.sesion.get(nombre) ?? null;
  },
  figurasDeSesion: async () => new Map(estado.sesion),
});

sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'analisis-datos-rstudio', displayName: '7 · Capítulo IV · Resultados' },
  ],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const projectService = require('../src/modules/projects/project.service');

/** ¿Lleva el Word la imagen dentro, y no la marca en su lugar? */
async function wordConImagen() {
  const { buffer } = await projectService.armarWord('u1', TESIS);
  const zip = new AdmZip(buffer);
  // La propia carpeta cuenta como entrada del zip; las imágenes son las de dentro.
  const medios = zip
    .getEntries()
    .filter((e) => e.entryName.startsWith('word/media/') && e.entryName !== 'word/media/');
  const cuerpo = zip.getEntry('word/document.xml').getData().toString('utf8');
  return { imagenes: medios.length, marca: cuerpo.includes(FIGURA) };
}

test.beforeEach(() => {
  estado.archivo = new Map();
  estado.sesion = new Map();
  estado.motorCaido = false;
});

test('la figura archivada se incrusta aunque la sesión de R ya no exista', async () => {
  // Es el fallo: análisis de hace ocho días, sesión limpiada, y el Word salía
  // con «[figura1_histogramas.png]» escrito en medio del capítulo.
  estado.archivo.set(FIGURA, png(1600, 1100));

  const { imagenes, marca } = await wordConImagen();

  assert.equal(imagenes, 1);
  assert.equal(marca, false);
});

test('y se incrusta aunque el motor de R esté apagado del todo', async () => {
  estado.archivo.set(FIGURA, png(1600, 1100));
  estado.motorCaido = true;

  const { imagenes } = await wordConImagen();

  assert.equal(imagenes, 1);
});

test('si solo está en la sesión, se incrusta Y se archiva para la próxima vez', async () => {
  estado.sesion.set(FIGURA, png(900, 450));

  const primera = await wordConImagen();
  assert.equal(primera.imagenes, 1);
  assert.ok(estado.archivo.has(FIGURA), 'la figura tendría que haber quedado archivada');

  // Y ahora la sesión desaparece, como desaparece de verdad.
  estado.sesion = new Map();
  const segunda = await wordConImagen();
  assert.equal(segunda.imagenes, 1, 'la segunda descarga ya no depende de la sesión');
});

test('sin figura en ninguna parte queda la marca, como antes', async () => {
  // Quien analizó en SPSS o en Excel no tiene PNG en el servidor. Su Word sigue
  // saliendo con la marca para que pegue la suya: eso no ha cambiado.
  const { imagenes, marca } = await wordConImagen();

  assert.equal(imagenes, 0);
  assert.equal(marca, true);
});

test('un nombre que no es una figura válida no se lee del almacén', async () => {
  // El nombre sale del texto del capítulo, que lo escribe un modelo. Nada de
  // barras ni de «..»: se comprueba antes de tocar el disco.
  const nombres = [];
  const storage = require('../src/modules/projects/project.storage');
  const original = storage.leerFigura;
  storage.leerFigura = async (projectId, nombre) => {
    nombres.push(nombre);
    return original(projectId, nombre);
  };

  await wordConImagen();
  storage.leerFigura = original;

  assert.ok(nombres.every((n) => storage.figuraValida(n)));
});

test('también se encuentra si R la dejó en «graficos/»', async () => {
  // Un script escribe png("graficos/figura1.png"), que es lo natural. El texto
  // la cita por su nombre a secas, así que hay que buscarla en las dos partes.
  // Antes no: había que volver a dibujarla en la raíz, y el guion de una tesis
  // de verdad tenía cada figura duplicada exactamente por eso.
  estado.sesion.set(`graficos/${FIGURA}`, png(900, 450));

  const { imagenes, marca } = await wordConImagen();

  assert.equal(imagenes, 1);
  assert.equal(marca, false);
  assert.ok(estado.archivo.has(FIGURA), 'y queda archivada por su nombre, sin la carpeta');
});
