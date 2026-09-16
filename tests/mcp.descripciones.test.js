'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * Lo que Claude lee ANTES de decidir: las descripciones de `tools/list`.
 *
 * Una descripción no se ejecuta nunca, así que ninguna prueba de lógica la
 * cubre: se puede romper entera sin que falle un solo test. Y sin embargo es
 * lo único que decide si el tesista llega o no a las herramientas de apoyo.
 *
 * Aquí se monta el servidor con un `McpServer` de mentira que solo apunta lo
 * que se registra. No toca la base, no abre conexiones y no llama a ningún
 * servicio: `construirServidor` es síncrono y todo el trabajo real vive dentro
 * de los handlers, que estas pruebas no invocan.
 */

const ruta = require.resolve('@modelcontextprotocol/server');
const real = require('@modelcontextprotocol/server');

const registradas = new Map();

require.cache[ruta] = {
  id: ruta,
  filename: ruta,
  loaded: true,
  exports: {
    fromJsonSchema: real.fromJsonSchema,
    McpServer: class {
      registerTool(nombre, config) {
        registradas.set(nombre, config);
      }
    },
  },
};

const { construirServidor } = require('../src/modules/mcp/mcp.tools');

construirServidor({ productCode: 'METODO_DE_TESIS_HUMANIZADOR' });

/** La descripción tal y como sale en `tools/list`. */
const descripcion = (nombre) => registradas.get(nombre).description;

/** El JSON Schema de verdad: `fromJsonSchema` lo esconde tras un envoltorio. */
const esquema = (nombre) =>
  registradas.get(nombre).inputSchema['~standard'].jsonSchema.input();

// ── listar_capitulos ───────────────────────────────────────────────────────

test('listar_capitulos ya no se desaconseja a sí misma', () => {
  const d = descripcion('listar_capitulos');
  assert.ok(
    !/no hace falta/i.test(d),
    'la frase «si ya llamaste a mi_proyecto, no hace falta» la apagaba entera',
  );
});

test('listar_capitulos anuncia las herramientas de apoyo, no solo capítulos', () => {
  const d = descripcion('listar_capitulos');
  assert.match(d, /herramientas de apoyo/);
  assert.match(d, /capítulos/);
});

test('listar_capitulos dice que el catálogo es de esta licencia', () => {
  assert.match(descripcion('listar_capitulos'), /ESTA licencia/);
});

test('listar_capitulos reparte el papel con mi_proyecto', () => {
  const d = descripcion('listar_capitulos');
  assert.match(d, /mi_proyecto/, 'sin el reparto, se llama por costumbre');
  assert.match(d, /No en cada conversación/);
});

// ── redactar ───────────────────────────────────────────────────────────────

test('redactar conserva lo que ya decía del método', () => {
  const d = descripcion('redactar');
  assert.match(d, /método de Acosta \| IA & Research/);
  assert.match(d, /manda el mismo "sesion" en cada llamada del mismo hilo/);
});

test('redactar dice que también abre las herramientas de apoyo', () => {
  const d = descripcion('redactar');
  assert.match(d, /herramientas de apoyo/);
  assert.match(d, /mismo "capitulo"/, 'hay que decir POR DÓNDE se abren');
});

test('redactar desmiente que las herramientas esperen al final de la tesis', () => {
  assert.match(descripcion('redactar'), /NO esperan a que la tesis esté terminada/);
});

test('redactar nombra el insumo que dispara cada herramienta, no la frase', () => {
  const d = descripcion('redactar');
  assert.match(d, /informe de similitud/);
  assert.match(d, /suena a IA/);
});

test('redactar no hardcodea las claves de las herramientas', () => {
  const d = descripcion('redactar');
  for (const clave of ['bajar-similitud', 'humanizador-academico']) {
    assert.ok(!d.includes(clave), `${clave} debe venir del catálogo, no del texto`);
  }
});

test('redactar remite a listar_capitulos para el detalle', () => {
  assert.match(descripcion('redactar'), /listar_capitulos/);
});

// ── El parámetro que Claude rellena ────────────────────────────────────────

test('el parámetro capitulo de redactar admite herramientas de apoyo', () => {
  const d = esquema('redactar').properties.capitulo.description;
  assert.match(d, /herramienta de apoyo/);
  assert.match(d, /listar_capitulos/);
});

test('guardar_capitulo sigue hablando solo de capítulos', () => {
  const d = esquema('guardar_capitulo').properties.capitulo.description;
  assert.equal(d, 'Clave del capítulo, tal como aparece en listar_capitulos.');
});

// ── Que no se haya movido nada más ─────────────────────────────────────────

// ── Su Zotero ──────────────────────────────────────────────────────────────
//
// Con 580 fuentes traídas de su Zotero, el asistente le decía al tesista que
// no tenía acceso a Zotero: ninguna descripción lo nombraba, y la marca «de tu
// Zotero» solo aparecía DESPUÉS de buscar. Esto es lo que lo impide.

