'use strict';

/**
 * El ámbito empresa de la ruta del informe.
 *
 * Desde el 16 de septiembre de 2026 la misma ruta sirve para un informe de curso
 * y para uno de empresa. Lo que tiene que ser cierto:
 *
 *   · una ficha sin ámbito sigue siendo de curso y se enseña igual que antes
 *     (lo vigilan además las instantáneas `proyecto.INFORME_ESTUDIANTIL` y
 *     `word.informe-curso`);
 *   · el conector acepta la ficha de empresa y sigue rechazando lo que no conoce;
 *   · el panorama de empresa empieza por «Ámbito: empresa», que es la línea con
 *     la que las skills deciden el ámbito, y no pide docente;
 *   · el Word de empresa lleva su portada y titula el resumen «Resumen ejecutivo».
 *
 * La base, el catálogo, el disco y el SDK del conector se sustituyen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const AdmZip = require('adm-zip');

const sustituir = (ruta, exports) => {
  const id = require.resolve(ruta);
  require.cache[id] = { id, filename: id, loaded: true, exports };
};

const INFORME = 'INFORME_ESTUDIANTIL';

const estado = { proyecto: null, asegurado: null, textos: {} };

sustituir('../src/modules/projects/project.repository', {
  buscar: async () => estado.proyecto,
  asegurar: async (userId, productCode, cambios) => {
    estado.asegurado = cambios;
    return estado.proyecto ?? { id: 'p1' };
  },
  nombreDe: async () => 'Cuenta De La Consultora',
  guardarEtapa: async () => ({}),
  listarDeUsuario: async () => [],
});
sustituir('../src/modules/projects/project.storage', {
  leer: async (projectId, clave) => estado.textos[clave] ?? null,
  palabrasDe: (texto) => String(texto).split(/\s+/).filter(Boolean).length,
  leerPlantilla: async () => null,
  leerFichaDeDocumento: async () => null,
  fechaDeAnalisis: async () => null,
  leerMaterial: async () => null,
});
sustituir('../src/modules/skills/skill.service', {
  listCatalog: async () => [
    { code: 'informe-fase0-encargo', displayName: 'Fase 0 — El encargo' },
    { code: 'informe-fase2-desarrollo', displayName: 'Fase 2 — Desarrollo' },
  ],
  findByCode: async () => null,
  perteneceAlGrupo: () => true,
});
sustituir('../src/modules/references/reference.service', { porClaves: async () => [] });
sustituir('../src/modules/zotero/biblioteca.repository', { deUsuario: async () => null });

const rutaMcp = require.resolve('@modelcontextprotocol/server');
const mcpReal = require('@modelcontextprotocol/server');
let registradas = null;
require.cache[rutaMcp] = {
  id: rutaMcp,
  filename: rutaMcp,
  loaded: true,
  exports: {
    fromJsonSchema: mcpReal.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const ficha = require('../src/modules/projects/project.ficha-informe');
const { guardarAvanceSchema } = require('../src/modules/projects/project.schema');
const projectService = require('../src/modules/projects/project.service');
const { construirServidor } = require('../src/modules/mcp/mcp.tools');

const AHORA = new Date('2026-09-16T17:00:00Z');

const FICHA_DE_EMPRESA = {
  ambito: 'empresa',
  tipo: 'diagnostico',
  empresa: 'Transportes del Norte SAC',
  sector: 'Transporte de carga, 45 trabajadores',
  destinatario: 'Gerencia General',
  preparadoPor: 'Ana Ruiz',
  cargo: 'Jefa de Operaciones',
  periodo: 'enero a marzo de 2026',
  ciudad: 'Trujillo',
  fechaEntrega: '2026-09-30',
  confidencial: true,
  decision: 'Decidir qué cambiar en el almacén antes de la temporada alta.',
  alcance: 'Entra el almacén de la sede principal; no entran compras ni transporte.',
  terminos: 'Diagnóstico del almacén con propuesta y costos, máximo 30 páginas.',
};

// ── Validar ────────────────────────────────────────────────────────────────

test('la ficha de empresa se admite entera y con sus tipos', () => {
  const r = guardarAvanceSchema.parse({ informe: FICHA_DE_EMPRESA });
  assert.deepEqual(r.informe, FICHA_DE_EMPRESA);
});

test('el ámbito y los tipos son de su lista', () => {
  assert.equal(guardarAvanceSchema.safeParse({ informe: { ambito: 'gobierno' } }).success, false);
  assert.equal(guardarAvanceSchema.safeParse({ informe: { tipo: 'monografia' } }).success, false);
  for (const tipo of ficha.TIPOS) {
    assert.equal(guardarAvanceSchema.safeParse({ informe: { tipo } }).success, true, tipo);
  }
});

test('«confidencial: false» se guarda: quiere decir que ya se preguntó', () => {
  assert.equal(ficha.fusionarFicha({ empresa: 'X', confidencial: true }, { confidencial: false }).confidencial, false);
});

test('una ficha sin ámbito es de curso, como todas las de antes', () => {
  assert.equal(ficha.esDeEmpresa({ curso: 'Economía' }), false);
  assert.equal(ficha.esDeEmpresa({}), false);
  assert.equal(ficha.esDeEmpresa(null), false);
  assert.equal(ficha.esDeEmpresa({ ambito: 'empresa' }), true);
});

// ── Lo que lee Claude ──────────────────────────────────────────────────────

test('la ficha de empresa empieza por «Ámbito: empresa» y no pide docente', () => {
  const lineas = ficha.lineasDeFicha(FICHA_DE_EMPRESA, { ahora: AHORA });
  assert.equal(lineas[0], 'Ámbito: empresa');
  const texto = lineas.join('\n');
  assert.match(texto, /Tipo: diagnóstico/);
  assert.match(texto, /Empresa: Transportes del Norte SAC · Sector: Transporte de carga/);
  assert.match(texto, /Para: Gerencia General/);
  assert.match(texto, /Lo firma: Ana Ruiz, Jefa de Operaciones/);
  assert.match(texto, /Periodo: enero a marzo de 2026/);
  assert.match(texto, /Confidencial/);
  assert.match(texto, /Entrega: 2026-09-30 \(faltan 14 días\)/);
  assert.doesNotMatch(texto, /Docente|Curso|Rúbrica/);
  // La decisión, el alcance y los términos solo viajan con el método.
  assert.doesNotMatch(texto, /Decisión|Alcance|Términos/);
});

test('con el método viajan también la decisión, el alcance y los términos', () => {
  const texto = ficha.lineasDeFicha(FICHA_DE_EMPRESA, { ahora: AHORA, conRubrica: true }).join('\n');
  assert.match(texto, /Decisión que apoya el informe: Decidir qué cambiar/);
  assert.match(texto, /Alcance: Entra el almacén/);
  assert.match(texto, /Términos de referencia: Diagnóstico del almacén/);
});

test('una ficha de empresa a medias no pide nada que no sea suyo', () => {
  const texto = ficha.lineasDeFicha({ ambito: 'empresa' }, { ahora: AHORA }).join('\n');
  assert.equal(texto, 'Ámbito: empresa');
});

test('una ficha de curso no dice ámbito', () => {
  const texto = ficha.lineasDeFicha({ tipo: 'curso', curso: 'Economía', docente: '' }, { ahora: AHORA }).join('\n');
  assert.doesNotMatch(texto, /Ámbito/);
});

// ── Guardar y el panorama ──────────────────────────────────────────────────

function proyectoDeEmpresa() {
  return {
    id: 'p1',
    productCode: INFORME,
    tema: 'Diagnóstico del almacén de la sede principal',
    carrera: null,
    universidad: null,
    asesor: null,
    estiloCitas: null,
    idiomaCitas: null,
    plantillaAt: null,
    fichaInforme: structuredClone(FICHA_DE_EMPRESA),
    stages: [
      { skillCode: 'informe-fase2-desarrollo', estado: 'EN_CURSO', palabras: 20 },
      { skillCode: 'informe-resumen', estado: 'EN_CURSO', palabras: 9 },
    ],
  };
}

test('la ficha de empresa se guarda fundida con la que había', async () => {
  estado.proyecto = { id: 'p1', productCode: INFORME, fichaInforme: { ambito: 'empresa', empresa: 'X SAC' }, stages: [] };
  await projectService.guardarAvance({ userId: 'u1', productCode: INFORME, informe: { destinatario: 'Directorio' } });
  assert.deepEqual(estado.asegurado.fichaInforme, { ambito: 'empresa', empresa: 'X SAC', destinatario: 'Directorio' });
});

test('el panorama de empresa dice el ámbito y llama «Resumen ejecutivo» al resumen', async () => {
  estado.proyecto = proyectoDeEmpresa();
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /^Diagnóstico del almacén/);
  assert.match(texto, /Ámbito: empresa/);
  assert.match(texto, /Resumen ejecutivo \(informe-resumen\)/);
  assert.doesNotMatch(texto, /Docente/);
});

test('el panorama de curso sigue llamando «Resumen» al resumen', async () => {
  estado.proyecto = { ...proyectoDeEmpresa(), fichaInforme: { tipo: 'curso', curso: 'Economía', docente: '' } };
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /: Resumen \(informe-resumen\)/);
  assert.doesNotMatch(texto, /Resumen ejecutivo|Ámbito/);
});

// ── El conector ────────────────────────────────────────────────────────────

function guardarAvanceDelInforme() {
  registradas = new Map();
  construirServidor({ productCode: INFORME });
  return registradas.get('guardar_avance').inputSchema['~standard'];
}

test('el conector acepta la ficha de empresa', async () => {
  const r = await guardarAvanceDelInforme().validate({ informe: FICHA_DE_EMPRESA });
  assert.equal(r.issues, undefined, JSON.stringify(r.issues));
});

test('el conector sigue rechazando un campo de la ficha que no conoce', async () => {
  const r = await guardarAvanceDelInforme().validate({ informe: { ambito: 'empresa', presupuesto: 'S/ 10 000' } });
  assert.ok(r.issues?.length > 0);
});

test('el conector sigue aceptando la ficha de curso de siempre', async () => {
  const r = await guardarAvanceDelInforme().validate({
    informe: { tipo: 'caso', curso: 'Economía', docente: '', integrantes: [{ nombre: 'Ana', codigo: 'U1' }] },
  });
  assert.equal(r.issues, undefined, JSON.stringify(r.issues));
});

// ── El Word ────────────────────────────────────────────────────────────────

const visible = (buffer) => new AdmZip(buffer).readAsText('word/document.xml').replace(/<[^>]+>/g, '');

test('la portada de empresa lleva a quién va, quién firma, el periodo y la marca de confidencial', async () => {
  estado.proyecto = proyectoDeEmpresa();
  estado.textos = {
    'informe-resumen': 'El almacén tiene un sobrecosto de S/ 39 600 al año.',
    'informe-fase2-desarrollo': '## Hallazgo 1\n\nEl almacén pierde seis horas semanales.',
  };
  const texto = visible((await projectService.armarWord('u1', INFORME)).buffer);

  for (const esperado of [
    'TRANSPORTES DEL NORTE SAC',
    'Diagnóstico del almacén de la sede principal',
    'Diagnóstico',
    'Periodo: enero a marzo de 2026',
    'Preparado para: Gerencia General',
    'Preparado por: Ana Ruiz, Jefa de Operaciones',
    'Trujillo, septiembre de 2026',
    'Documento confidencial — uso interno',
  ]) {
    assert.ok(texto.includes(esperado), `falta «${esperado}»`);
  }
  for (const ajeno of ['Curso:', 'Docente:', 'Integrantes', 'Asesor']) {
    assert.ok(!texto.includes(ajeno), `sobra «${ajeno}»`);
  }
});

test('en empresa el resumen se titula «Resumen ejecutivo» y va delante', async () => {
  estado.proyecto = proyectoDeEmpresa();
  estado.textos = {
    'informe-resumen': 'El almacén tiene un sobrecosto de S/ 39 600 al año.',
    'informe-fase2-desarrollo': '## Hallazgo 1\n\nEl almacén pierde seis horas semanales.',
  };
  const texto = visible((await projectService.armarWord('u1', INFORME)).buffer);
  assert.ok(texto.includes('Resumen ejecutivo'));
  assert.ok(texto.indexOf('sobrecosto de S/ 39 600') < texto.indexOf('pierde seis horas'));
});

test('sin marca de confidencial, la portada no la inventa', async () => {
  const proyecto = proyectoDeEmpresa();
  proyecto.fichaInforme.confidencial = false;
  estado.proyecto = proyecto;
  estado.textos = { 'informe-fase2-desarrollo': 'Texto.' };
  const texto = visible((await projectService.armarWord('u1', INFORME)).buffer);
  assert.ok(!texto.includes('confidencial'));
});

// ── Los textos para Claude: material, norma, formato y consejos ─────────────

test('el panorama de empresa habla del material del encargo, de la plantilla de la empresa y no pregunta la norma', async () => {
  estado.proyecto = proyectoDeEmpresa();
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /Material del encargo: nada subido\. Si tiene los términos de referencia/);
  assert.match(texto, /Formato de la empresa: sin subir/);
  assert.match(texto, /No la preguntes: cámbiala solo si la empresa pide otra/);
  assert.doesNotMatch(texto, /Material del curso|Formato de la universidad|exige su universidad|estudiante/);
});

test('el panorama de curso sigue hablando del material del curso y de la universidad', async () => {
  estado.proyecto = { ...proyectoDeEmpresa(), fichaInforme: { tipo: 'curso', curso: 'Economía', docente: '' } };
  const texto = await projectService.resumen('u1', INFORME);
  assert.match(texto, /Material del curso: nada subido\. Si el estudiante tiene la consigna/);
  assert.match(texto, /Formato de la universidad: sin subir/);
  assert.match(texto, /Pregúntale cuál exige su universidad/);
  assert.doesNotMatch(texto, /Material del encargo|Formato de la empresa/);
});

test('los consejos de norma y formato hablan de la empresa solo en empresa', () => {
  const { redactar } = require('../src/modules/projects/project.consejos');
  const deEmpresa = { obra: 'su informe', tipo: 'informe', empresa: true };
  const deCurso = { obra: 'su informe', tipo: 'informe' };
  assert.match(redactar('formato', deEmpresa), /plantilla de informes/);
  assert.doesNotMatch(redactar('formato', deEmpresa), /docente/);
  assert.doesNotMatch(redactar('norma', deEmpresa), /PREGÚNTALE|docente/);
  assert.match(redactar('formato', deCurso), /su docente o su instituto/);
  assert.match(redactar('norma', deCurso), /PREGÚNTALE qué norma le pide su docente/);
});

test('esInformeDeEmpresa solo es verdad con un informe de ámbito empresa', async () => {
  estado.proyecto = proyectoDeEmpresa();
  assert.equal(await projectService.esInformeDeEmpresa('u1', INFORME), true);
  assert.equal(await projectService.esInformeDeEmpresa('u1', 'METODO_9_SKILLS'), false);
  estado.proyecto = { ...proyectoDeEmpresa(), fichaInforme: { tipo: 'curso' } };
  assert.equal(await projectService.esInformeDeEmpresa('u1', INFORME), false);
});

// ── La plantilla con portada de empresa ────────────────────────────────────

const partesDePlantilla = require('../src/modules/projects/project.plantilla-partes');
const portadaAuto = require('../src/modules/projects/project.portada-auto');
const { armar } = require('../src/modules/projects/project.docx');

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const linea = (t) => `<w:p><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;

/** La carátula de informes de una consultora, con los datos de otro informe. */
const CARATULA_DE_EMPRESA = [
  linea('CONSULTORA ANDINA'),
  linea('ESTUDIO DE FACTIBILIDAD DE UNA PLANTA DE HIELO EN PAITA'),
  linea('Empresa: Pesquera Ejemplo SAC'),
  linea('Preparado para: Directorio'),
  linea('Preparado por: Luis Gómez'),
  linea('Cargo: Analista senior'),
  linea('Periodo: 2024'),
  linea('Lima – Perú'),
].join('');

