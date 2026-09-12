'use strict';

/**
 * Las citas y la bibliografía del Word, en la norma que eligió el tesista.
 *
 * POR QUÉ CITEPROC Y NO A MANO
 * ----------------------------
 * APA estaba escrita a mano en `project.citas`, y para una norma bastaba. Para
 * quince —numeración por orden de aparición, notas al pie, formas abreviadas
 * en la segunda cita— escribirlas a mano es escribir quince veces las mismas
 * reglas y equivocarse en cada una de una forma distinta. citeproc-js es el
 * motor con el que Zotero da formato a las citas, y los estilos son los mismos
 * archivos que usa Zotero: lo que sale de aquí es lo que sacaría Zotero.
 *
 * LICENCIA
 * --------
 * citeproc-js tiene doble licencia, CPAL-1.0 o AGPL-3.0, y se usa tal cual, sin
 * modificarlo, desde el servidor. Estilos e idiomas: CC BY-SA 3.0. Ver
 * `csl/LEEME.md`.
 *
 * LO QUE ESCRIBE EL ASISTENTE
 * ---------------------------
 *   [AR97D22F86]          cita normal
 *   [AR97D22F86:n]        narrativa: «Braun y Clarke (2006) proponen…»
 *   [AR97D22F86:p. 45]    con la página
 *   [AR…][AR…]            seguidas: una sola cita con varias fuentes
 *
 * SI ALGO FALLA
 * -------------
 * Esto lanza y el servicio arma el Word con el APA de siempre. Una norma que no
 * se puede aplicar no puede dejar a nadie sin su documento.
 */

const CSL = require('citeproc');

const normas = require('./project.normas');
const { MARCA, modificadoresDe, hueco } = require('./project.citas');

const SIN_FORMA = '[NO_PRINTED_FORM]';
const CITA_PERDIDA = '[CITA SIN LOCALIZAR: revísala]';
const ESQUEMA = 'https://github.com/citation-style-language/schema/raw/master/csl-citation.json';

/** El código del campo de bibliografía de Zotero. No lleva datos: los saca de las citas. */
const CODIGO_BIBLIOGRAFIA = ' ADDIN ZOTERO_BIBL {"uncited":[],"omitted":[],"custom":[]} CSL_BIBLIOGRAPHY ';

// ── De la ficha a CSL ──────────────────────────────────────────────────────

/**
 * El tipo de obra, en el vocabulario de CSL.
 *
 * Llega escrito de cuatro maneras según por dónde entró la fuente —Zotero dice
 * `journalArticle`, Scopus «Article», OpenAlex `article`, Crossref
 * `journal-article`—, así que se compara en minúsculas y sin separadores. Lo que
 * no se reconoce se trata como artículo de revista, que es lo que son casi todas.
 */
function tipoCsl(itemType) {
  const tipo = String(itemType ?? '').toLowerCase().replace(/[-_\s]/g, '');

  if (tipo.includes('section') || tipo.includes('chapter')) return 'chapter';
  if (tipo.includes('conference') || tipo.includes('proceeding')) return 'paper-conference';
  if (tipo.includes('thesis') || tipo.includes('dissertation')) return 'thesis';
  if (tipo.includes('book') || tipo.includes('monograph')) return 'book';
  if (tipo.includes('report')) return 'report';
  if (tipo.includes('webpage') || tipo.includes('website') || tipo.includes('blog')) return 'webpage';
  if (tipo.includes('dataset')) return 'dataset';
  if (tipo.includes('software') || tipo.includes('computerprogram')) return 'software';
  if (tipo.includes('newspaper')) return 'article-newspaper';
  if (tipo.includes('magazine')) return 'article-magazine';
  if (tipo.includes('encyclopedia') || tipo.includes('dictionary')) return 'entry-encyclopedia';
  return 'article-journal';
}