test('buscar_fuentes dice que busca también en el Zotero del tesista', () => {
  const d = descripcion('buscar_fuentes');
  assert.match(d, /SU ZOTERO/);
  assert.match(d, /no tienes acceso/, 'hay que desmentir el «no tengo acceso»');
  assert.match(d, /mis_fuentes/);
});

test('temaOriginal dice que sirve para buscar en su biblioteca, no solo fuera', () => {
  assert.match(esquema('buscar_fuentes').properties.temaOriginal.description, /SU biblioteca/);
});

test('mis_fuentes responde a quien pregunta por su Zotero', () => {
  const d = descripcion('mis_fuentes');
  assert.match(d, /SU ZOTERO/);
  assert.match(d, /SÍ TIENES ACCESO/);
  assert.match(d, /buscar_fuentes/, 'para un tema, que no pase páginas');
});

test('mis_fuentes no pide nada obligatorio: «entra a mi Zotero» no trae tema', () => {
  const e = esquema('mis_fuentes');
  assert.equal(e.required, undefined);
  assert.deepEqual(Object.keys(e.properties).sort(), ['origen', 'pagina']);
});

test('ampliar_desde_mis_fuentes cuenta su Zotero entre las semillas', () => {
  assert.match(descripcion('ampliar_desde_mis_fuentes'), /Zotero/);
});

// ── R en la conversación ───────────────────────────────────────────────────

test('trabajar_en_r: Claude corre R, pregunta antes y cuida los datos', () => {
  const d = descripcion('trabajar_en_r');
  assert.match(d, /manejas TÚ/);
  assert.match(d, /PREGÚNTALE/);
  assert.match(d, /SUS DATOS SON PERSONALES/);
  assert.match(d, /enlace para que los suba/);
  assert.match(d, /guardar_analisis/, 'las cifras se siguen guardando como siempre');
});

test('trabajar_en_r dice qué paquetes hay y cuáles no', () => {
  const d = descripcion('trabajar_en_r');
  for (const paquete of [
    'tidyverse',
    'psych',
    'lavaan',
    'car',
    'haven',
    'flextable',
    // Una por carrera: que Claude sepa que no es solo para psicología.
    'metafor',
    'survey',
    'plm',
    'vegan',
    'FactoMineR',
    'tidytext',
    'pwr',
  ]) {
    assert.match(d, new RegExp(paquete), paquete);
  }
  assert.match(d, /NO hay/, 'sin esto, Claude intenta library(DescTools) y falla');
  assert.match(d, /se recuerdan entre llamadas/);
});

test('trabajar_en_r arma el informe en Word con la estructura como ejemplo, no como molde', () => {
  const d = descripcion('trabajar_en_r');
  assert.match(d, /INFORME EN WORD/);
  assert.match(d, /es un ejemplo: adáptala a su diseño/);
  assert.match(d, /\*\*Tabla 1\*\*/);
  assert.match(d, /!\[\]\(figura1\.png\)/);
  assert.match(d, /CADA CIFRA SALE DE LA CONSOLA/);

  const informe = esquema('trabajar_en_r').properties.informe;
  assert.deepEqual(informe.required, ['texto']);
  assert.ok(informe.properties.norma.enum.includes('apa'));
  assert.ok(informe.properties.norma.enum.includes('ieee'));
  assert.match(informe.properties.norma.description, /PREGÚNTASELA/);
});

test('trabajar_en_r no obliga a mandar nada: sin argumentos da el estado', () => {
  const e = esquema('trabajar_en_r');
  assert.equal(e.required, undefined);
  assert.deepEqual(Object.keys(e.properties).sort(), ['codigo', 'descargar', 'informe', 'reiniciar']);
  assert.equal(e.additionalProperties, false);
});

test('ya no se manda al tesista a la página de análisis', () => {
  for (const nombre of ['ver_analisis', 'guardar_analisis']) {
    const d = descripcion(nombre);
    assert.doesNotMatch(d, /acostaresearch\.com\/analisis|Enviar a mi conector|página de análisis/);
    assert.match(d, /trabajar_en_r/);
  }
  assert.doesNotMatch(descripcion('guardar_analisis'), /NO EJECUTA R/);
});

// ── Citar el documento que subió ────────────────────────────────────────────

test('ver_mi_documento marca el orden: norma, leer, buscar, resumen, guardar, enlace', () => {
  const d = descripcion('ver_mi_documento');
  assert.match(d, /cita mi documento/);
  assert.match(d, /guardar_avance/);
  for (const herramienta of ['mis_fuentes', 'buscar_fuentes', 'buscar_en_la_literatura', 'anadir_a_mis_fuentes', 'citar_mi_documento', 'enlace_del_word']) {
    assert.match(d, new RegExp(herramienta), herramienta);
  }
  assert.match(d, /ANTES DE GUARDAR NADA/);
  assert.match(d, /NUNCA inventes/);
});

test('citar_mi_documento exige copiar el texto tal cual y el visto bueno', () => {
  const d = descripcion('citar_mi_documento');
  assert.match(d, /NO CAMBIES NI UNA PALABRA/);
  assert.match(d, /[FALTA FUENTE]/);
  assert.match(d, /visto bueno/);
  assert.deepEqual(Object.keys(esquema('citar_mi_documento').properties), ['parrafos']);
});