function docxDe(cuerpo) {
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from('<Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<w:document xmlns:w="${W}"><w:body>${cuerpo}<w:sectPr><w:pgMar w:top="1417" w:right="1701" w:bottom="1417" w:left="1701"/></w:sectPr></w:body></w:document>`,
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<w:styles xmlns:w="${W}"></w:styles>`));
  return zip.toBuffer();
}

const prepararPortada = (cuerpo, opciones) =>
  portadaAuto.prepararPortada(partesDePlantilla.extraer(docxDe(cuerpo)), {
    clasificar: async () => {
      throw new Error('sin Gemini en la prueba');
    },
    ...opciones,
  });

test('en un informe de empresa se reconocen empresa, destinatario, quién lo prepara, cargo y periodo', async () => {
  const partes = await prepararPortada(CARATULA_DE_EMPRESA, { tipo: 'informe', ambito: 'empresa' });
  assert.ok(partes.portada, 'la portada se usa');
  assert.deepEqual(partes.camposDePortada, ['titulo', 'empresa', 'destinatario', 'preparadoPor', 'cargo', 'periodo']);
  for (const ajeno of ['Pesquera Ejemplo', 'Directorio', 'Luis Gómez', 'Analista senior']) {
    assert.ok(!partes.portada.xml.includes(ajeno), `el dato de ejemplo «${ajeno}» no se guarda`);
  }
});

test('en un informe de curso, las etiquetas de empresa no se buscan', async () => {
  const partes = await prepararPortada(CARATULA_DE_EMPRESA, { tipo: 'informe' });
  const suyos = partes.camposDePortada ?? [];
  for (const campo of ['empresa', 'destinatario', 'preparadoPor', 'cargo', 'periodo']) {
    assert.ok(!suyos.includes(campo), `no debería marcar ${campo} en un informe de curso`);
  }
});

test('«Preparado para» no se parte en dos ni se confunde con quién lo prepara', async () => {
  const partes = await prepararPortada(
    [linea('INFORME DE GESTIÓN DEL TERCER TRIMESTRE'), linea('Preparado para: Gerencia General'), linea('Preparado por: Ana Díaz')].join(''),
    { tipo: 'informe', ambito: 'empresa' },
  );
  assert.deepEqual(partes.camposDePortada, ['titulo', 'destinatario', 'preparadoPor']);
});

test('el Word de empresa rellena la plantilla con la ficha', async () => {
  const partes = await prepararPortada(CARATULA_DE_EMPRESA, { tipo: 'informe', ambito: 'empresa' });
  const buffer = await armar({
    tema: 'Diagnóstico del almacén de la sede principal',
    nombre: 'Cuenta De La Consultora',
    partes,
    portadaInforme: {
      ambito: 'empresa',
      empresa: 'Transportes del Norte SAC',
      destinatario: 'Gerencia General',
      preparadoPor: 'Ana Ruiz',
      cargo: 'Jefa de Operaciones',
      periodo: 'enero a marzo de 2026',
      nombre: 'Cuenta De La Consultora',
    },
    capitulos: [{ titulo: 'Fase 2 — Desarrollo', texto: 'El almacén pierde seis horas.' }],
  });
  const texto = visible(buffer);
  for (const esperado of [
    'Diagnóstico del almacén de la sede principal',
    'Empresa: Transportes del Norte SAC',
    'Preparado para: Gerencia General',
    'Preparado por: Ana Ruiz',
    'Cargo: Jefa de Operaciones',
    'Periodo: enero a marzo de 2026',
  ]) {
    assert.ok(texto.includes(esperado), `falta «${esperado}»`);
  }
  for (const ajeno of ['Pesquera Ejemplo', 'Luis Gómez', 'PLANTA DE HIELO', 'Cuenta De La Consultora']) {
    assert.ok(!texto.includes(ajeno), `sobra «${ajeno}»`);
  }
});

test('sin «Preparado por» en la ficha, la plantilla de empresa la firma quien tiene la cuenta', async () => {
  const partes = await prepararPortada(CARATULA_DE_EMPRESA, { tipo: 'informe', ambito: 'empresa' });
  const buffer = await armar({
    tema: 'Diagnóstico',
    nombre: 'Cuenta De La Consultora',
    partes,
    portadaInforme: { ambito: 'empresa', empresa: 'X SAC', nombre: 'Cuenta De La Consultora' },
    capitulos: [{ titulo: 'Fase 2 — Desarrollo', texto: 'Texto.' }],
  });
  assert.ok(visible(buffer).includes('Preparado por: Cuenta De La Consultora'));
});
