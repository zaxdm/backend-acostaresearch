'use strict';

/**
 * «Humanizar» con la skill del servidor (`skills/humanizador-servidor`), para
 * pasar el Word por Turnitin antes de tocar el servicio.
 *
 * PARA QUÉ
 * --------
 * El servicio de hoy (`preparar.prompt.HUMANIZAR`) dio 84 % de IA con Nemotron
 * el 20-oct-2026. Su prompt pedía oraciones cortas y ritmo desigual, y los
 * trabajos que dieron 0 % con /turnitin hicieron lo contrario: reescribir
 * desde la idea, fundir oraciones con enlaces reales (medias de 30 a 40
 * palabras) y, sobre todo, dos pasadas sobre el documento entero para quitar
 * los moldes que se repiten entre párrafos. Esto prueba esa receta:
 *
 *   1. Cada párrafo con el núcleo de la skill + la ruta de su capítulo + los
 *      ejemplos reales de ese capítulo. Las mismas comprobaciones del servicio
 *      (`motor.prepararParrafos`): cifras, citas, largo, vocabulario, rayas.
 *   2. Dos pasadas sobre el documento entero: el código busca aperturas,
 *      arranques y moldes repetidos (lo de `repeticiones.py` de /turnitin) y
 *      el modelo cambia solo eso en los párrafos que sobran.
 *
 * No toca la base, ni el servicio, ni manda correos: lee el Word, llama al
 * modelo y deja otro Word al lado. El porcentaje lo dice Turnitin.
 *
 * CÓMO SE USA
 * -----------
 *   node scripts/humanizar-con-skill.js --doc prueba.docx --modelos nvidia:z-ai/glm-5.3
 *   node scripts/humanizar-con-skill.js --doc prueba.docx --modelos bedrock:deepseek.v3.2,bedrock:zai.glm-5
 *
 *   --skill <carpeta>   otra copia de la skill (por defecto ../skills/humanizador-servidor)
 *   --sin-pasada        solo el paso 1, para comparar
 *   --salida <carpeta>  dónde dejar los Word (por defecto, junto al original)
 *   --por-tanda <n>     palabras por llamada (por defecto 900, la del servicio).
 *                       Los modelos que razonan (GLM de NVIDIA) necesitan 300:
 *                       con 900 se cortaban por tiempo o sin tokens de salida.
 */

const fs = require('fs');
const path = require('path');

const gemini = require('../src/lib/gemini');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const prompt = require('../src/modules/preparar/preparar.prompt');
const traduccion = require('../src/modules/preparar/preparar.traduccion');
const controles = require('../src/modules/projects/project.humanizado-controles');

const SKILL_POR_DEFECTO = path.resolve(__dirname, '../../skills/humanizador-servidor');

/** USD por millón de tokens (entrada, salida). Orientativo. */
const TARIFAS = [
  ['nemotron-super', 0.15, 0.65],
  ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
];

// ── La skill ───────────────────────────────────────────────────────────────

/**
 * Qué ruta toca según el título. El orden importa: «Discusión de resultados»
 * es discusión, y «Marco metodológico» es metodología.
 */
const RUTAS = [
  ['conclusiones', /conclusi[oó]n|recomendaci[oó]n/i],
  ['discusion', /discusi[oó]n|limitaciones/i],
  ['resultados', /resultado|prueba de hip[oó]tesis|contrastaci[oó]n|an[aá]lisis (descriptivo|inferencial)|confiabilidad de los/i],
  ['metodologia', /metodolog|m[eé]todo|materiales|dise[nñ]o de (la )?investigaci|tipo (y|de) |poblaci[oó]n|t[eé]cnicas|instrumento|procedimiento|aspectos [eé]ticos|variables/i],
  ['introduccion-marco', /introducci|problema|justificaci|antecedente|marco|bases te[oó]ricas|realidad|resumen|abstract/i],
];

const NOMBRES = {
  'introduccion-marco': 'introducción y marco teórico',
  metodologia: 'metodología',
  resultados: 'resultados',
  discusion: 'discusión',
  conclusiones: 'conclusiones y recomendaciones',
};

const FORMATO = `
ENTRADA: un objeto JSON con
- "seccion": el capítulo al que pertenecen los párrafos;
- "ya_usadas": cómo abren otros párrafos del documento, ya humanizados. No abras ninguno igual;
- "parrafos": cada clave es el número de un párrafo y cada valor su texto.

SALIDA: solo un objeto JSON con EXACTAMENTE las claves de "parrafos" y, como valor, el texto
nuevo de ese párrafo. Nada fuera del JSON. Un párrafo por clave: no juntes dos párrafos en uno
ni partas uno en dos, porque el texto vuelve al Word por su número.
`.trim();