/**
 * Los tipos cuyo `source` es el continente —la revista, el libro, el congreso—
 * y no la editorial. En los demás, `source` es quien lo publica: la editorial
 * de un libro, la universidad de una tesis.
 */
const CON_CONTINENTE = new Set([
  'article-journal',
  'article-magazine',
  'article-newspaper',
  'chapter',
  'paper-conference',
  'webpage',
  'entry-encyclopedia',
]);

/** «Apellido, N.; Apellido, N.» → personas de CSL. Sin coma, es una institución. */
function personasCsl(autores) {
  return String(autores ?? '')
    .split(/\s*;\s*/)
    .map((persona) => persona.trim())
    .filter(Boolean)
    .map((persona) => {
      const coma = persona.indexOf(',');
      if (coma === -1) return { literal: persona };
      const family = persona.slice(0, coma).trim();
      const given = persona.slice(coma + 1).trim();
      return given ? { family, given } : { family };
    });
}

/** Una ficha de la biblioteca, tal como la entiende citeproc (y Zotero). */
function comoCsl(fuente) {
  const type = tipoCsl(fuente.itemType);
  const item = { id: fuente.ref, type, title: fuente.title || '(sin título)' };

  const autores = personasCsl(fuente.authors);
  if (autores.length > 0) item.author = autores;
  if (fuente.year) item.issued = { 'date-parts': [[Number(fuente.year)]] };
  if (fuente.source) item[CON_CONTINENTE.has(type) ? 'container-title' : 'publisher'] = String(fuente.source).trim();
  if (fuente.volume) item.volume = String(fuente.volume);
  if (fuente.issue) item.issue = String(fuente.issue);
  if (fuente.pages) item.page = String(fuente.pages);
  if (fuente.doi) item.DOI = String(fuente.doi);
  else if (fuente.url) item.URL = String(fuente.url);

  return item;
}

// ── Del HTML de citeproc a tramos con formato ──────────────────────────────

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function desescapar(texto) {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entera, cuerpo) => {
    if (cuerpo[0] === '#') {
      const hexadecimal = cuerpo[1] === 'x' || cuerpo[1] === 'X';
      const codigo = parseInt(cuerpo.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
      return Number.isFinite(codigo) ? String.fromCodePoint(codigo) : entera;
    }
    return ENTIDADES[cuerpo.toLowerCase()] ?? entera;
  });
}

/** Qué pone o quita cada etiqueta. Un `font-style:normal` dentro de cursiva la anula. */
function formatoDeEtiqueta(nombre, etiqueta) {
  if (nombre === 'i' || nombre === 'em') return { cursiva: true };
  if (nombre === 'b' || nombre === 'strong') return { negrita: true };
  if (nombre === 'sup') return { superindice: true };
  if (nombre === 'sub') return { subindice: true };

  const estilo = (etiqueta.match(/style\s*=\s*"([^"]*)"/i) || [])[1] ?? '';
  const pone = {};
  if (/font-style\s*:\s*italic/i.test(estilo)) pone.cursiva = true;
  if (/font-style\s*:\s*normal/i.test(estilo)) pone.cursiva = false;
  if (/font-weight\s*:\s*bold/i.test(estilo)) pone.negrita = true;
  if (/font-weight\s*:\s*normal/i.test(estilo)) pone.negrita = false;
  if (/font-variant\s*:\s*small-caps/i.test(estilo)) pone.versalitas = true;
  if (/font-variant\s*:\s*normal/i.test(estilo)) pone.versalitas = false;
  if (/vertical-align\s*:\s*sup/i.test(estilo)) pone.superindice = true;
  if (/vertical-align\s*:\s*sub/i.test(estilo)) pone.subindice = true;
  return pone;
}

const FORMATOS = ['cursiva', 'negrita', 'superindice', 'subindice', 'versalitas'];

