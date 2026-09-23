'use strict';

/**
 * Qué modelo corrige mejor, medido contra un editor humano.
 *
 * PARA QUÉ
 * --------
 * «Preparar documento» se vende, y quien decide qué modelo lo hace no debería
 * decidirlo por lo que le parezca. Esto pone números: se coge un manuscrito que
 * corrigió una editorial de verdad, se le pide a cada modelo que corrija EL
 * MISMO original, y se compara lo que propone con lo que propuso el humano.
 *
 * EL PATRÓN ORO
 * -------------
 * Un .docx con control de cambios de una editorial de corrección. De ahí salen
 * dos documentos:
 *   · el ORIGINAL, rechazando todas sus revisiones;
 *   · el FINAL, aceptándolas todas.
 * El original es lo que se le da a cada modelo. El final es contra lo que se
 * le puntúa.
 *
 * QUÉ SE MIDE, Y POR QUÉ ESO
 * --------------------------
 * No «si escribe bonito», que no se puede medir, sino lo que de verdad rompe
 * las entregas —y lo que las rompió el 22-sep-2026, cuando cinco párrafos de
 * una tesis volvieron en español porque el modelo se saltó sus claves—:
 *
 *   · ENTREGADOS  cuántos párrafos sobreviven a `preparar.motor.comprobar`:
 *                 volvieron, con sus cifras intactas, sin juntarse ni partirse.
 *                 Es el número que decide cuánto del documento recibe el
 *                 cliente. Manda por encima de todo lo demás.
 *   · CITAS       cuántos sobreviven además a `preparar.campos`, que exige que
 *                 las citas vuelvan literales. Un párrafo que falla aquí se
 *                 entrega SIN corregir.
 *   · COINCIDE    de los párrafos que el humano tocó, en cuántos el modelo
 *                 acabó escribiendo lo mismo. Es acertar.
 *   · TOCA DE MÁS en cuántos párrafos que el humano dejó en paz metió mano el
 *                 modelo. Cada uno es un tachado que el autor tiene que revisar
 *                 para nada, y a partir de cierto número deja de mirarlos y lo
 *                 acepta todo. Menos es mejor.
 *
 * Los dos últimos son precisión y cobertura de toda la vida, dichas en las
 * palabras del oficio.
 *
 * CÓMO SE USA
 * -----------
 *   node scripts/comparar-modelos.js --patron "ruta/al/corregido.docx"
 *   node scripts/comparar-modelos.js --patron "…" --modelos gemini-3.8-flash,groq:openai/gpt-oss-120b
 *   node scripts/comparar-modelos.js --patron "…" --simular
 *
 * `--simular` no llama a nadie: devuelve el propio texto del humano, así que
 * tiene que sacar pleno en todo. Sirve para comprobar que el marcador mide
 * bien antes de gastar un céntimo.
 *
 * LO QUE CUESTA
 * -------------
 * Una tanda por cada `PREPARAR_PALABRAS_POR_TANDA` palabras, por modelo. Un
 * manuscrito de 4.500 palabras son seis peticiones: comparar cuatro modelos
 * cuesta veinticuatro. El precio de esta decisión es despreciable; el de
 * tomarla a ojo, no.
 */

const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const documento = require('../src/modules/projects/project.documento');
const cuerpo = require('../src/modules/preparar/preparar.cuerpo');
const campos = require('../src/modules/preparar/preparar.campos');
const motor = require('../src/modules/preparar/preparar.motor');
const cambios = require('../src/modules/preparar/preparar.cambios');
const gemini = require('../src/lib/gemini');
const env = require('../src/config/env');

// ── Los argumentos ─────────────────────────────────────────────────────────

function argumentos(lista) {
  const dados = {};
  for (let i = 0; i < lista.length; i += 1) {
    if (!lista[i].startsWith('--')) continue;
    const nombre = lista[i].slice(2);
    const valor = lista[i + 1] && !lista[i + 1].startsWith('--') ? lista[i + 1] : true;
    dados[nombre] = valor;
  }
  return dados;
}