const FORMATO_PASADA = `
ENTRADA: un objeto JSON con "ya_usadas" (las aperturas de párrafo que ya hay en el documento) y
"parrafos": cada clave es el número de un párrafo y cada valor, {"texto", "nota"}.

SALIDA: solo un objeto JSON con EXACTAMENTE las claves de "parrafos" y, como valor, el texto
corregido (una cadena). Nada fuera del JSON.
`.trim();

const INSISTIR = `
ATENCIÓN: este párrafo ya se pidió y volvió con algo que delata a una IA, con una cifra o una
cita cambiada, o casi igual al original. Reescríbelo otra vez desde la idea, con otra entrada, y
revisa antes de devolverlo cada cifra y cada cita, y que no lleve dos puntos en medio, «no
solo… sino», «más allá de», rayas (—) ni palabras de la lista QUITA.
`.trim();

function leerSkill(carpeta) {
  const leer = (archivo) => fs.readFileSync(path.join(carpeta, archivo), 'utf8').trim();
  const skill = { nucleo: leer('nucleo.md'), pasada: leer('pasada-documento.md'), rutas: {} };
  for (const ruta of Object.keys(NOMBRES)) {
    skill.rutas[ruta] = `${leer(`rutas/${ruta}.md`)}\n\n${leer(`ejemplos/${ruta}.md`)}`;
  }
  return skill;
}

const sistemaDe = (skill, ruta, insistir) =>
  [skill.nucleo, skill.rutas[ruta], FORMATO, insistir ? INSISTIR : null].filter(Boolean).join('\n\n');

// ── El documento por capítulos ─────────────────────────────────────────────

/** Un título: con nivel de Word, o una línea corta sin punto final que nombra un capítulo. */
function rutaDelTitulo(parrafo) {
  const texto = parrafo.texto.trim();
  const pareceTitulo = parrafo.nivel || (parrafo.palabras <= 12 && !/[.:;]$/.test(texto));
  if (!pareceTitulo) return null;
  const encontrada = RUTAS.find(([, patron]) => patron.test(texto));
  return encontrada ? encontrada[0] : null;
}

/** Los párrafos de prosa, cada uno con su ruta, en el orden del documento. */
function porCapitulos(parrafos) {
  let ruta = 'introduccion-marco';
  const prosa = [];
  for (const parrafo of parrafos) {
    const nueva = rutaDelTitulo(parrafo);
    if (nueva) ruta = nueva;
    if (parrafo.nivel || parrafo.palabras < 15 || cuerpo.ROTULO.test(parrafo.texto.trim())) continue;
    prosa.push({ ...parrafo, ruta });
  }
  return prosa;
}

// ── Los moldes entre párrafos (lo de repeticiones.py) ──────────────────────

const ART = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'en', 'con', 'por', 'para', 'de', 'del', 'al', 'a', 'se', 'lo']);
const ARRANQUES = new Set(['también', 'además', 'así', 'esto', 'eso', 'ello', 'pero', 'sin', 'asimismo']);

const MOLDES = [
  ['«Lo que … es/será»', /\blo que [^.]{0,60}?\b(es|será|son|fue|hará|pide|interesa)\b/gi],
  ['«Se trata de»', /\bse trata de\b/gi],
  ['«De ahí»', /\bde ahí\b/gi],
  ['«Ahora bien»', /\bahora bien\b/gi],
  ['«Por ese motivo / esa razón»', /\bpor (ese|esa|este|esta) (motivo|razón|diferencia|causa)\b/gi],
  ['«de modo que / de manera que»', /\bde (modo|manera) que\b/gi],
  ['«entonces»', /\bentonces\b/gi],
  ['«ayuda a / sirve para / permite»', /\b(ayuda a|ayudará a|servirá para|sirve para|permite|permitirá|permitió)\b/gi],
  ['«No es X, sino Y»', /\bno (es|son|se trata de) [^.]{0,60}?, sino\b/gi],
  ['una lista anunciada con número y dos puntos', /\b(dos|tres|cuatro|cinco|seis) [a-záéíóúñ]+( [a-záéíóúñ]+)?:\s/gi],
  ['«En este/esta + eje, dimensión…»', /(^|\. )(en )?(este|esta|ese|esa) (eje|criterio|pauta|subcategoría|categoría|dimensión|enfoque)\b/gi],
  ['«Con este/esa…» al arrancar', /(^|\. )con (este|esta|ese|esa|estos|esas|ellas|ellos) \w+/gi],
];