/**
 * Convierte la salida HTML de citeproc en tramos para el Word.
 *
 * Se pide HTML y no texto porque el texto pierde justo lo que una norma exige
 * ver: la revista en cursiva, el número de cita volado de Nature o AMA, las
 * versalitas. Y no se usa un analizador de HTML porque citeproc produce un
 * juego pequeño y fijo de etiquetas, todas bien cerradas.
 */
function comoTramos(html) {
  const tramos = [];
  const pila = [];

  for (const [pieza] of String(html ?? '').matchAll(/<[^>]+>|[^<]+/g)) {
    if (pieza[0] !== '<') {
      // El sangrado entre los <div> de la bibliografía no es texto.
      if (/^\s*$/.test(pieza) && pieza.includes('\n')) continue;

      const texto = desescapar(pieza);
      const formato = Object.fromEntries(FORMATOS.map((f) => [f, false]));
      for (const marco of pila) Object.assign(formato, marco.pone);

      const ultimo = tramos[tramos.length - 1];
      if (ultimo && FORMATOS.every((f) => ultimo[f] === formato[f])) ultimo.texto += texto;
      else tramos.push({ texto, ...formato });
      continue;
    }

    const nombre = (pieza.match(/^<\/?\s*([a-z0-9]+)/i) || [])[1]?.toLowerCase();
    if (!nombre || pieza.endsWith('/>')) continue;

    if (pieza.startsWith('</')) {
      for (let i = pila.length - 1; i >= 0; i -= 1) {
        if (pila[i].nombre === nombre) {
          pila.splice(i, 1);
          break;
        }
      }
      continue;
    }

    pila.push({ nombre, pone: formatoDeEtiqueta(nombre, pieza) });
  }

  return recortar(tramos);
}

/** Sin espacios sobrantes al principio ni al final, y sin tramos vacíos. */
function recortar(tramos) {
  const limpios = tramos.map((t) => ({ ...t }));
  if (limpios.length > 0) {
    limpios[0].texto = limpios[0].texto.replace(/^\s+/, '');
    const ultimo = limpios[limpios.length - 1];
    ultimo.texto = ultimo.texto.replace(/\s+$/, '');
  }
  return limpios.filter((t) => t.texto !== '');
}

const textoDe = (tramos) => tramos.map((t) => t.texto).join('');

/** Una entrada de la bibliografía, con la etiqueta aparte si la norma la alinea: «[1]». */
function entradaDeHtml(html) {
  const alineada = String(html).match(
    /<div class="csl-left-margin">([\s\S]*?)<\/div>\s*<div class="csl-right-inline">([\s\S]*?)<\/div>/,
  );
  if (alineada) return { etiqueta: comoTramos(alineada[1]), tramos: comoTramos(alineada[2]) };
  return { etiqueta: null, tramos: comoTramos(html) };
}

// ── Los autores de una cita narrativa ──────────────────────────────────────

/**
 * «Braun y Clarke», sacado de la ficha.
 *
 * Es el respaldo cuando la norma no sabe dar solo los autores: en IEEE, en MLA
 * o en las de notas citeproc devuelve «[NO_PRINTED_FORM]», porque en esas normas
 * la cita no lleva nombres. Pero una frase como «Braun y Clarke [1] proponen»
 * los necesita igual.
 */
function autoresDeLaFicha(autores, idioma) {
  const conjuncion = String(idioma).startsWith('en') ? 'and' : 'y';
  const personas = String(autores ?? '')
    .split(/\s*;\s*/)
    .map((persona) => persona.split(',')[0].trim())
    .filter(Boolean);

  if (personas.length === 0) return 'Anónimo';
  if (personas.length === 1) return personas[0];
  if (personas.length === 2) return `${personas[0]} ${conjuncion} ${personas[1]}`;
  return `${personas[0]} et al.`;
}

/**
 * Los autores de una cita narrativa, como los escribe la norma.
 *
 * En APA el «&» es solo para dentro del paréntesis: en la frase va la palabra.
 * citeproc no distingue los dos casos, así que se cambia aquí.
 */