// ── Deshacer y rehacer el control de cambios ───────────────────────────────

/**
 * El XML sin los bloques `<nombre>…</nombre>`, contando el anidamiento.
 *
 * A mano y no con un parser: es el mismo criterio que sigue todo
 * `project.documento`, y meter una dependencia para esto sería meterla para
 * que un script de medir compile.
 */
function quitarBloques(xml, nombre) {
  const abre = new RegExp(`<${nombre}[ >]`);
  let salida = xml;

  for (;;) {
    const encaje = salida.match(abre);
    if (!encaje) return salida;

    const desde = encaje.index;
    let profundidad = 0;
    let hasta = -1;

    for (const pieza of salida.slice(desde).matchAll(/<[^>]*>/g)) {
      const etiqueta = pieza[0];
      if (documento.nombreDe(etiqueta) !== nombre) continue;
      if (etiqueta.startsWith('</')) profundidad -= 1;
      else if (!etiqueta.endsWith('/>')) profundidad += 1;
      if (profundidad === 0) {
        hasta = desde + pieza.index + etiqueta.length;
        break;
      }
    }

    // Mal formado: se deja como está antes que dar vueltas para siempre.
    if (hasta === -1) return salida;
    salida = salida.slice(0, desde) + salida.slice(hasta);
  }
}

/** El XML sin las etiquetas `<nombre>` y `</nombre>`, dejando lo de dentro. */
const desenvolver = (xml, nombre) =>
  xml
    .replace(new RegExp(`<${nombre}(?:[ \\t\\r\\n][^>]*)?>`, 'g'), '')
    .replace(new RegExp(`</${nombre}>`, 'g'), '');

/** Rechazar todo: fuera lo que puso el editor, vuelve lo que quitó. */
const rechazarTodo = (xml) =>
  desenvolver(quitarBloques(xml, 'w:ins'), 'w:del')
    .replace(/<w:delText/g, '<w:t')
    .replace(/<\/w:delText>/g, '</w:t>');

/** Aceptar todo: fuera lo que quitó, se queda lo que puso. */
const aceptarTodo = (xml) => desenvolver(quitarBloques(xml, 'w:del'), 'w:ins');

/** El mismo .docx con otro `document.xml` dentro. */
function conOtroCuerpo(buffer, xml) {
  const zip = new AdmZip(buffer);
  zip.updateFile('word/document.xml', Buffer.from(xml, 'utf8'));
  return zip.toBuffer();
}

// ── El patrón oro ──────────────────────────────────────────────────────────

/**
 * Del .docx corregido a mano salen el antes, el después y qué tocó el humano.
 *
 * Los párrafos se emparejan por su posición, no por su texto: los dos
 * documentos salen del MISMO XML, así que el párrafo número n es el mismo en
 * los dos aunque su contenido cambie.
 */
function patronOro(ruta) {
  const buffer = fs.readFileSync(ruta);
  const xml = new AdmZip(buffer).getEntry('word/document.xml').getData().toString('utf8');

  const antes = rechazarTodo(xml);
  const despues = aceptarTodo(xml);

  const original = conOtroCuerpo(buffer, antes);
  const pAntes = documento.parrafosDe(antes);
  const pDespues = documento.parrafosDe(despues);

  const finalPorId = new Map();
  const tocados = new Set();

  for (let i = 0; i < Math.min(pAntes.length, pDespues.length); i += 1) {
    const viejo = pAntes[i];
    const nuevo = pDespues[i];
    if (!viejo.texto.trim()) continue;
    finalPorId.set(viejo.id, nuevo.texto);
    if (documento.esqueleto(viejo.texto) !== documento.esqueleto(nuevo.texto)) tocados.add(viejo.id);
  }

  return {
    original,
    finalPorId,
    tocados,
    revisiones: {
      puestas: (xml.match(/<w:ins[ >]/g) ?? []).length,
      quitadas: (xml.match(/<w:del[ >]/g) ?? []).length,
    },
  };
}