const palabras = (texto) => String(texto).toLowerCase().match(/[\wáéíóúñü]+/g) ?? [];

function arranque(texto, n = 2) {
  const p = palabras(texto);
  if (p.length === 0) return '';
  return ART.has(p[0]) ? p.slice(0, n).join(' ') : p[0];
}

function oraciones(texto) {
  return String(texto)
    .replace(/et al\./g, 'et al\u0000')
    .split(/(?<=[.?!])\s+/)
    .map((o) => o.replace(/\u0000/g, '.'))
    .filter((o) => o.trim());
}

/**
 * Qué párrafo repite qué. De cada molde se dejan las dos primeras apariciones
 * (el Word que dio 0 % todavía tenía tres «La investigación…»); lo que no
 * puede quedar es el mismo arranque en cinco párrafos.
 */
function moldesDe(textos, minimo = 3) {
  const notas = new Map();
  const anotar = (clave, nota) => notas.set(clave, [...(notas.get(clave) ?? []), nota]);
  const largos = textos.filter(({ texto }) => cuerpo.palabrasDe(texto) >= 25);

  const aperturas = new Map();
  for (const { clave, texto } of largos) {
    const k = arranque(texto);
    if (k) aperturas.set(k, [...(aperturas.get(k) ?? []), clave]);
  }
  for (const [k, claves] of aperturas) {
    if (claves.length < minimo) continue;
    for (const clave of claves.slice(2)) {
      anotar(clave, `abre con «${k}…», igual que otros ${claves.length - 1} párrafos del documento`);
    }
  }

  const arranques = new Map();
  for (const { clave, texto } of largos) {
    for (const oracion of oraciones(texto).slice(1)) {
      const k = arranque(oracion, 1);
      if (ARRANQUES.has(k)) arranques.set(k, [...(arranques.get(k) ?? []), clave]);
    }
  }
  for (const [k, claves] of arranques) {
    if (claves.length < minimo + 1) continue;
    for (const clave of [...new Set(claves)].slice(2)) {
      anotar(clave, `tiene oraciones que arrancan con «${k}…», como otras ${claves.length - 1} del documento`);
    }
  }

  for (const [nombre, patron] of MOLDES) {
    const donde = largos.flatMap(({ clave, texto }) => (texto.match(patron) ?? []).map(() => clave));
    if (donde.length < minimo) continue;
    for (const clave of [...new Set(donde)].slice(2)) {
      anotar(clave, `usa ${nombre}, que aparece ${donde.length} veces en el documento`);
    }
  }

  return notas;
}

// ── Pasos ──────────────────────────────────────────────────────────────────

const sumar = (uso, respuesta) => {
  uso.llamadas += 1;
  uso.entrada += Number(respuesta?.uso?.promptTokenCount ?? 0);
  uso.salida += Number(respuesta?.uso?.candidatesTokenCount ?? 0);
};

/** Paso 1: capítulo por capítulo, con las comprobaciones del servicio. */
/**
 * Los modelos que razonan gastan tokens antes de contestar y tardan: con el
 * tope y el tiempo del servicio, GLM en NVIDIA devolvía MAX_TOKENS o se cortaba
 * (21-oct-2026). Aquí se les da el triple de tokens y diez minutos.
 */
const holgura = (peticion) => ({
  maxTokens: Math.max(Number(peticion.maxTokens ?? 0) * 3, 8000),
  timeoutMs: 600_000,
});

