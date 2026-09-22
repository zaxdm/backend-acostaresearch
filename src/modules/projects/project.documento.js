'use strict';

/**
 * La tesis que el tesista escribió por su cuenta, citada dentro de su propio Word.
 *
 * PARA QUÉ
 * --------
 * Hay quien llega con la tesis o el artículo ya escritos y sin una sola
 * referencia. Rehacerlos en capítulos para que el servidor los arme de nuevo le
 * quitaría lo que ya tiene —sus tablas, sus figuras, su portada, el formato de
 * su facultad— y le devolvería un documento que no reconoce. Así que no se
 * rehace: sube su .docx, Claude lo lee por párrafos y dice dónde va cada cita, y
 * aquí se ponen DENTRO de ese mismo archivo. Todo lo demás sale como entró.
 *
 * CÓMO SE SABE DÓNDE VA CADA CITA
 * -------------------------------
 * Claude devuelve el párrafo con las marcas de siempre puestas: «…afecta al
 * rendimiento [AR97D22F86].». De ese texto NO se escribe nada en el Word: solo
 * dice dónde. Por eso se compara con el original sin espacios —si Claude cambió
 * una palabra, el párrafo se rechaza— y la posición se cuenta en caracteres
 * visibles: la cita va detrás del carácter número k, que es el mismo en su texto
 * y en el del Word aunque los espacios no coincidan.
 *
 * Donde no encontró fuente escribe «[FALTA FUENTE]», y en el Word sale
 * resaltado en amarillo para que el tesista lo encuentre.
 *
 * POR QUÉ A MANO SOBRE EL XML
 * ---------------------------
 * La librería `docx` escribe documentos, no los edita, y abrir y volver a
 * guardar con cualquier otra cosa pierde lo que esa cosa no entienda. Aquí solo
 * se AÑADEN corridas de texto en puntos concretos de `word/document.xml`; ni una
 * etiqueta del tesista se reescribe, salvo el `xml:space` de un texto que hay
 * que partir en dos.
 *
 * Las normas de notas al pie no se admiten todavía: crear notas en un documento
 * ajeno es otra obra, y una nota mal enlazada deja el Word sin abrir.
 */

const { abrirZip } = require('./project.zip');

const csl = require('./project.csl');
const normas = require('./project.normas');
const { MARCA } = require('./project.citas');

/** Una tesis con figuras pasa de los 5 MB de una plantilla; cuarenta cubren casi todas. */
const MAXIMO_BYTES = 40 * 1024 * 1024;

const OBLIGATORIOS = ['[Content_Types].xml', 'word/document.xml'];
const PARTE = 'word/document.xml';

const FALTA = /\[FALTA FUENTE\]/gi;
const TEXTO_FALTA = '[falta fuente]';

class DocumentoNoValido extends Error {}
class NormaConNotas extends Error {}

// ── Abrirlo ────────────────────────────────────────────────────────────────

/** Lanza `DocumentoNoValido` con un mensaje que se le puede enseñar al tesista tal cual. */
function abrir(buffer) {
  if (!buffer || buffer.length === 0) {
    throw new DocumentoNoValido('El archivo llegó vacío. Vuelve a subirlo.');
  }

  if (buffer.length > MAXIMO_BYTES) {
    throw new DocumentoNoValido(
      `Ese archivo pesa más de ${MAXIMO_BYTES / 1024 / 1024} MB. Si lleva muchas imágenes, ` +
        'comprímelas en Word («Archivo» → «Comprimir imágenes») y vuelve a subirlo.',
    );
  }

  // Un .docx es un zip. Un .doc antiguo no, y es el error más probable.
  if (buffer.subarray(0, 2).toString() !== 'PK') {
    throw new DocumentoNoValido(
      'Eso no es un .docx. Si tu documento es un .doc antiguo o un PDF, ábrelo en Word y ' +
        'guárdalo como «Documento de Word (.docx)».',
    );
  }

  let zip;
  try {
    zip = abrirZip(buffer);
  } catch {
    throw new DocumentoNoValido('No se pudo abrir el archivo. ¿Está completo?');
  }

  const dentro = new Set(zip.getEntries().map((e) => e.entryName));
  if (!OBLIGATORIOS.every((necesario) => dentro.has(necesario))) {
    throw new DocumentoNoValido('Eso no parece un documento de Word. Sube el .docx de tu tesis.');
  }

  const xml = zip.getEntry(PARTE).getData().toString('utf8');
  if (!xml.includes('<w:body')) {
    throw new DocumentoNoValido('El contenido de ese documento no se pudo leer.');
  }

  const estilos = zip.getEntry('word/styles.xml')?.getData().toString('utf8') ?? '';
  return { zip, xml, estilos };
}