// ── Un modelo, una puntuación ──────────────────────────────────────────────

/** El modelo de mentira del modo `--simular`: devuelve lo que escribió el humano. */
const comoElHumano = (finalPorId) => async ({ mensajes }) => {
  const entrada = JSON.parse(mensajes[0].texto);
  const salida = {};
  for (const clave of Object.keys(entrada)) salida[clave] = finalPorId.get(Number(clave)) ?? entrada[clave];
  return { texto: JSON.stringify(salida) };
};

async function puntuar({ modelo, oro, porTanda, simular }) {
  const { parrafos } = cuerpo.cuerpoDe(oro.original);
  const arranque = Date.now();

  // El humano también corrigió dentro de tablas y en la bibliografía, que este
  // servicio no toca a propósito. Puntuar a un modelo por no hacer lo que no
  // le pedimos sería mentir con números: el denominador son los párrafos que
  // el humano tocó Y que nosotros le llegamos a enseñar.
  const alcanzables = new Set(parrafos.map((p) => p.id));
  const aMejorar = [...oro.tocados].filter((id) => alcanzables.has(id));

  const generar = simular
    ? comoElHumano(oro.finalPorId)
    : (peticion) => gemini.generarConRespaldo({ ...peticion, modelos: [modelo] });

  let cambiosPropuestos;
  let malos = [];
  try {
    const hecho = await motor.prepararParrafos({
      parrafos,
      servicio: 'EDICION',
      generar,
      porTanda,
      aLaVez: 1,
    });
    cambiosPropuestos = hecho.cambios;
    malos = hecho.malos;
  } catch (error) {
    return { modelo, error: error.message };
  }

  // Lo que de verdad acabaría dentro del Word del cliente: `aplicar` vuelve a
  // filtrar por las citas, y un párrafo que se cae ahí se entrega sin corregir.
  const escrito = cambios.aplicar(oro.original, cambiosPropuestos);

  const conCitas = new Set(Object.keys(cambiosPropuestos).map(Number));
  for (const id of escrito.intactos.keys()) conCitas.delete(Number(id));

  let coincide = 0;
  let tocaDeMas = 0;
  for (const [clave, propuesta] of Object.entries(cambiosPropuestos)) {
    const id = Number(clave);
    const delHumano = oro.finalPorId.get(id);
    if (delHumano === undefined) continue;

    if (oro.tocados.has(id)) {
      if (documento.esqueleto(propuesta.texto) === documento.esqueleto(delHumano)) coincide += 1;
      continue;
    }

    // «De más» con el mismo rasero con el que se decidió qué tocó el humano:
    // por el esqueleto. Cambiar un espacio doble por uno simple no es meter
    // mano en un párrafo, y contarlo inflaría a todos los modelos por igual.
    if (documento.esqueleto(propuesta.texto) !== documento.esqueleto(propuesta.original)) {
      tocaDeMas += 1;
    }
  }

  return {
    modelo,
    aMejorar: aMejorar.length,
    entregados: Object.keys(cambiosPropuestos).length + (parrafos.length - Object.keys(cambiosPropuestos).length - malos.length),
    propuestos: Object.keys(cambiosPropuestos).length,
    perdidos: malos.length,
    citasRotas: Object.keys(cambiosPropuestos).length - conCitas.size,
    coincide,
    tocaDeMas,
    revisiones: escrito.tocados,
    segundos: Math.round((Date.now() - arranque) / 1000),
  };
}

// ── El marcador ────────────────────────────────────────────────────────────

const columna = (texto, ancho) => String(texto).padEnd(ancho).slice(0, ancho);
const numero = (valor, ancho) => String(valor).padStart(ancho);