async function porRutas({ prosa, skill, modelo, actual, malos, uso, porTanda }) {
  const usadas = [];
  for (const ruta of Object.keys(NOMBRES)) {
    const suyos = prosa.filter((parrafo) => parrafo.ruta === ruta);
    if (suyos.length === 0) continue;

    const generar = (peticion) => {
      // `motor` manda su prompt; se cambia por la skill. Si no es el de
      // siempre, es el reintento con insistencia.
      const insistir = peticion.sistema !== prompt.HUMANIZAR;
      const entrada = JSON.parse(peticion.mensajes[0].texto);
      const texto = JSON.stringify({ seccion: NOMBRES[ruta], ya_usadas: usadas.slice(-30), parrafos: entrada });
      return gemini.generarConRespaldo({
        ...peticion,
        sistema: sistemaDe(skill, ruta, insistir),
        mensajes: [{ rol: 'usuario', texto }],
        modelos: [modelo],
        ...holgura(peticion),
      });
    };

    const hecho = await motor.prepararParrafos({ parrafos: suyos, servicio: 'HUMANIZAR', generar, porTanda });
    for (const [clave, cambio] of Object.entries(hecho.cambios)) actual.set(clave, cambio.texto);
    malos.push(...hecho.malos.map((malo) => ({ ...malo, ruta })));
    uso.llamadas += hecho.uso.llamadas;
    uso.entrada += hecho.uso.entrada;
    uso.salida += hecho.uso.salida;

    for (const parrafo of suyos) {
      const k = palabras(actual.get(parrafo.clave) ?? parrafo.texto).slice(0, 3).join(' ');
      if (k) usadas.push(k);
    }
    console.log(`  ${NOMBRES[ruta]}: ${suyos.length} párrafos, ${hecho.malos.length} sin humanizar`);
  }
}

/** Paso 2: una pasada sobre el documento entero. Devuelve cuántos se tocaron. */
async function pasada({ prosa, skill, modelo, actual, uso, vuelta, porTanda }) {
  const textos = prosa.map((parrafo) => ({ clave: parrafo.clave, texto: actual.get(parrafo.clave) ?? parrafo.texto }));
  const notas = moldesDe(textos);
  if (notas.size === 0) {
    console.log(`  pasada ${vuelta}: nada se repite`);
    return 0;
  }

  const porClave = new Map(prosa.map((parrafo) => [parrafo.clave, parrafo]));
  const usadas = [...new Set(textos.map(({ texto }) => palabras(texto).slice(0, 3).join(' ')))];
  const pedidos = [...notas.keys()].map((clave) => ({
    ...porClave.get(clave),
    texto: actual.get(clave) ?? porClave.get(clave).texto,
  }));

  let tocados = 0;
  let rechazados = 0;
  await motor.enParalelo(
    motor.tandasDe(pedidos, porTanda).map((tanda) => async () => {
      const entrada = Object.fromEntries(tanda.map((p) => [p.clave, { texto: p.texto, nota: notas.get(p.clave).join('; ') }]));
      let respuesta;
      try {
        respuesta = await gemini.generarConRespaldo({
          sistema: `${skill.pasada}\n\n${FORMATO_PASADA}`,
          mensajes: [{ rol: 'usuario', texto: JSON.stringify({ ya_usadas: usadas, parrafos: entrada }) }],
          modelos: [modelo],
          ...holgura({ maxTokens: 6000 }),
          json: true,
        });
      } catch (error) {
        console.log(`    una tanda de la pasada falló: ${error.message}`);
        return;
      }
      sumar(uso, respuesta);
      let devuelto;
      try {
        devuelto = JSON.parse(respuesta.texto);
      } catch {
        console.log('    una tanda de la pasada no devolvió JSON');
        return;
      }
      for (const p of tanda) {
        const nuevo = devuelto?.[p.clave];
        // Se compara con el ORIGINAL del autor: así valen todas las
        // comprobaciones (cifras, citas, vocabulario) y no la de «casi igual».
        const original = porClave.get(p.clave).texto;
        const motivo = motor.comprobar(original, nuevo, { servicio: 'HUMANIZAR' }, porClave.get(p.clave).citas);
        if (motivo) {
          rechazados += 1;
          continue;
        }
        actual.set(p.clave, String(nuevo).trim());
        tocados += 1;
      }
    }),
    3,
  );
  console.log(`  pasada ${vuelta}: ${notas.size} párrafos con moldes repetidos, ${tocados} corregidos, ${rechazados} rechazados`);
  return tocados;
}

// ── Medir ──────────────────────────────────────────────────────────────────

function medir(textos) {
  const todas = textos.flatMap(oraciones);
  const largos = todas.map((o) => cuerpo.palabrasDe(o));
  const media = largos.reduce((a, b) => a + b, 0) / Math.max(largos.length, 1);
  const unido = textos.join('\n');
  const vocabulario = controles.VOCABULARIO.reduce((total, palabra) => total + controles.cuantas(unido, palabra), 0);
  const manual = (unido.match(/(^|[.!?]\s+)(Asimismo|Además|Por otro lado|Por su parte|De igual (forma|manera)|En este sentido|No obstante|Sin embargo|Finalmente|En consecuencia)\b/gm) ?? []).length;
  const moldes = moldesDe(textos.map((texto, i) => ({ clave: String(i), texto }))).size;
  return { oraciones: todas.length, media: media.toFixed(1), vocabulario, manual, moldes };
}