test('humanizar_mi_documento exige el visto bueno y dice lo que se rechaza', () => {
  const d = descripcion('humanizar_mi_documento');
  assert.match(d, /visto bueno/);
  assert.match(d, /\[APARTE\]/);
  assert.match(d, /cifras/);
  assert.match(d, /enlace_del_word/);
  assert.deepEqual(Object.keys(esquema('humanizar_mi_documento').properties), ['parrafos', 'deshacer']);
  // Quien llega a humanizar no debe acabar editando una copia en el chat.
  assert.match(descripcion('ver_mi_documento'), /humanizar_mi_documento/);
  assert.match(descripcion('ver_mi_documento'), /python-docx/);
});

test('antes de citar o humanizar se pregunta si es el documento del servidor o uno nuevo', () => {
  assert.match(descripcion('ver_mi_documento'), /servidor[\s\S]*uno nuevo[\s\S]*subir_mi_documento/);
  assert.match(descripcion('humanizar_mi_documento'), /subir_mi_documento/);
  assert.match(descripcion('subir_mi_documento'), /sin escribir la dirección/);
  assert.deepEqual(Object.keys(esquema('subir_mi_documento').properties), []);
});

test('siguen registradas las mismas 24 herramientas', () => {
  // 17 desde que existe «enlace_del_word»: el Word lo arma el servidor, en la
  // norma del proyecto, y Claude da el enlace en vez de fabricarlo él.
  // 18 desde «mis_fuentes»: ver su biblioteca y su Zotero sin tener un tema.
  // 19 desde «trabajar_en_r»: Claude corre el análisis en R en la conversación.
  // 21 desde «ver_mi_documento» y «citar_mi_documento»: citar el Word que subió.
  // 22 desde «formato_de_la_universidad»: el formato se sube desde un enlace de Claude.
  // 23 desde «humanizar_mi_documento»: el humanizador escribe en el Word que subió.
  // 24 desde «subir_mi_documento»: el Word se sube desde un enlace de Claude.
  assert.equal(registradas.size, 24);
  for (const nombre of [
    'listar_capitulos',
    'mi_proyecto',
    'continuar',
    'ver_capitulo',
    'ver_analisis',
    'redactar',
    'enlace_del_word',
    'mis_fuentes',
    'trabajar_en_r',
    'ver_mi_documento',
    'citar_mi_documento',
    'humanizar_mi_documento',
    'subir_mi_documento',
  ]) {
    assert.ok(registradas.has(nombre), `falta ${nombre}`);
  }
});

test('redactar mantiene sus parámetros y su obligatorio', () => {
  const e = esquema('redactar');
  assert.deepEqual(Object.keys(e.properties).sort(), [
    'capitulo',
    'mensaje',
    'paso',
    'referencia',
    'sesion',
  ]);
});

test('listar_capitulos sigue sin admitir argumentos', () => {
  const e = esquema('listar_capitulos');
  assert.deepEqual(e.properties, {});
  assert.equal(e.additionalProperties, false);
});

// ── Leer lo ya escrito y escribir figuras ──────────────────────────────────
//
// Sin «texto», la Discusión y las Conclusiones le pedían al tesista que pegara
// capítulos que ya estaban guardados. Y la marca de una figura va entre
// corchetes, que era justo lo que la descripción de guardar_capitulo prohibía.

test('ver_capitulo ofrece leer el texto guardado, por partes, y dice para qué', () => {
  const e = esquema('ver_capitulo');
  assert.deepEqual(Object.keys(e.properties).sort(), ['capitulo', 'parte', 'texto']);
  assert.deepEqual(e.required, ['capitulo']);
  const d = descripcion('ver_capitulo');
  assert.match(d, /TEXTO GUARDADO/);
  assert.match(d, /Discusión/);
  assert.doesNotMatch(d, /No devuelve el texto/);
});

test('formato_de_la_universidad: Claude lo pregunta una vez y da el enlace, no lo copia a mano', () => {
  const d = descripcion('formato_de_la_universidad');
  assert.match(d, /PREGÚNTALE UNA VEZ/);
  assert.match(d, /tengo mi formato/);
  assert.match(d, /ENLACE/);
  assert.match(d, /no le armes un Word/);
  const e = esquema('formato_de_la_universidad');
  assert.equal(e.required, undefined, 'sin argumentos da el estado y el enlace');
  assert.deepEqual(Object.keys(e.properties).sort(), ['quitar', 'usarNuestraPortada']);
});

test('guardar_capitulo explica las figuras y ya no prohíbe su marca entre corchetes', () => {
  const d = esquema('guardar_capitulo').properties.texto.description;
  assert.match(d, /LAS FIGURAS/);
  assert.match(d, /\[Insertar aquí la Figura 1: nombre-del-archivo\.png\]/);
  assert.match(d, /solo valen las claves de cita, \[FALTA FUENTE\] y la marca de una figura/);
  assert.match(d, /LAS TABLAS/, 'lo de las tablas se queda');
});