// ── Leer el texto sin perder de dónde sale ─────────────────────────────────

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function desescapar(crudo) {
  return crudo.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entera, cuerpo) => {
    if (cuerpo[0] === '#') {
      const hexadecimal = cuerpo[1] === 'x' || cuerpo[1] === 'X';
      const codigo = parseInt(cuerpo.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : entera;
    }
    return ENTIDADES[cuerpo.toLowerCase()] ?? entera;
  });
}

const escaparXml = (texto) =>
  String(texto).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Dónde, dentro del texto crudo de un `<w:t>`, acaba el carácter `d` del texto leído. */
function posicionCruda(crudo, d) {
  let i = 0;
  let leidos = 0;
  while (leidos < d && i < crudo.length) {
    const fin = crudo[i] === '&' ? crudo.indexOf(';', i) : -1;
    if (fin !== -1) {
      leidos += desescapar(crudo.slice(i, fin + 1)).length;
      i = fin + 1;
    } else {
      leidos += 1;
      i += 1;
    }
  }
  return i;
}

const nombreDe = (etiqueta) => (etiqueta.match(/^<\/?\s*([\w:.-]+)/) || [])[1] ?? null;

/**
 * Los párrafos del documento, cada uno con los trozos de texto que lo forman y
 * la posición exacta de cada trozo en el XML.
 *
 * Un párrafo de Word no es una cadena: es una fila de corridas, cada una con su
 * formato, y la frase «el rendimiento» puede estar partida en tres porque el
 * corrector ortográfico pasó por en medio. Por eso se guarda de cada `<w:t>`
 * dónde empieza y a qué corrida pertenece: para poder partirla justo ahí.
 *
 * Se ignora `mc:Fallback`, la copia antigua que Word guarda de los cuadros de
 * texto: citar ahí sería citar dos veces lo mismo, y Word no la enseña.
 */