function autoresNarrativos(motor, clave, fuente, idioma, familia) {
  if (familia === 'autor-fecha') {
    try {
      const vista = motor.previewCitationCluster(
        { citationID: `vista-${clave}`, citationItems: [{ id: clave, 'author-only': true }], properties: { noteIndex: 0 } },
        [],
        [],
        'text',
      );
      const limpio = String(vista ?? '').trim();
      if (limpio !== '' && !limpio.includes(SIN_FORMA)) {
        return limpio.replace(/\s&\s/g, String(idioma).startsWith('en') ? ' and ' : ' y ');
      }
    } catch {
      // Se cae a los nombres de la ficha.
    }
  }
  return autoresDeLaFicha(fuente.authors, idioma);
}

// ── El documento ───────────────────────────────────────────────────────────

/** La URI que no se confunde con ningún ítem de nadie, para lo que no está en su Zotero. */
const uriDeAcosta = (fuente) => [`https://acostaresearch.com/fuentes/${fuente.ref}`];

/**
 * Aplica la norma a todos los capítulos, en orden.
 *
 * Todos de una vez y en orden porque la numeración de las normas numéricas y el
 * «ibid.» o la forma abreviada de las de notas dependen de lo que se citó ANTES
 * en toda la tesis, no en el capítulo.
 *
 * Devuelve los textos con un hueco (`hueco(n)`) donde iba cada cita, y aparte
 * lo que va en cada hueco. Así el Word decide cómo ponerla —en el texto o en una
 * nota al pie, con o sin campo de Zotero— sin tener que volver a interpretar
 * las marcas.
 */
function renderizar({ norma: idNorma, idioma: idIdioma, capitulos, porClave, urisDe = uriDeAcosta }) {
  const norma = normas.normaDe(idNorma);
  const idioma = normas.idiomaDe(idIdioma).id;
  const esNota = norma.familia === 'notas';

  const sys = {
    retrieveLocale: (lang) => normas.leerIdioma(lang),
    retrieveItem: (id) => {
      const fuente = porClave.get(id);
      return fuente ? comoCsl(fuente) : undefined;
    },
  };

  const motor = new CSL.Engine(sys, normas.leerEstilo(norma.id), idioma, true);
  motor.setOutputFormat('html');

  const citas = new Map();
  const html = new Map();
  const previas = [];
  const usadas = new Map();
  const perdidas = new Set();
  let numero = 0;
  let nota = 0;

  const textos = capitulos.map((capitulo) => {
    const texto = String(capitulo.texto ?? '');
    let resultado = '';
    let desde = 0;

    for (const grupo of gruposDeMarcas(texto)) {
      resultado += texto.slice(desde, grupo.inicio);
      desde = grupo.fin;

      const conocidas = grupo.items.filter((item) => porClave.has(item.clave));
      for (const item of grupo.items) if (!porClave.has(item.clave)) perdidas.add(item.clave);

      if (conocidas.length === 0) {
        resultado += CITA_PERDIDA;
        continue;
      }

      for (const item of conocidas) usadas.set(item.clave, porClave.get(item.clave));

      numero += 1;
      if (esNota) nota += 1;

      // Narrativa solo con una fuente: «Braun y Clarke; Warshaw y Davis (2006;
      // 1985) proponen» no lo escribe nadie.
      const narrativa = conocidas.length === 1 && conocidas[0].narrativa;

      const citationItems = conocidas.map((item) => ({
        id: item.clave,
        ...(item.localizador ? { locator: item.localizador, label: 'page' } : {}),
        ...(narrativa && norma.familia === 'autor-fecha' ? { 'suppress-author': true } : {}),
      }));

      const cita = {
        citationID: `c${numero}`,
        citationItems,
        properties: { noteIndex: esNota ? nota : 0 },
      };

      const [, cambios] = motor.processCitationCluster(cita, [...previas], []);
      // Una cita nueva puede cambiar las anteriores —«ibid.», desambiguar dos
      // autores con el mismo apellido—, así que se guarda lo último de cada una.
      for (const [, salida, id] of cambios) html.set(id, salida);
      previas.push([cita.citationID, cita.properties.noteIndex]);

      const antes = narrativa
        ? [{ texto: `${autoresNarrativos(motor, conocidas[0].clave, porClave.get(conocidas[0].clave), idioma, norma.familia)} `, cursiva: false, negrita: false, superindice: false, subindice: false, versalitas: false }]
        : [];

      citas.set(numero, {
        id: cita.citationID,
        antes,
        nota: esNota ? nota : null,
        items: citationItems,
      });

      resultado += hueco(numero) + (grupo.items.length > conocidas.length ? ` ${CITA_PERDIDA}` : '');
    }

    return resultado + texto.slice(desde);
  });

  for (const cita of citas.values()) {
    cita.tramos = comoTramos(html.get(cita.id) ?? '');
    cita.texto = textoDe(cita.tramos);
    cita.codigo = codigoDeCita(cita, porClave, urisDe);
  }

  let bibliografia = null;
  if (usadas.size > 0) {
    const producida = motor.makeBibliography();
    if (producida) {
      const [meta, entradas] = producida;
      bibliografia = {
        titulo: esNota ? 'Bibliografía' : 'Referencias',
        sangriaFrancesa: Boolean(meta.hangingindent),
        etiquetaAlineada: Boolean(meta['second-field-align']),
        entradas: entradas.map(entradaDeHtml),
        codigo: CODIGO_BIBLIOGRAFIA,
      };
    }
  }

  return { norma, idioma, textos, citas, bibliografia, usadas, perdidas: [...perdidas] };
}

