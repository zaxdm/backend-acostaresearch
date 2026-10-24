'use strict';

/**
 * «Humanizar», el tercer servicio de «Edición y Traducción» (20-oct-2026).
 *
 * Lo que se fija: quién puede encargarlo mientras está en prueba (admin y
 * beta, sin cupo), qué rechaza el motor de lo que devuelve el modelo, y que
 * los tokens de cada llamada se suman, que es con lo que se mide el gasto.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

function falsificar(ruta, exports) {
  const resuelta = require.resolve(ruta);
  require.cache[resuelta] = { id: resuelta, filename: resuelta, loaded: true, exports };
}

let correo;
let rol;
let creadas;

falsificar('../src/modules/preparar/preparar.repository', {
  correoDe: async () => correo,
  rolDe: async () => rol,
  membresiaDe: async () => null,
  usadosEn: async () => 0,
  listarDe: async () => [],
  marcar: async () => null,
  crear: async (data) => {
    creadas.push(data);
    return { id: 'p1', ...data };
  },
});

falsificar('../src/modules/preparar/preparar.storage', {
  guardarEntrada: async () => {},
  leerEntrada: async () => {
    throw new Error('sin entrada en la prueba');
  },
});

const env = { ...require('../src/config/env') };
falsificar('../src/config/env', env);

const prepararService = require('../src/modules/preparar/preparar.service');
const motor = require('../src/modules/preparar/preparar.motor');
const prompt = require('../src/modules/preparar/preparar.prompt');
const { encargoSchema } = require('../src/modules/preparar/preparar.schema');

const AHORA = new Date('2026-10-20T12:00:00Z');

test.beforeEach(() => {
  env.PREPARAR_ILIMITADO_EMAILS = 'beta@ejemplo.pe';
  env.prepararEnabled = true;
  correo = 'cliente@ejemplo.pe';
  rol = 'USER';
  creadas = [];
});

function word(texto) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip();
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  zip.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types/>'));
  zip.addFile(
    'word/document.xml',
    Buffer.from(
      `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}"><w:body>` +
        `<w:p><w:r><w:t xml:space="preserve">${texto}</w:t></w:r></w:p>` +
        '</w:body></w:document>',
    ),
  );
  zip.addFile('word/styles.xml', Buffer.from(`<?xml version="1.0"?><w:styles xmlns:w="${W}"/>`));
  return zip.toBuffer();
}

const PARRAFO =
  'La estrategia didáctica mejoró el rendimiento de los estudiantes del grupo experimental. ' +
  'Los resultados mostraron diferencias entre el pretest y el postest en las tres dimensiones. ' +
  'Esto confirma lo que señalaron Pérez y Gómez (2020) sobre el aprendizaje activo en el aula.';

// ── Quién puede ────────────────────────────────────────────────────────────

test('el esquema admite HUMANIZAR', () => {
  assert.equal(encargoSchema.safeParse({ servicio: 'HUMANIZAR' }).success, true);
});

test('un cliente sin estar en la prueba no puede encargarlo', async () => {
  await assert.rejects(
    prepararService.encargar(
      { userId: 'u1', servicio: 'HUMANIZAR', buffer: word(PARRAFO), nombre: 'tesis.docx' },
      AHORA,
    ),
    (error) => error.statusCode === 403 && /en prueba/.test(error.message),
  );
  assert.equal(creadas.length, 0);
});

test('un administrador lo encarga sin membresía y sin gastar cupo', async () => {
  rol = 'ADMIN';

  const { preparacion, cupo } = await prepararService.encargar(
    { userId: 'u1', servicio: 'HUMANIZAR', buffer: word(PARRAFO), nombre: 'tesis.docx' },
    AHORA,
  );

  assert.equal(creadas.length, 1);
  assert.equal(creadas[0].docPackId, null);
  assert.equal(creadas[0].servicio, 'HUMANIZAR');
  assert.equal(cupo, null);
  assert.equal(preparacion.servicio, 'HUMANIZAR');
});

test('un usuario beta también puede', async () => {
  correo = 'beta@ejemplo.pe';
  assert.equal(await prepararService.puedeHumanizar('u1'), true);
});

test('el panel dice si se le enseña la pestaña', async () => {
  assert.equal((await prepararService.panel('u1', AHORA)).humanizar, false);
  rol = 'ADMIN';
  assert.equal((await prepararService.panel('u1', AHORA)).humanizar, true);
});

test('el archivo descargado dice que está humanizado', () => {
  assert.equal(
    prepararService.nombreDeDescarga({ nombre: 'Capítulo II.docx', servicio: 'HUMANIZAR' }),
    'Capítulo II (humanizado).docx',
  );
});

// ── Lo que pide y lo que rechaza ───────────────────────────────────────────

test('el prompt es el del humanizador y lleva el formato JSON común', () => {
  const sistema = prompt.sistemaDe({ servicio: 'HUMANIZAR' });
  assert.match(sistema, /Humanizar es RESTAR adorno/);
  assert.match(sistema, /EXACTAMENTE las mismas claves/);
});

test('un párrafo largo devuelto casi igual se rechaza', () => {
  const casiIgual = PARRAFO.replace('mejoró', 'elevó');
  assert.match(motor.comprobarHumanizado(PARRAFO, casiIgual), /casi igual/);
});

test('un párrafo con dos palabras cambiadas por oración se rechaza aunque ninguna oración sea idéntica', () => {
  const original =
    'La manipulación manual de cargas abarca las acciones realizadas mediante esfuerzo humano para elevar, descender, sostener y trasladar materiales, y su evaluación considerará la masa de los objetos, cuántas veces son movilizados y la distancia recorrida. ' +
    'El procedimiento de registro y los criterios de puntuación se concretarán según las actividades que se observen efectivamente en el lugar de trabajo.';
  const retocado = original
    .replace('abarca', 'comprende')
    .replace('realizadas', 'ejecutadas')
    .replace('considerará', 'tomará en cuenta')
    .replace('se concretarán', 'se precisarán');
  assert.match(motor.comprobarHumanizado(original, retocado), /conserva el \d+ % de las secuencias/);
});

test('una reescritura de verdad no se rechaza por copiar poco del original', () => {
  const original =
    'La manipulación manual de cargas abarca las acciones realizadas mediante esfuerzo humano para elevar, descender, sostener y trasladar materiales, y su evaluación considerará la masa de los objetos, cuántas veces son movilizados y la distancia recorrida.';
  const nuevo =
    'Para valorar cuánto pesa levantar y trasladar mercancía a mano, se anotarán el peso de cada objeto, las veces que se mueve y el trecho que se recorre con él, porque esas acciones dependen del esfuerzo de la persona.';
  assert.equal(motor.comprobarHumanizado(original, nuevo), null);
});

test('un verbo en primera persona del plural que el original no traía se rechaza', () => {
  const original =
    'A cada candidato se le explicará que la decisión es voluntaria y que puede retirarse sin que eso repercuta en su empleo, y se conservará el consentimiento de quienes lo firmen antes de observar sus tareas habituales en el almacén.';
  const nuevo =
    'Antes de observar sus tareas habituales en el almacén, cada candidato sabrá que su decisión es voluntaria y que retirarse no afectará su empleo, y volvemos a conservar a quienes firmen el consentimiento.';
  assert.match(motor.comprobarHumanizado(original, nuevo), /sujeto/);
  const limpio = nuevo.replace('y volvemos a conservar a quienes firmen el consentimiento', 'y se guardará el consentimiento de quienes lo firmen');
  assert.equal(motor.comprobarHumanizado(original, limpio), null);
});

test('un párrafo corto devuelto igual no se rechaza: puede ser un rótulo', () => {
  const corto = 'Población y muestra del estudio.';
  assert.equal(motor.comprobarHumanizado(corto, corto), null);
});

test('el vocabulario de modelo que el original no traía se rechaza', () => {
  const nuevo =
    'Con la estrategia didáctica, el grupo experimental rindió más, algo crucial para el curso. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones. ' +
    'Pérez y Gómez (2020) ya lo habían señalado al estudiar el aprendizaje activo en el aula.';
  assert.match(motor.comprobarHumanizado(PARRAFO, nuevo), /«crucial»/);
});

test('el que ya traía el original no cuenta como metido', () => {
  const original = `${PARRAFO} Es un hallazgo crucial.`;
  const nuevo =
    'Con la estrategia didáctica, el grupo experimental rindió más que antes. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones. ' +
    'Pérez y Gómez (2020) ya lo habían señalado al estudiar el aprendizaje activo; el hallazgo es crucial.';
  assert.equal(motor.comprobarHumanizado(original, nuevo), null);
});

test('las rayas nuevas se rechazan', () => {
  const nuevo =
    'Con la estrategia didáctica —aplicada al grupo experimental— el rendimiento subió. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones. ' +
    'Pérez y Gómez (2020) ya lo habían señalado al estudiar el aprendizaje activo en el aula.';
  assert.match(motor.comprobarHumanizado(PARRAFO, nuevo), /rayas/);
});

test('reescrito desde la idea pasa, aunque cambien casi todas las palabras', () => {
  const nuevo =
    'Con la estrategia didáctica, el grupo experimental rindió más que antes. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones, como ya habían ' +
    'anticipado Pérez y Gómez (2020) al estudiar el aprendizaje activo en el aula.';
  assert.equal(motor.comprobar(PARRAFO, nuevo, { servicio: 'HUMANIZAR' }), null);
});

test('un año de cita cambiado se rechaza igual que en los otros servicios', () => {
  const nuevo =
    'Con la estrategia didáctica, el grupo experimental rindió más que antes. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones, como ya habían ' +
    'anticipado Pérez y Gómez (2021) al estudiar el aprendizaje activo en el aula.';
  assert.match(motor.comprobar(PARRAFO, nuevo, { servicio: 'HUMANIZAR' }), /cifras/);
});

// ── Lo que salió en la primera prueba con Turnitin (20-oct-2026) ───────────

const CEPAL =
  'Según la Comisión Económica para América Latina y el Caribe (CEPAL, 2022), solo el 38 % de los ' +
  'estudiantes universitarios de la región cuenta con competencias digitales avanzadas. Esta brecha ' +
  'limita el acceso a oportunidades laborales y profundiza las desigualdades sociales de la región.';

test('una cita que pasa a prosa («la CEPAL indicó en 2022») se rechaza', () => {
  const nuevo =
    'En América Latina el escenario es diferente. La CEPAL indicó en 2022 que solo el 38 % de los ' +
    'universitarios posee competencias digitales avanzadas, y eso reduce sus posibilidades de empleo ' +
    'y aumenta las desigualdades sociales de la región.';
  assert.match(motor.comprobarHumanizado(CEPAL, nuevo), /«\(CEPAL, 2022\)» dejó de ser una cita/);
});

test('pasar la cita de parentética a narrativa APA sí vale', () => {
  const nuevo =
    'En América Latina el escenario es diferente. Para la CEPAL (2022), solo el 38 % de los ' +
    'universitarios posee competencias digitales avanzadas, y eso reduce sus posibilidades de empleo ' +
    'y aumenta las desigualdades sociales de la región.';
  assert.equal(motor.comprobarHumanizado(CEPAL, nuevo), null);
});

test('«no solo…, sino…» y los dos puntos como bisagra nuevos se rechazan', () => {
  const conNoSolo =
    'En América Latina el escenario es diferente (CEPAL, 2022). Solo el 38 % de los universitarios ' +
    'posee competencias digitales avanzadas. Esta diferencia no solo reduce sus posibilidades de ' +
    'empleo, sino que aumenta las desigualdades sociales de la región.';
  assert.match(motor.comprobarHumanizado(CEPAL, conNoSolo), /no solo/);

  const conBisagra =
    'En América Latina el escenario cambia: solo el 38 % de los universitarios posee competencias ' +
    'digitales avanzadas (CEPAL, 2022), lo que reduce sus posibilidades de empleo y aumenta las ' +
    'desigualdades sociales de toda la región.';
  assert.match(motor.comprobarHumanizado(CEPAL, conBisagra), /dos puntos/);
});

// ── Lo que salió el 22-oct-2026 con el Word de la revisión sistemática ─────

const OBJETIVOS =
  'Con relación directa al problema planteado, se propuso como objetivo general analizar la evidencia ' +
  'científica publicada entre los años 2022 y 2026 respecto a las estrategias de retroalimentación formativa. ' +
  'A fin de alcanzar este objetivo, se establecieron cuatro objetivos específicos: (a) identificar las ' +
  'características metodológicas de las publicaciones; (b) caracterizar las tipologías de retroalimentación; ' +
  '(c) determinar los efectos en las competencias escolares; y (d) identificar las barreras institucionales.';

test('una lista (a)… (d) fundida en una frase corrida se rechaza', () => {
  const nuevo =
    'El análisis de la evidencia científica publicada entre 2022 y 2026 sobre las estrategias de retroalimentación ' +
    'formativa fue el objetivo general. Cuatro objetivos específicos lo buscaron, como identificar las características ' +
    'metodológicas, caracterizar las tipologías, determinar los efectos en las competencias escolares e identificar ' +
    'las barreras institucionales.';
  assert.match(motor.comprobarHumanizado(OBJETIVOS, nuevo), /la lista del original perdió \(a\) \(b\) \(c\) \(d\)/);
});

test('la lista con sus marcadores y otra presentación sí pasa', () => {
  const nuevo =
    'El objetivo general fue analizar la evidencia científica de 2022 a 2026 sobre la retroalimentación formativa, y ' +
    'para lograrlo se fijaron cuatro específicos: (a) identificar las características metodológicas de las publicaciones; ' +
    '(b) caracterizar las tipologías de retroalimentación; (c) determinar los efectos en las competencias escolares; ' +
    'y (d) identificar las barreras institucionales.';
  assert.equal(motor.comprobarHumanizado(OBJETIVOS, nuevo), null);
});

test('una pregunta que pierde sus signos se rechaza', () => {
  const pregunta =
    'Con base en la problemática detectada, el estudio se estructuró en torno a la siguiente interrogante general: ' +
    '¿qué evidencia científica reportaron las publicaciones indexadas entre 2022 y 2026 sobre la retroalimentación formativa?';
  const nuevo =
    'La investigación quiso saber qué evidencia científica reportaron entre 2022 y 2026 las publicaciones indexadas ' +
    'sobre la retroalimentación formativa, a partir de la problemática detectada.';
  assert.match(motor.comprobarHumanizado(pregunta, nuevo), /pregunta/);
});

test('un sujeto que el original no traía («el equipo») se rechaza, y si lo traía no cuenta', () => {
  const original =
    'Las evidencias se codificaron en cuatro ejes: las características metodológicas, las modalidades de ' +
    'retroalimentación, los efectos en las competencias y las barreras institucionales de cada estudio.';
  const nuevo =
    'Luego el equipo codificó las evidencias según las características metodológicas, las modalidades de ' +
    'retroalimentación, los efectos en las competencias y las barreras institucionales de cada estudio.';
  assert.match(motor.comprobarHumanizado(original, nuevo), /sujeto/);
  assert.equal(motor.comprobarHumanizado(`${original} El equipo lo revisó.`, nuevo), null);
});

test('«70.8» escrito «70,8» y una tilde grave se rechazan, aunque las cifras cuadren por dígitos', () => {
  const original =
    'La retroalimentación anticipa hasta el 70.8 % del avance en competencias científicas y explica el 44.4 % de la ' +
    'comprensión lectora en estudiantes de primaria, según los estudios revisados en la región durante el periodo.';
  const coma = original.replace('70.8', '70,8');
  assert.match(motor.comprobarHumanizado(original, coma), /«70\.8» cambió de escritura/);
  const grave = original.replace('lectora', 'lectòra');
  assert.match(motor.comprobarHumanizado(original, grave), /tilde grave/);
});

test('HUMANIZAR_MODELO cambia el modelo solo de este servicio', () => {
  const antes = env.HUMANIZAR_MODELO;
  env.HUMANIZAR_MODELO = 'bedrock:otro-modelo';
  try {
    assert.equal(motor.modelos('HUMANIZAR')[0], 'bedrock:otro-modelo');
    assert.equal(motor.modelos('TRADUCCION')[0], env.PREPARAR_MODELO);
  } finally {
    env.HUMANIZAR_MODELO = antes;
  }
});

test('lo que falla dos veces solo por algo leve se entrega reescrito, no el original', async () => {
  const original = PARRAFO;
  const conBisagra =
    'El rendimiento cambió con la estrategia: el grupo experimental rindió más que antes. ' +
    'Entre el pretest y el postest hubo diferencias en las tres dimensiones, como ya habían ' +
    'anticipado Pérez y Gómez (2020) al estudiar el aprendizaje activo en el aula.';
  const sistemas = [];
  const generar = async ({ sistema, mensajes }) => {
    sistemas.push(sistema);
    const entrada = JSON.parse(mensajes[0].texto);
    return { texto: JSON.stringify(Object.fromEntries(Object.keys(entrada).map((k) => [k, conBisagra]))) };
  };

  const { cambios, malos } = await motor.prepararParrafos({
    parrafos: [{ clave: '1', id: 1, texto: original, palabras: 50 }],
    servicio: 'HUMANIZAR',
    generar,
    aLaVez: 1,
  });

  assert.equal(malos.length, 0);
  assert.equal(cambios['1'].texto, conBisagra);
  assert.match(sistemas[1], /ATENCIÓN: este párrafo ya se pidió/, 'el reintento avisa de qué quitar');
});

test('lo grave (una cifra cambiada) sigue dejando el original', async () => {
  const conOtroAno = PARRAFO.replace('2020', '2021').replace('mejoró', 'subió').replace('mostraron', 'dieron');
  // El segundo párrafo sale bien: con todos fallidos el trabajo entero se cae.
  const generar = async ({ mensajes }) => {
    const entrada = JSON.parse(mensajes[0].texto);
    const salida = Object.fromEntries(
      Object.keys(entrada).map((k) => [k, k === '1' ? conOtroAno : 'Las encuestas se aplicaron en mayo.']),
    );
    return { texto: JSON.stringify(salida) };
  };

  const { cambios, malos } = await motor.prepararParrafos({
    parrafos: [
      { clave: '1', id: 1, texto: PARRAFO, palabras: 50 },
      { clave: '2', id: 2, texto: 'En mayo se aplicaron las encuestas.', palabras: 6 },
    ],
    servicio: 'HUMANIZAR',
    generar,
    aLaVez: 1,
  });

  assert.equal(malos.length, 1);
  assert.equal(cambios['1'], undefined);
});

// ── Lo que cuesta ──────────────────────────────────────────────────────────

test('los tokens de todas las llamadas se suman para medir el gasto', async () => {
  const parrafos = [
    { clave: '1', id: 1, texto: 'Primer párrafo del texto.', palabras: 4 },
    { clave: '2', id: 2, texto: 'Segundo párrafo del texto.', palabras: 4 },
  ];
  const generar = async ({ mensajes }) => {
    const entrada = JSON.parse(mensajes[0].texto);
    const salida = Object.fromEntries(Object.entries(entrada).map(([k, v]) => [k, `${v} Otra.`]));
    return { texto: JSON.stringify(salida), uso: { promptTokenCount: 100, candidatesTokenCount: 30 } };
  };

  const { uso } = await motor.prepararParrafos({
    parrafos,
    servicio: 'HUMANIZAR',
    generar,
    porTanda: 4,
    aLaVez: 1,
  });

  assert.deepEqual(uso, { llamadas: 2, entrada: 200, salida: 60 });
});