// ── Principal ──────────────────────────────────────────────────────────────

function argumentos(lista) {
  const args = {};
  for (let i = 0; i < lista.length; i += 1) {
    if (!lista[i].startsWith('--')) continue;
    const siguiente = lista[i + 1];
    args[lista[i].slice(2)] = siguiente && !siguiente.startsWith('--') ? siguiente : true;
  }
  return args;
}

function costeDe(modelo, uso) {
  const tarifa = TARIFAS.find(([parte]) => modelo.includes(parte));
  return tarifa ? (uso.entrada * tarifa[1] + uso.salida * tarifa[2]) / 1_000_000 : null;
}

async function probar({ ruta, modelo, skill, conPasada, salida, porTanda }) {
  const buffer = fs.readFileSync(ruta);
  const prosa = porCapitulos(cuerpo.cuerpoDe(buffer).parrafos);
  const actual = new Map();
  const malos = [];
  const uso = { llamadas: 0, entrada: 0, salida: 0 };
  const inicio = Date.now();

  console.log(`\n${modelo}`);
  await porRutas({ prosa, skill, modelo, actual, malos, uso, porTanda });
  if (conPasada) {
    await pasada({ prosa, skill, modelo, actual, uso, vuelta: 1, porTanda });
    await pasada({ prosa, skill, modelo, actual, uso, vuelta: 2, porTanda });
  }

  const cambios = {};
  for (const parrafo of prosa) {
    const texto = actual.get(parrafo.clave);
    if (texto && texto !== parrafo.texto) cambios[parrafo.clave] = { original: parrafo.texto, texto };
  }
  const hecho = traduccion.traducir(buffer, cambios, prosa, { idioma: null });
  const corto = modelo.replace(/^[a-z]+:/, '').replace(/[^\w.-]+/g, '_');
  const destino = path.join(salida ?? path.dirname(ruta), `${path.basename(ruta, '.docx')} (skill - ${corto}).docx`);
  fs.writeFileSync(destino, hecho.buffer);

  const antes = medir(prosa.map((p) => p.texto));
  const despues = medir(prosa.map((p) => actual.get(p.clave) ?? p.texto));
  const coste = costeDe(modelo, uso);
  console.log(`  ${hecho.tocados} de ${prosa.length} párrafos cambiados; ${malos.length} se quedaron como estaban`);
  for (const malo of malos.slice(0, 6)) console.log(`    · [${malo.ruta}] ${String(malo.motivo).slice(0, 110)}`);
  console.log(`  oración media ${antes.media} → ${despues.media} palabras · vocabulario de IA ${antes.vocabulario} → ${despues.vocabulario} · conectores de manual ${antes.manual} → ${despues.manual} · párrafos con moldes repetidos ${antes.moldes} → ${despues.moldes}`);
  console.log(`  ${uso.llamadas} llamadas · ${uso.entrada} tokens de entrada · ${uso.salida} de salida · coste ${coste === null ? 'sin tarifa' : `$${coste.toFixed(4)}`} · ${Math.round((Date.now() - inicio) / 1000)} s`);
  console.log(`  → ${destino}`);
}

async function principal() {
  const args = argumentos(process.argv.slice(2));
  const ruta = typeof args.doc === 'string' ? path.resolve(args.doc) : null;
  if (!ruta || !fs.existsSync(ruta)) throw new Error('Falta --doc con la ruta de un .docx que exista.');
  const skill = leerSkill(typeof args.skill === 'string' ? path.resolve(args.skill) : SKILL_POR_DEFECTO);
  const modelos = String(typeof args.modelos === 'string' ? args.modelos : motor.modelos('HUMANIZAR')[0])
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const salida = typeof args.salida === 'string' ? path.resolve(args.salida) : null;
  if (salida) fs.mkdirSync(salida, { recursive: true });
  const porTanda = Number(args['por-tanda']) || 900;

  for (const modelo of modelos) {
    try {
      await probar({ ruta, modelo, skill, conPasada: !args['sin-pasada'], salida, porTanda });
    } catch (error) {
      console.log(`\n${modelo}\n  FALLÓ: ${error.message}`);
    }
  }
}

if (require.main === module) {
  principal()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { porCapitulos, moldesDe, rutaDelTitulo, leerSkill, sistemaDe };