function imprimir(oro, parrafos, filas, aMejorar) {
  console.log('');
  console.log(`Patrón: ${oro.tocados.size} párrafos tocados por el editor humano, de los cuales`);
  console.log(`        ${aMejorar} están dentro de lo que este servicio toca (el resto son`);
  console.log('        tablas y bibliografía, que no se corrigen a propósito).');
  console.log(`        ${oro.revisiones.puestas} inserciones y ${oro.revisiones.quitadas} eliminaciones.`);
  console.log(`        ${parrafos} párrafos de cuerpo en el manuscrito.`);
  console.log('');
  console.log(
    `${columna('modelo', 34)} ${numero('pierde', 7)} ${numero('citas✗', 7)} ${numero('acierta', 8)} ${numero('de más', 7)} ${numero('revis.', 7)} ${numero('seg', 5)}`,
  );
  console.log('─'.repeat(80));

  for (const fila of filas) {
    if (fila.error) {
      console.log(`${columna(fila.modelo, 34)} ${fila.error.slice(0, 44)}`);
      continue;
    }
    console.log(
      `${columna(fila.modelo, 34)} ${numero(fila.perdidos, 7)} ${numero(fila.citasRotas, 7)} ` +
        `${numero(`${fila.coincide}/${fila.aMejorar}`, 8)} ${numero(fila.tocaDeMas, 7)} ` +
        `${numero(fila.revisiones, 7)} ${numero(fila.segundos, 5)}`,
    );
  }

  console.log('');
  console.log('pierde  párrafos que el modelo no devolvió bien: se entregan SIN corregir. Cuanto menos, mejor.');
  console.log('citas✗  párrafos que se caen porque la cita no volvió literal. Cuanto menos, mejor.');
  console.log('acierta de los que tocó el humano, en cuántos escribió lo mismo. Cuanto más, mejor.');
  console.log('de más  párrafos que el humano dejó en paz y el modelo tocó. Cuanto menos, mejor.');
  console.log('revis.  marcas de control de cambios que salen en el Word.');
  console.log('');
}

// ── Correr ─────────────────────────────────────────────────────────────────

async function principal() {
  const args = argumentos(process.argv.slice(2));
  const ruta = typeof args.patron === 'string' ? args.patron : null;

  if (!ruta || !fs.existsSync(ruta)) {
    console.error('Falta --patron "ruta/al/manuscrito-corregido.docx" (un .docx con control de cambios).');
    process.exit(1);
  }

  const simular = Boolean(args.simular);
  const porTanda = Number(args.tanda) || env.PREPARAR_PALABRAS_POR_TANDA;
  const modelos = simular
    ? ['(el propio editor humano)']
    : String(args.modelos ?? motor.modelos().join(',')).split(',').map((m) => m.trim()).filter(Boolean);

  const oro = patronOro(path.resolve(ruta));
  const { parrafos } = cuerpo.cuerpoDe(oro.original);

  console.log(`\nComparando ${modelos.length} modelo(s) sobre ${path.basename(ruta)}`);
  console.log(`Tandas de ${porTanda} palabras → ${motor.tandasDe(parrafos, porTanda).length} peticiones por modelo.`);

  const filas = [];
  for (const modelo of modelos) {
    process.stdout.write(`  · ${modelo}… `);
    const fila = await puntuar({ modelo, oro, porTanda, simular });
    console.log(fila.error ? 'falló' : 'listo');
    filas.push(fila);
  }

  const alcanzables = new Set(parrafos.map((p) => p.id));
  imprimir(oro, parrafos.length, filas, [...oro.tocados].filter((id) => alcanzables.has(id)).length);
}

// Ejecutado a mano corre; importado, deja las piezas para poder probarlas.
if (require.main === module) {
  principal().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

module.exports = { patronOro, puntuar, rechazarTodo, aceptarTodo, quitarBloques, desenvolver };