function parrafosDe(xml) {
  const parrafos = [];
  const abiertos = [];
  const corridas = [];
  let fallback = 0;
  let tablas = 0;
  let esperandoRPr = null;
  let rPrAbierto = null;
  let texto = null;

  const corridaDelParrafo = () => {
    const corrida = corridas.at(-1);
    return corrida && corrida.parrafo && corrida.parrafo === abiertos.at(-1) ? corrida : null;
  };

  for (const m of xml.matchAll(/<[^>]*>|[^<]+/g)) {
    const pieza = m[0];
    const i = m.index;

    if (pieza[0] !== '<') {
      if (texto && fallback === 0) {
        texto.crudo = pieza;
        texto.contenidoInicio = i;
      }
      continue;
    }
    if (pieza.startsWith('<?') || pieza.startsWith('<!')) continue;

    const nombre = nombreDe(pieza);
    const cierra = pieza.startsWith('</');
    const sola = pieza.endsWith('/>');

    if (nombre === 'mc:Fallback') {
      if (cierra) fallback -= 1;
      else if (!sola) fallback += 1;
      continue;
    }
    if (fallback > 0) continue;

    // El formato de una corrida es siempre su primer hijo. Se copia para que la
    // cita salga con la misma letra que el texto que la rodea.
    if (esperandoRPr) {
      const corrida = esperandoRPr;
      esperandoRPr = null;
      if (nombre === 'w:rPr' && !cierra && !sola) rPrAbierto = { corrida, inicio: i, profundidad: 0 };
    }
    if (rPrAbierto && nombre === 'w:rPr') {
      if (cierra) {
        rPrAbierto.profundidad -= 1;
        if (rPrAbierto.profundidad === 0) {
          rPrAbierto.corrida.rPr = xml.slice(rPrAbierto.inicio, i + pieza.length);
          rPrAbierto = null;
        }
      } else if (!sola) {
        rPrAbierto.profundidad += 1;
      }
      continue;
    }

    switch (nombre) {
      case 'w:tbl':
        if (cierra) tablas -= 1;
        else if (!sola) tablas += 1;
        break;

      case 'w:p': {
        if (cierra) {
          const parrafo = abiertos.pop();
          if (parrafo) {
            parrafo.fin = i + pieza.length;
            parrafos.push(parrafo);
          }
        } else {
          const parrafo = { inicio: i, fin: i + pieza.length, piezas: [], estilo: null, enTabla: tablas > 0 };
          if (sola) parrafos.push(parrafo);
          else abiertos.push(parrafo);
        }
        break;
      }

      case 'w:pStyle': {
        const parrafo = abiertos.at(-1);
        if (parrafo && parrafo.estilo === null && parrafo.piezas.length === 0 && corridas.at(-1)?.parrafo !== parrafo) {
          parrafo.estilo = (pieza.match(/w:val="([^"]*)"/) || [])[1] ?? null;
        }
        break;
      }

      case 'w:r': {
        if (cierra) {
          const corrida = corridas.pop();
          if (corrida) corrida.fin = i + pieza.length;
        } else if (!sola) {
          const corrida = { inicio: i, fin: null, rPr: '', parrafo: abiertos.at(-1) ?? null };
          corridas.push(corrida);
          esperandoRPr = corrida;
        }
        break;
      }

      case 'w:t': {
        if (!cierra && !sola) {
          texto = { etiquetaInicio: i, etiqueta: pieza, contenidoInicio: i + pieza.length, crudo: '', corrida: corridaDelParrafo() };
        } else if (cierra && texto) {
          texto.texto = desescapar(texto.crudo);
          texto.cierreFin = i + pieza.length;
          if (texto.corrida && texto.texto !== '') {
            texto.corrida.parrafo.piezas.push({ tipo: 'texto', nodo: texto, texto: texto.texto });
          }
          texto = null;
        }
        break;
      }

      // Espacios que no son texto: cuentan para leer, no para contar posiciones.
      case 'w:tab':
      case 'w:ptab':
      case 'w:br':
      case 'w:cr': {
        const corrida = corridaDelParrafo();
        if (corrida) corrida.parrafo.piezas.push({ tipo: 'espacio', texto: nombre === 'w:br' || nombre === 'w:cr' ? '\n' : '\t' });
        break;
      }

      // Signos visibles sin `<w:t>`: sí cuentan, y lo que venga detrás va tras su corrida.
      case 'w:noBreakHyphen':
      case 'w:sym': {
        const corrida = corridaDelParrafo();
        if (corrida) corrida.parrafo.piezas.push({ tipo: 'signo', corrida, texto: nombre === 'w:sym' ? '□' : '-' });
        break;
      }

      default:
        break;
    }
  }

  parrafos.sort((a, b) => a.inicio - b.inicio);
  return parrafos.map((parrafo, n) => {
    let desde = 0;
    for (const trozo of parrafo.piezas) {
      trozo.desde = desde;
      desde += trozo.texto.length;
    }
    return { ...parrafo, id: n + 1, texto: parrafo.piezas.map((t) => t.texto).join('') };
  });
}

/** Del identificador del estilo a su nombre: «Heading1» → «heading 1». */
function nombresDeEstilos(estilosXml) {
  const nombres = new Map();
  for (const m of String(estilosXml).matchAll(/<w:style\b[^>]*?w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g)) {
    const nombre = (m[2].match(/<w:name w:val="([^"]*)"/) || [])[1];
    if (nombre) nombres.set(m[1], nombre);
  }
  return nombres;
}

/**
 * Una línea del índice, por el nombre del estilo o por su identificador.
 *
 * Por los dos y no solo por el nombre: Word llama al estilo «toc 1» («TDC 1» en
 * español) y le pone de identificador «TOC1», pero un documento puede usar el
 * identificador sin declarar el estilo en `styles.xml` —es lo que hacía el Word
 * que genera este mismo sistema—, y entonces no hay nombre que mirar. Sin esto,
 * las líneas del índice se leen como si fueran prosa: se le mandan a Claude, se
 * cuentan como palabras del cliente y se intentan traducir.
 */
