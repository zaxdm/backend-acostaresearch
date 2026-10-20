'use strict';

/**
 * Qué modelo humaniza mejor: el mismo Word por varios modelos, un Word por
 * modelo, para pasarlos por Turnitin.
 *
 * PARA QUÉ
 * --------
 * La primera prueba de «Humanizar» con Nemotron (20-oct-2026) costó 0,0035 USD
 * por 2.016 palabras y Turnitin dio 84 % de IA. Barato y no sirve. Esto hace la
 * misma tarea que el servicio —mismo prompt, mismas comprobaciones, mismo Word
 * de salida— cambiando solo el modelo, y dice lo que gastó cada uno. Lo que
 * decide es el porcentaje de Turnitin de cada Word; eso no se puede medir aquí.
 *
 * CÓMO SE USA (en el servidor, donde está la clave de Bedrock)
 * -----------------------------------------------------------
 *   node scripts/humanizar-probar.js --listar
 *       Los modelos que da Bedrock con nuestra clave (camino compatible con
 *       OpenAI). Los que salgan se escriben con el prefijo `bedrock:`.
 *
 *   node scripts/humanizar-probar.js --doc prueba.docx --modelos bedrock:a,bedrock:b
 *       Un Word por modelo junto al original: «prueba (humanizado - a).docx».
 *       Sin --modelos, el que usa hoy el servicio.
 *
 * No toca la base ni manda correos: solo lee el Word y llama al modelo.
 */

const fs = require('fs');
const path = require('path');

const env = require('../src/config/env');
const gemini = require('../src/lib/gemini');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const motor = require('../src/modules/preparar/preparar.motor');
const traduccion = require('../src/modules/preparar/preparar.traduccion');

/**
 * USD por millón de tokens (entrada, salida) en Bedrock, por parte del nombre.
 * Orientativo: lo que factura AWS está en Billing → Cost Explorer.
 */
const TARIFAS = [
  ['nemotron-super', 0.15, 0.65],
  ['claude-opus', 5, 25],
  ['claude-sonnet', 3, 15],
  ['claude-haiku', 1, 5],
];

function costeDe(modelo, uso) {
  const tarifa = TARIFAS.find(([parte]) => modelo.includes(parte));
  if (!tarifa) return null;
  return (uso.entrada * tarifa[1] + uso.salida * tarifa[2]) / 1_000_000;
}

function argumentos(lista) {
  const args = {};
  for (let i = 0; i < lista.length; i += 1) {
    if (!lista[i].startsWith('--')) continue;
    const nombre = lista[i].slice(2);
    const siguiente = lista[i + 1];
    args[nombre] = siguiente && !siguiente.startsWith('--') ? siguiente : true;
  }
  return args;
}

async function listar() {
  if (!env.BEDROCK_API_KEY) throw new Error('No hay BEDROCK_API_KEY en el .env.');
  const respuesta = await fetch(`https://bedrock-mantle.${env.BEDROCK_REGION}.api.aws/v1/models`, {
    headers: { Authorization: `Bearer ${env.BEDROCK_API_KEY}` },
  });
  if (!respuesta.ok) throw new Error(`Bedrock contestó ${respuesta.status}: ${await respuesta.text()}`);
  const { data = [] } = await respuesta.json();
  for (const modelo of data.map((m) => m.id).sort()) console.log(`bedrock:${modelo}`);
  console.log(`\n${data.length} modelos.`);
}

const palabrasDe = (parrafos) => parrafos.reduce((total, parrafo) => total + parrafo.palabras, 0);

async function probar(ruta, modelo) {
  const buffer = fs.readFileSync(ruta);
  // Lo mismo que manda el servicio: el cuerpo sin títulos. Ver `preparar.service.producir`.
  const parrafos = cuerpo.cuerpoDe(buffer).parrafos.filter((parrafo) => !parrafo.nivel);
  const inicio = Date.now();

  const { cambios, malos, uso } = await motor.prepararParrafos({
    parrafos,
    servicio: 'HUMANIZAR',
    generar: (peticion) => gemini.generarConRespaldo({ ...peticion, modelos: [modelo] }),
  });

  const hecho = traduccion.traducir(buffer, cambios, parrafos, { idioma: null });
  const corto = modelo.replace(/^[a-z]+:/, '').replace(/[^\w.-]+/g, '_');
  const destino = path.join(
    path.dirname(ruta),
    `${path.basename(ruta, '.docx')} (humanizado - ${corto}).docx`,
  );
  fs.writeFileSync(destino, hecho.buffer);

  const despues = parrafos.map((parrafo) => ({
    palabras: cuerpo.palabrasDe(cambios[parrafo.clave]?.texto ?? parrafo.texto),
  }));
  const coste = costeDe(modelo, uso);

  console.log(`\n${modelo}`);
  console.log(`  ${hecho.tocados} de ${parrafos.length} párrafos humanizados; ${malos.length} sin cambiar`);
  for (const malo of malos.slice(0, 5)) console.log(`    · ${String(malo.motivo).slice(0, 110)}`);
  console.log(`  palabras ${palabrasDe(parrafos)} → ${palabrasDe(despues)}`);
  console.log(`  ${uso.llamadas} llamadas · ${uso.entrada} tokens de entrada · ${uso.salida} de salida`);
  console.log(`  coste ${coste === null ? 'sin tarifa conocida' : `$${coste.toFixed(4)}`} · ${Math.round((Date.now() - inicio) / 1000)} s`);
  console.log(`  → ${destino}`);
}

async function principal() {
  const args = argumentos(process.argv.slice(2));
  if (args.listar) return listar();

  const ruta = typeof args.doc === 'string' ? path.resolve(args.doc) : null;
  if (!ruta || !fs.existsSync(ruta)) {
    throw new Error('Falta --doc con la ruta de un .docx que exista.');
  }
  const modelos = String(typeof args.modelos === 'string' ? args.modelos : motor.modelos('HUMANIZAR')[0])
    .split(',')
    .map((modelo) => modelo.trim())
    .filter(Boolean);

  // De uno en uno: cada modelo ya manda sus tandas en paralelo.
  for (const modelo of modelos) {
    try {
      await probar(ruta, modelo);
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
