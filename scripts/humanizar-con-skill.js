'use strict';

/**
 * Humaniza un Word como el servicio «Humanizar» y deja otro Word al lado,
 * para pasarlo por Turnitin. Sirve para probar otro modelo o una versión
 * nueva de la skill antes de tocar el servicio.
 *
 * Hace exactamente lo mismo que la web: `preparar.humanizar` con la skill de
 * `src/modules/preparar/humanizador/`. Ver su LEEME.md, con los resultados de
 * cada versión en Turnitin.
 *
 * No toca la base ni manda correos: lee el Word, llama al modelo y escribe.
 *
 * CÓMO SE USA (en el servidor, donde está la clave de Bedrock)
 * -----------------------------------------------------------
 *   node scripts/humanizar-con-skill.js --doc prueba.docx
 *   node scripts/humanizar-con-skill.js --doc prueba.docx --modelos bedrock:deepseek.v3.2,bedrock:zai.glm-5
 *
 *   --modelos <a,b>     uno o varios; sin él, el del servicio (`HUMANIZAR_MODELO`)
 *   --skill <carpeta>   otra copia de la skill, para probar cambios sin desplegar
 *   --sin-pasada        sin las dos pasadas sobre el documento entero, para comparar
 *   --por-tanda <n>     palabras por llamada (por defecto la del servicio, 900).
 *                       Los modelos que razonan despacio (GLM de NVIDIA) necesitan 300.
 *   --salida <carpeta>  dónde dejar los Word (por defecto, junto al original)
 */

const fs = require('fs');
const path = require('path');

const env = require('../src/config/env');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const humanizador = require('../src/modules/preparar/preparar.humanizar');
const traduccion = require('../src/modules/preparar/preparar.traduccion');
const controles = require('../src/modules/projects/project.humanizado-controles');

/** USD por millón de tokens (entrada, salida). Orientativo. */
const TARIFAS = [
  ['nemotron-super', 0.15, 0.65],
  ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
];

function costeDe(modelo, uso) {
  const tarifa = TARIFAS.find(([parte]) => modelo.includes(parte));
  return tarifa ? (uso.entrada * tarifa[1] + uso.salida * tarifa[2]) / 1_000_000 : null;
}

/** Cuentas para comparar antes y después; el porcentaje lo dice Turnitin. */
function medir(textos) {
  const todas = textos.flatMap(humanizador.oraciones);
  const largos = todas.map((o) => cuerpo.palabrasDe(o));
  const media = largos.reduce((a, b) => a + b, 0) / Math.max(largos.length, 1);
  const unido = textos.join('\n');
  const vocabulario = controles.VOCABULARIO.reduce((total, palabra) => total + controles.cuantas(unido, palabra), 0);
  const manual = (unido.match(/(^|[.!?]\s+)(Asimismo|Además|Por otro lado|Por su parte|De igual (forma|manera)|En este sentido|No obstante|Sin embargo|Finalmente|En consecuencia)\b/gm) ?? []).length;
  const moldes = humanizador.moldesDe(textos.map((texto, i) => ({ clave: String(i), texto }))).size;
  return { media: media.toFixed(1), vocabulario, manual, moldes };
}

function argumentos(lista) {
  const args = {};
  for (let i = 0; i < lista.length; i += 1) {
    if (!lista[i].startsWith('--')) continue;
    const siguiente = lista[i + 1];
    args[lista[i].slice(2)] = siguiente && !siguiente.startsWith('--') ? siguiente : true;
  }
  return args;
}

async function probar({ ruta, modelo, skill, conPasada, salida, porTanda }) {
  const buffer = fs.readFileSync(ruta);
  const { parrafos } = cuerpo.cuerpoDe(buffer);
  const prosa = humanizador.porCapitulos(parrafos);
  const inicio = Date.now();

  console.log(`\n${modelo}`);
  const porRuta = Object.keys(humanizador.NOMBRES)
    .map((r) => [humanizador.NOMBRES[r], prosa.filter((p) => p.ruta === r).length])
    .filter(([, n]) => n > 0);
  console.log(`  ${porRuta.map(([nombre, n]) => `${nombre}: ${n}`).join(' · ')}`);

  const { cambios, malos, uso, rondas } = await humanizador.humanizar({
    parrafos,
    modelos: [modelo],
    skill,
    conPasada,
    porTanda,
  });

  const hecho = traduccion.traducir(buffer, cambios, prosa, { idioma: null });
  const corto = modelo.replace(/^[a-z]+:/, '').replace(/[^\w.-]+/g, '_');
  const destino = path.join(salida ?? path.dirname(ruta), `${path.basename(ruta, '.docx')} (skill - ${corto}).docx`);
  fs.writeFileSync(destino, hecho.buffer);

  const antes = medir(prosa.map((p) => p.texto));
  const despues = medir(prosa.map((p) => cambios[p.clave]?.texto ?? p.texto));
  const coste = costeDe(modelo, uso);
  for (const r of rondas) {
    const rechazos = Object.entries(r.rechazos).map(([m, n]) => `${n}× ${m}`).join('; ');
    console.log(`  ${r.paso}: ${r.pedidos} pedidos, ${r.tocados} cambiados${r.fallidas ? `, ${r.fallidas} tandas fallidas` : ''}${rechazos ? ` · rechazos: ${rechazos}` : ''}`);
  }
  console.log(`  ${hecho.tocados} de ${prosa.length} párrafos cambiados; ${malos.length} se quedaron como estaban`);
  for (const malo of malos.slice(0, 6)) console.log(`    · ${String(malo.motivo).slice(0, 110)}`);
  console.log(`  oración media ${antes.media} → ${despues.media} palabras · vocabulario de IA ${antes.vocabulario} → ${despues.vocabulario} · conectores de manual ${antes.manual} → ${despues.manual} · párrafos con moldes repetidos ${antes.moldes} → ${despues.moldes}`);
  console.log(`  ${uso.llamadas} llamadas · ${uso.entrada} tokens de entrada · ${uso.salida} de salida · coste ${coste === null ? 'sin tarifa' : `$${coste.toFixed(4)}`} · ${Math.round((Date.now() - inicio) / 1000)} s`);
  console.log(`  → ${destino}`);
}

async function principal() {
  const args = argumentos(process.argv.slice(2));
  const ruta = typeof args.doc === 'string' ? path.resolve(args.doc) : null;
  if (!ruta || !fs.existsSync(ruta)) throw new Error('Falta --doc con la ruta de un .docx que exista.');
  const skill = humanizador.leerSkill(typeof args.skill === 'string' ? path.resolve(args.skill) : undefined);
  const modelos = String(typeof args.modelos === 'string' ? args.modelos : motor.modelos('HUMANIZAR')[0])
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
  const salida = typeof args.salida === 'string' ? path.resolve(args.salida) : null;
  if (salida) fs.mkdirSync(salida, { recursive: true });
  const porTanda = Number(args['por-tanda']) || env.PREPARAR_PALABRAS_POR_TANDA;

  for (const modelo of modelos) {
    try {
      await probar({ ruta, modelo, skill, conPasada: !args['sin-pasada'], salida, porTanda });
    } catch (error) {
      console.log(`\n${modelo}\n  FALLÓ: ${error.message}`);
    }
  }
}

principal()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