const ESTILO_DE_INDICE = /^(toc|tdc|[íi]ndice)\s*\d/i;

/**
 * Los párrafos con texto, como los lee Claude.
 *
 * Fuera los vacíos y las líneas del índice: en ninguno de los dos va una cita,
 * y en una tesis de cien páginas son cientos de líneas que Claude tendría que
 * leer para nada. El identificador es el orden del párrafo en el documento
 * entero, con los vacíos contados, así que no cambia mientras no cambie el Word.
 */
function leer(buffer) {
  const { xml, estilos } = abrir(buffer);
  const nombres = nombresDeEstilos(estilos);

  // Lo que va debajo de «Referencias» hasta el título siguiente es la lista: ahí
  // no se cita ni se humaniza. Se marca aquí porque solo aquí se ven los estilos.
  let enReferencias = false;

  return parrafosDe(xml)
    .map((parrafo) => {
      const estilo = nombres.get(parrafo.estilo) ?? '';
      const nivel = Number((estilo.match(/^heading (\d)$/i) || [])[1]) || null;
      const indice = ESTILO_DE_INDICE.test(estilo) || ESTILO_DE_INDICE.test(parrafo.estilo ?? '');
      const titulo = !indice && !parrafo.enTabla && TITULO_DE_REFERENCIAS.test(normalizarTitulo(parrafo.texto));
      if (titulo) enReferencias = true;
      else if (nivel) enReferencias = false;
      return {
        id: parrafo.id,
        texto: parrafo.texto,
        nivel,
        indice,
        enTabla: parrafo.enTabla,
        referencias: enReferencias && !titulo,
      };
    })
    .filter((parrafo) => parrafo.texto.trim() !== '' && !parrafo.indice)
    .map(({ indice, ...parrafo }) => parrafo);
}

// ── Comprobar lo que devuelve Claude ───────────────────────────────────────

/** Comillas y guiones que se escriben de varias formas, a una sola. Todos de un carácter a uno. */
const EQUIVALENTES = {
  '“': '"', '”': '"', '„': '"', '«': '"', '»': '"',
  '‘': "'", '’': "'", '‚': "'",
  '–': '-', '—': '-', '‑': '-', '−': '-',
};

/** El texto sin espacios: lo que no puede cambiar entre el Word y lo que devuelve Claude. */
function esqueleto(texto) {
  let resultado = '';
  for (const caracter of String(texto)) {
    if (!/\s/.test(caracter)) resultado += EQUIVALENTES[caracter] ?? caracter;
  }
  return resultado;
}

const sinMarcas = (texto) => String(texto).replace(MARCA, '').replace(FALTA, '');

/**
 * Null si el párrafo marcado es el mismo que el del Word; si no, por qué no.
 *
 * El motivo enseña dónde se separan, porque «no coincide» sin más obliga a
 * Claude a adivinar qué tocó, y lo que suele haber tocado es una comilla.
 */
function comprobar(original, conMarcas) {
  const a = esqueleto(original);
  const b = esqueleto(sinMarcas(conMarcas));
  if (a === b) return null;

  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const trozo = (s) => s.slice(Math.max(0, i - 25), i + 25);
  return (
    'el texto no es el del Word: cópialo tal cual y añade solo las marcas. ' +
    `Se separan aquí (sin espacios): Word «${trozo(a)}», el tuyo «${trozo(b)}».`
  );
}

/**
 * Los párrafos citados de un Word anterior, en el Word nuevo.
 *
 * Quien corrige una coma y vuelve a subir su tesis no puede perder las citas de
 * los otros doscientos párrafos. Cada párrafo citado se busca por su texto —el
 * esqueleto, que no depende de los identificadores—, y si hay varios iguales, el
 * más cercano a donde estaba.
 */