/**
 * Las marcas del texto, agrupadas.
 *
 * Dos marcas separadas solo por espacios, comas o punto y coma son una sola
 * cita con dos fuentes: «[AR…][AR…]» tiene que salir «(Braun y Clarke, 2006;
 * Warshaw y Davis, 1985)» y no dos paréntesis seguidos.
 */
function gruposDeMarcas(texto) {
  const grupos = [];
  let actual = null;

  for (const marca of texto.matchAll(MARCA)) {
    const inicio = marca.index;
    const fin = inicio + marca[0].length;
    const item = { clave: marca[1], ...modificadoresDe(marca[2]) };

    if (actual && /^[\s;,]*$/.test(texto.slice(actual.fin, inicio))) {
      actual.items.push(item);
      actual.fin = fin;
    } else {
      actual = { inicio, fin, items: [item] };
      grupos.push(actual);
    }
  }

  return grupos;
}

/**
 * El código de campo de Zotero de una cita.
 *
 * `plainCitation` es exactamente el texto que se ve: Zotero lo compara con el
 * del documento para saber si alguien lo editó a mano, y si no coincide avisa
 * al pulsar «Refresh».
 */
function codigoDeCita(cita, porClave, urisDe) {
  const datos = {
    citationID: cita.id,
    properties: {
      formattedCitation: cita.texto,
      plainCitation: cita.texto,
      noteIndex: cita.nota ?? 0,
    },
    citationItems: cita.items.map((item) => {
      const fuente = porClave.get(item.id);
      return {
        id: item.id,
        uris: urisDe(fuente),
        itemData: comoCsl(fuente),
        ...(item.locator ? { locator: item.locator, label: item.label } : {}),
        ...(item['suppress-author'] ? { 'suppress-author': true } : {}),
      };
    }),
    schema: ESQUEMA,
  };

  return ` ADDIN ZOTERO_ITEM CSL_CITATION ${JSON.stringify(datos)} `;
}

module.exports = {
  renderizar,
  comoCsl,
  comoTramos,
  tipoCsl,
  personasCsl,
  gruposDeMarcas,
  CITA_PERDIDA,
  CODIGO_BIBLIOGRAFIA,
};