function reubicar(citados, parrafos) {
  const porEsqueleto = new Map();
  for (const parrafo of parrafos) {
    const clave = esqueleto(parrafo.texto);
    if (!porEsqueleto.has(clave)) porEsqueleto.set(clave, []);
    porEsqueleto.get(clave).push(parrafo.id);
  }

  const usados = new Set();
  const nuevos = {};
  let perdidos = 0;

  for (const [id, texto] of Object.entries(citados ?? {})) {
    const candidatos = (porEsqueleto.get(esqueleto(sinMarcas(texto))) ?? []).filter((c) => !usados.has(c));
    if (candidatos.length === 0) {
      perdidos += 1;
      continue;
    }
    const elegido = candidatos.reduce((mejor, c) =>
      Math.abs(c - Number(id)) < Math.abs(mejor - Number(id)) ? c : mejor,
    );
    usados.add(elegido);
    nuevos[elegido] = texto;
  }

  return { citados: nuevos, perdidos };
}

// ── Poner las citas ────────────────────────────────────────────────────────

/** Lo que dejó `csl.renderizar` en el texto, y lo que Claude marcó sin fuente. */
const PUESTO = /⟦C(\d+)⟧|\s?\[CITA SIN LOCALIZAR: revísala\]|\[FALTA FUENTE\]/gi;

/**
 * Qué va en el párrafo, y detrás de cuántos caracteres visibles.
 *
 * `antes` y `despues` dicen si Claude dejó un espacio a ese lado: «rendimiento
 * [AR…].» lleva espacio antes y no después, y así tiene que salir.
 */
function insercionesDe(renderizado) {
  const lista = [];
  let k = 0;
  let desde = 0;

  for (const m of renderizado.matchAll(PUESTO)) {
    for (let i = desde; i < m.index; i += 1) if (!/\s/.test(renderizado[i])) k += 1;
    const fin = m.index + m[0].length;
    lista.push({
      k,
      antes: m.index > 0 && /\s/.test(renderizado[m.index - 1] ?? ''),
      despues: /\s/.test(renderizado[fin] ?? ''),
      cita: m[1] ? Number(m[1]) : null,
      tipo: m[1] ? 'cita' : /FALTA/i.test(m[0]) ? 'falta' : 'perdida',
    });
    desde = fin;
  }

  return lista;
}

/** La posición, en el texto del párrafo, justo detrás del carácter visible número k. */
function indiceTras(texto, k) {
  if (k === 0) return 0;
  let vistos = 0;
  for (let i = 0; i < texto.length; i += 1) {
    if (!/\s/.test(texto[i])) {
      vistos += 1;
      if (vistos === k) return i + 1;
    }
  }
  return texto.length;
}

/**
 * Dónde se escribe en el XML algo que va en la posición `indice` del párrafo.
 *
 * `corte` es el `<w:t>` que hay que partir en dos; sin él, lo nuevo va entero
 * entre dos corridas.
 */
function puntoDeInsercion(parrafo, indice, xml) {
  const textos = parrafo.piezas.filter((p) => p.tipo === 'texto');
  if (textos.length === 0) return null;

  if (indice === 0) {
    const { corrida } = textos[0].nodo;
    return { pos: corrida.inicio, rPr: corrida.rPr, corte: null };
  }

  const pieza = parrafo.piezas.find(
    (p) => p.tipo !== 'espacio' && p.desde < indice && indice <= p.desde + p.texto.length,
  );
  if (!pieza) return null;

  if (pieza.tipo === 'signo') return { pos: pieza.corrida.fin, rPr: pieza.corrida.rPr, corte: null };

  const { nodo } = pieza;
  const d = indice - pieza.desde;
  if (d === nodo.texto.length && xml.startsWith('</w:r>', nodo.cierreFin)) {
    return { pos: nodo.corrida.fin, rPr: nodo.corrida.rPr, corte: null };
  }
  return { pos: nodo.contenidoInicio + posicionCruda(nodo.crudo, d), rPr: nodo.corrida.rPr, corte: nodo };
}

/**
 * Los hijos de un `<w:rPr>`, en el orden que exige el esquema.
 *
 * Word da el documento por dañado si un hijo va fuera de su sitio, y no dice
 * cuál. Lo que no está en la lista va al final, que es donde van las
 * extensiones de las versiones nuevas.
 */
const ORDEN_RPR = [
  'w:rStyle', 'w:rFonts', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike',
  'w:dstrike', 'w:outline', 'w:shadow', 'w:emboss', 'w:imprint', 'w:noProof', 'w:snapToGrid',
  'w:vanish', 'w:webHidden', 'w:color', 'w:spacing', 'w:w', 'w:kern', 'w:position', 'w:sz',
  'w:szCs', 'w:highlight', 'w:u', 'w:effect', 'w:bdr', 'w:shd', 'w:fitText', 'w:vertAlign',
  'w:rtl', 'w:cs', 'w:em', 'w:lang', 'w:eastAsianLayout', 'w:specVanish', 'w:oMath',
];

/** Lo que del texto de alrededor no se hereda: la cita no sale en negrita porque la frase lo esté. */
const NO_SE_HEREDA = new Set([
  'w:rStyle', 'w:b', 'w:bCs', 'w:i', 'w:iCs', 'w:caps', 'w:smallCaps', 'w:strike', 'w:dstrike',
  'w:vanish', 'w:highlight', 'w:u', 'w:shd', 'w:vertAlign', 'w:rPrChange',
]);

function hijosDeRPr(rPr) {
  const dentro = String(rPr ?? '').replace(/^<w:rPr\b[^>]*>/, '').replace(/<\/w:rPr>$/, '');
  const hijos = [];
  let profundidad = 0;
  let inicio = 0;
  let nombre = null;

  for (const m of dentro.matchAll(/<[^>]+>/g)) {
    const pieza = m[0];
    if (pieza.startsWith('</')) {
      profundidad -= 1;
      if (profundidad === 0) hijos.push({ nombre, xml: dentro.slice(inicio, m.index + pieza.length) });
    } else if (pieza.endsWith('/>')) {
      if (profundidad === 0) hijos.push({ nombre: nombreDe(pieza), xml: pieza });
    } else {
      if (profundidad === 0) {
        inicio = m.index;
        nombre = nombreDe(pieza);
      }
      profundidad += 1;
    }
  }

  return hijos;
}

function rPrPara(base, tramo) {
  const hijos = hijosDeRPr(base).filter((h) => !NO_SE_HEREDA.has(h.nombre));
  const poner = (nombre, xml) => hijos.push({ nombre, xml });

  if (tramo.negrita) {
    poner('w:b', '<w:b/>');
    poner('w:bCs', '<w:bCs/>');
  }
  if (tramo.cursiva) {
    poner('w:i', '<w:i/>');
    poner('w:iCs', '<w:iCs/>');
  }
  if (tramo.versalitas) poner('w:smallCaps', '<w:smallCaps/>');
  if (tramo.resaltado) poner('w:highlight', '<w:highlight w:val="yellow"/>');
  if (tramo.superindice) poner('w:vertAlign', '<w:vertAlign w:val="superscript"/>');
  else if (tramo.subindice) poner('w:vertAlign', '<w:vertAlign w:val="subscript"/>');

  const lugar = (nombre) => {
    const i = ORDEN_RPR.indexOf(nombre);
    return i === -1 ? ORDEN_RPR.length : i;
  };
  const ordenados = hijos
    .map((hijo, i) => ({ ...hijo, i }))
    .sort((a, b) => lugar(a.nombre) - lugar(b.nombre) || a.i - b.i);

  return ordenados.length > 0 ? `<w:rPr>${ordenados.map((h) => h.xml).join('')}</w:rPr>` : '';
}

const corridaXml = (tramo, base) =>
  `<w:r>${rPrPara(base, tramo)}<w:t xml:space="preserve">${escaparXml(tramo.texto)}</w:t></w:r>`;

/** Los tramos con formato de lo que va en un punto. */
function tramosDe(insercion, citas) {
  if (insercion.tipo === 'falta') return [{ texto: TEXTO_FALTA, resaltado: true }];
  if (insercion.tipo === 'perdida') return [{ texto: csl.CITA_PERDIDA, resaltado: true }];
  return citas.get(insercion.cita)?.tramos ?? [];
}

/** Las ediciones de un párrafo: posición en el XML, cuánto se borra y qué se pone. */
function edicionesDeParrafo(parrafo, renderizado, citas, xml) {
  const ediciones = [];
  const partidos = new Set();

  for (const insercion of insercionesDe(renderizado)) {
    const tramos = tramosDe(insercion, citas);
    if (tramos.length === 0) continue;

    const indice = indiceTras(parrafo.texto, insercion.k);
    const punto = puntoDeInsercion(parrafo, indice, xml);
    if (!punto) continue;

    // Un número volado va pegado a la palabra, como lo escribe Nature.
    const volada = tramos.every((t) => t.superindice);
    const conEspacio = [
      ...(insercion.antes && insercion.k > 0 && !volada ? [{ texto: ' ' }] : []),
      ...tramos,
      ...(insercion.despues && /\S/.test(parrafo.texto[indice] ?? '') ? [{ texto: ' ' }] : []),
    ];
    const corridas = conEspacio.map((tramo) => corridaXml(tramo, punto.rPr)).join('');

    if (punto.corte) {
      ediciones.push({
        pos: punto.pos,
        poner: `</w:t></w:r>${corridas}<w:r>${punto.rPr}<w:t xml:space="preserve">`,
      });
      // Partido en dos, el primer trozo puede acabar en espacio: sin `preserve`
      // Word se lo come y la cita sale pegada a la palabra.
      const nodo = punto.corte;
      if (!partidos.has(nodo) && !/xml:space="preserve"/.test(nodo.etiqueta)) {
        partidos.add(nodo);
        ediciones.push({ pos: nodo.etiquetaInicio, borrar: nodo.etiqueta.length, poner: '<w:t xml:space="preserve">' });
      }
    } else {
      ediciones.push({ pos: punto.pos, poner: corridas });
    }
  }

  return ediciones;
}

// ── La lista de referencias ────────────────────────────────────────────────

/** El título que el tesista ya dejó puesto, esperando la lista. */
const TITULO_DE_REFERENCIAS =
  /^(referencias( bibliograficas)?|lista de referencias|bibliografia|fuentes bibliograficas|fuentes de informacion|references|bibliography)$/;

function normalizarTitulo(texto) {
  return String(texto)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[.:]+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const SANGRIA = 720;

function bibliografiaXml(bibliografia, estiloTitulo, conTitulo) {
  const alineada = Boolean(bibliografia.etiquetaAlineada);
  const francesa = alineada || bibliografia.sangriaFrancesa !== false;

  const entradas = bibliografia.entradas.map((entrada) => {
    const corridas = [];
    if (alineada && entrada.etiqueta?.length) {
      corridas.push(...entrada.etiqueta.map((t) => corridaXml(t, '')), '<w:r><w:tab/></w:r>');
    }
    corridas.push(...entrada.tramos.map((t) => corridaXml(t, '')));

    const pPr =
      (alineada ? `<w:tabs><w:tab w:val="left" w:pos="${SANGRIA}"/></w:tabs>` : '') +
      (francesa ? `<w:ind w:left="${SANGRIA}" w:hanging="${SANGRIA}"/>` : '') +
      '<w:jc w:val="left"/>';
    return `<w:p><w:pPr>${pPr}</w:pPr>${corridas.join('')}</w:p>`;
  });

  if (!conTitulo) return entradas.join('');

  // Sin numeración: si su Título 1 numera capítulos, «Referencias» no es uno.
  const titulo = estiloTitulo
    ? `<w:p><w:pPr><w:pStyle w:val="${estiloTitulo}"/><w:pageBreakBefore/>` +
      '<w:numPr><w:ilvl w:val="0"/><w:numId w:val="0"/></w:numPr></w:pPr>' +
      `<w:r><w:t>${escaparXml(bibliografia.titulo)}</w:t></w:r></w:p>`
    : '<w:p><w:pPr><w:pageBreakBefore/><w:jc w:val="center"/></w:pPr>' +
      `<w:r><w:rPr><w:b/><w:bCs/></w:rPr><w:t>${escaparXml(bibliografia.titulo)}</w:t></w:r></w:p>`;

  return titulo + entradas.join('');
}

/**
 * Dónde va la lista y si lleva título.
 *
 * Si el tesista ya escribió «Referencias» y lo dejó vacío, la lista va debajo de
 * ese título, que es donde la espera. Si no, al final del documento, antes de la
 * sección final, con un título en su estilo de Título 1.
 */
function destinoDeLaBibliografia(parrafos, xml, nombres) {
  const titulo = parrafos
    .filter((p) => !p.enTabla && !/\d/.test(p.texto) && TITULO_DE_REFERENCIAS.test(normalizarTitulo(p.texto)))
    .filter((p) => !/^toc /i.test(nombres.get(p.estilo) ?? ''))
    .at(-1);
  if (titulo) return { pos: titulo.fin, conTitulo: false };

  const cierre = xml.lastIndexOf('</w:body>');
  const seccion = xml.lastIndexOf('<w:sectPr', cierre);
  const tramo = seccion === -1 ? '' : xml.slice(seccion, cierre);
  const esDelCuerpo = seccion !== -1 && !tramo.includes('</w:p>') && !tramo.includes('</w:tbl>');
  return { pos: esDelCuerpo ? seccion : cierre, conTitulo: true };
}

function estiloDeTitulo1(nombres) {
  for (const [id, nombre] of nombres) if (/^heading 1$/i.test(nombre)) return id;
  return null;
}

// ── Todo junto ─────────────────────────────────────────────────────────────

/**
 * El Word del tesista con sus citas y su lista de referencias.
 *
 * `citados` son los párrafos que marcó Claude, por identificador. Un párrafo
 * que ya no coincide con el Word —porque el tesista subió otra versión— se
 * salta en vez de poner la cita en otra frase.
 */
function citar(buffer, { citados, norma, idioma, porClave }) {
  const elegida = normas.normaDe(norma);
  if (elegida.familia === 'notas') {
    throw new NormaConNotas(
      `${elegida.nombre} pone las citas en notas al pie, y en un documento subido todavía no se ` +
        'pueden crear. Elige una norma de autor-fecha (como APA) o numérica (como IEEE o Vancouver).',
    );
  }

  const { zip, xml, estilos } = abrir(buffer);
  const nombres = nombresDeEstilos(estilos);
  const parrafos = parrafosDe(xml);
  const porId = new Map(parrafos.map((p) => [p.id, p]));

  const marcados = Object.entries(citados ?? {})
    .map(([id, texto]) => ({ parrafo: porId.get(Number(id)), texto }))
    .filter(({ parrafo, texto }) => parrafo && comprobar(parrafo.texto, texto) === null)
    .sort((a, b) => a.parrafo.id - b.parrafo.id);

  // En orden de lectura: la numeración de IEEE y la desambiguación de APA
  // dependen de lo que se citó antes en todo el documento.
  const r = csl.renderizar({
    norma: elegida.id,
    idioma,
    capitulos: marcados.map(({ texto }) => ({ texto })),
    porClave,
  });

  const ediciones = marcados.flatMap(({ parrafo }, i) => edicionesDeParrafo(parrafo, r.textos[i], r.citas, xml));
  const faltas = marcados.reduce((suma, { texto }) => suma + (texto.match(FALTA)?.length ?? 0), 0);

  if (r.bibliografia) {
    const destino = destinoDeLaBibliografia(parrafos, xml, nombres);
    ediciones.push({
      pos: destino.pos,
      poner: bibliografiaXml(r.bibliografia, estiloDeTitulo1(nombres), destino.conTitulo),
    });
  }

  // De principio a fin y en trozos: con cientos de citas en un XML de varios
  // megas, cortar y pegar la cadena entera en cada una sería cuadrático.
  ediciones.sort((a, b) => a.pos - b.pos);
  const trozos = [];
  let desde = 0;
  for (const edicion of ediciones) {
    trozos.push(xml.slice(desde, edicion.pos), edicion.poner);
    desde = edicion.pos + (edicion.borrar ?? 0);
  }
  trozos.push(xml.slice(desde));

  zip.updateFile(PARTE, Buffer.from(trozos.join(''), 'utf8'));

  return {
    buffer: zip.toBuffer(),
    parrafos: marcados.length,
    citas: r.citas.size,
    referencias: r.usadas.size,
    faltas,
    perdidas: r.perdidas,
    norma: elegida,
  };
}

module.exports = {
  leer,
  citar,
  comprobar,
  reubicar,
  esqueleto,
  sinMarcas,
  parrafosDe,
  abrir,
  desescapar,
  escaparXml,
  nombreDe,
  nombresDeEstilos,
  normalizarTitulo,
  TITULO_DE_REFERENCIAS,
  DocumentoNoValido,
  NormaConNotas,
  MAXIMO_BYTES,
  FALTA,
};
