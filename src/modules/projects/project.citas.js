'use strict';

/**
 * Las citas del Word.
 *
 * El asistente escribe [AR97D22F86] donde va la cita, y aquí se cambia por
 * «(Venero Gibaja et al., 2024)» y se apunta la fuente para la lista final.
 *
 * POR QUÉ ASÍ Y NO PEGANDO LA FICHA
 * ---------------------------------
 * Antes el asistente recibía la ficha en APA ya montada y la copiaba al texto.
 * Eso funciona hasta que hay que rehacer la bibliografía: del texto no queda
 * rastro de QUÉ fuente se citó, solo de cómo quedó escrita, y una cita mal
 * copiada es indistinguible de una bien copiada. Con la clave, la cita del texto
 * y la entrada de Referencias salen del MISMO registro, así que no pueden
 * discrepar por mucho que se reescriba el capítulo.
 *
 * Lo que NO hace: comprobar que la fuente diga lo que el párrafo afirma. Eso es
 * la capa de evidencia, y es otra cosa.
 */

/**
 * La marca que escribe el asistente. Ocho caracteres tras «AR».
 *
 * Detrás de dos puntos puede llevar cómo se cita: «[AR97D22F86:n]» es narrativa
 * —«Braun y Clarke (2006) proponen»— y «[AR97D22F86:p. 45]» lleva la página.
 * El primer grupo sigue siendo la clave, así que quien solo busca claves
 * —la evidencia, la auditoría, el BibTeX— no nota la diferencia.
 */
// Sin distinguir mayúsculas de minúsculas, y la clave se pasa a mayúsculas al
// usarla. Las herramientas siempre la dan en mayúsculas, pero un modelo la
// normaliza de vez en cuando, y en minúsculas esto no casaba: la marca salía
// impresa tal cual en el capítulo Y la fuente no entraba en las referencias,
// sin que nadie se enterara. Es peor que una clave equivocada, que al menos
// deja «[CITA SIN LOCALIZAR]» a la vista y se anota en `perdidas`.
const MARCA = /\[(AR[0-9A-F]{8})(?::([^\]\n]{1,40}))?\]/gi;

const { quitarAfiliaciones } = require('../references/afiliacion');

// Partículas que en un apellido van en minúscula: «de la Cruz», «van Dijk».
const PARTICULAS = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos', 'van', 'von', 'der', 'den', 'di']);

/**
 * «PALOMINO-FLORES» → «Palomino-Flores».
 *
 * Algunas bases (y algunas fichas escritas a mano) dan el apellido entero en
 * mayúsculas, y así salía en la cita y en las referencias. Solo se toca lo que
 * no tiene ninguna minúscula: «McAdams» o «da Silva» se quedan como están.
 */
function apellidoLegible(apellido) {
  const texto = String(apellido ?? '');
  if (!/\p{Lu}.*\p{Lu}/u.test(texto) || /\p{Ll}/u.test(texto)) return texto;
  let primera = true;
  return texto.toLowerCase().replace(/\p{L}+/gu, (palabra) => {
    const cambio = !primera && PARTICULAS.has(palabra) ? palabra : palabra[0].toUpperCase() + palabra.slice(1);
    primera = false;
    return cambio;
  });
}

/**
 * «Ministerio de la Producción (Produce)» → nombre y sigla por separado.
 *
 * Con la sigla entre paréntesis, la cita salía con un paréntesis dentro de otro:
 * «(Ministerio de la Producción (Produce), 2025)». APA pone la sigla entre
 * corchetes en la cita y la quita de las referencias.
 */
function institucionConSigla(autor) {
  const encontrado = /^(.+?)\s*\(([\p{L}\p{N}.&\- ]{2,20})\)\s*$/u.exec(String(autor ?? '').trim());
  return encontrado ? { nombre: encontrado[1].trim(), sigla: encontrado[2].trim() } : null;
}

/** Cómo se nombra un autor en la cita: el apellido, o la institución con su sigla entre corchetes. */
function nombreParaCita(persona) {
  const coma = persona.indexOf(',');
  if (coma >= 0) return apellidoLegible(persona.slice(0, coma).trim());
  const institucion = institucionConSigla(persona);
  return institucion ? `${institucion.nombre} [${institucion.sigla}]` : persona.trim();
}

/** Cómo va un autor en la lista de referencias: apellido legible, institución sin la sigla. */
function nombreParaReferencias(persona) {
  const coma = persona.indexOf(',');
  if (coma >= 0) return `${apellidoLegible(persona.slice(0, coma).trim())}${persona.slice(coma)}`;
  return institucionConSigla(persona)?.nombre ?? persona;
}

/**
 * Qué dicen los dos puntos de una marca.
 *
 * «n» o «narrativa» sueltos, y la página como «p. 45», «pp. 45-46» o «pág. 45».
 * Lo que no se entiende se ignora: una marca con un añadido raro se cita igual,
 * que es mejor que no citarla.
 */
function modificadoresDe(bruto) {
  const texto = String(bruto ?? '').trim();
  if (texto === '') return { narrativa: false, localizador: null };

  return {
    narrativa: /(^|[\s,;])n(arrativa)?(?=$|[\s,;])/i.test(texto),
    localizador: (texto.match(/p{1,2}(?:[áa]gs?)?\.?\s*(\d[\d\u2013-]*)/i) || [])[1] ?? null,
  };
}

/**
 * El hueco que deja una cita en el texto hasta que el Word la pone.
 *
 * Con corchetes que no escribe nadie, para que no se pueda confundir con texto
 * del tesista. Ver `project.csl` y `project.docx`.
 */
const hueco = (n) => `⟦C${n}⟧`;
const HUECO_RE = /⟦C(\d+)⟧/g;

/**
 * Los apellidos, en el formato que pide APA para la cita en el texto.
 *
 * Los autores llegan como «Apellido, N.; Apellido, N.» —así los guarda el
 * corpus— y APA quiere solo el primer apellido con «et al.» a partir de tres.
 */
function autoresParaCita(autores) {
  if (!autores) return null;

  // Sin la universidad que Crossref deposita como autor, igual que en la norma.
  const personas = quitarAfiliaciones(String(autores).split(/\s*;\s*/).map((persona) => persona.trim()))
    .map(nombreParaCita)
    .filter(Boolean);

  if (personas.length === 0) return null;
  if (personas.length === 1) return personas[0];
  if (personas.length === 2) return `${personas[0]} y ${personas[1]}`;
  return `${personas[0]} et al.`;
}

/** «(García et al., 2024)» */
function citaEnElTexto(fuente) {
  const quien = autoresParaCita(fuente.authors) ?? 'Anónimo';
  const cuando = fuente.year ?? 's. f.';
  return `(${quien}, ${cuando})`;
}

/**
 * La cita APA de respaldo, con lo que digan los dos puntos de la marca.
 *
 * Es la que sale cuando la norma del proyecto no se puede aplicar: tiene que
 * entender las mismas marcas, o una narrativa saldría con el nombre repetido.
 */
function citaConModificadores(fuente, bruto) {
  const { narrativa, localizador } = modificadoresDe(bruto);
  const quien = autoresParaCita(fuente.authors) ?? 'Anónimo';
  const cuando = fuente.year ?? 's. f.';
  const pagina = localizador ? `, p. ${localizador}` : '';

  return narrativa ? `${quien} (${cuando}${pagina})` : `(${quien}, ${cuando}${pagina})`;
}

/**
 * Los datos de la publicación: revista, volumen, número y páginas.
 *
 * APA 7 los pide así, y en este orden exacto:
 *
 *   Revista de Educación, 15(2), 45-62.
 *
 * El número va PEGADO al volumen y entre paréntesis, sin espacio, y las páginas
 * detrás de una coma. Es de lo primero que mira un asesor en la lista de
 * referencias, y hasta hoy aquí solo salía el nombre de la revista.
 *
 * Cada pieza puede faltar y la entrada tiene que seguir leyéndose bien: un
 * capítulo de libro no tiene volumen, un artículo electrónico no tiene páginas
 * sino número de artículo, y de lo que se importó antes de que existieran estas
 * columnas no hay ninguno de los tres. Por eso se arma pieza a pieza en vez de
 * con una plantilla con huecos.
 */
function datosDeLaPublicacion(fuente) {
  if (!fuente.source) return null;

  let texto = String(fuente.source).trim().replace(/[.,]\s*$/, '');

  if (fuente.volume) {
    texto += `, ${fuente.volume}`;
    if (fuente.issue) texto += `(${fuente.issue})`;
  }

  if (fuente.pages) texto += `, ${fuente.pages}`;

  return `${texto}.`;
}

/**
 * ¿Es una obra que se sostiene sola, o algo publicado dentro de otra cosa?
 *
 * De eso depende QUÉ va en cursiva, que en APA no es decorativo: la cursiva
 * marca el continente. En un artículo, el continente es la revista; en un
 * libro, el libro mismo. Poner en cursiva el nombre de una editorial es un
 * error tan visible como no poner ninguna.
 *
 * El tipo llega escrito de cuatro maneras según por dónde entró la fuente
 * —Zotero dice `journalArticle`, Scopus «Article», OpenAlex `article`,
 * Crossref `journal-article`— así que se compara en minúsculas y sin guiones.
 * Lo que no se reconoce se trata como artículo, que es lo que son casi todas.
 */
function esObraSuelta(itemType) {
  const tipo = String(itemType ?? '').toLowerCase().replace(/[-_\s]/g, '');
  if (tipo.includes('section') || tipo.includes('chapter')) return false;
  return ['book', 'monograph', 'thesis', 'report', 'dataset', 'software'].some((suelta) =>
    tipo.includes(suelta),
  );
}

/**
 * La entrada partida en trozos, diciendo cuáles van en cursiva.
 *
 * Se devuelve así y no como texto porque el Word necesita saberlo: una cursiva
 * no se puede insinuar dentro de una cadena. `entradaDeBibliografia` los une
 * y da el texto plano, que es lo que hace falta en todo lo demás.
 */
function tramosDeBibliografia(fuente) {
  const tramos = [];
  const suelta = esObraSuelta(fuente.itemType);

  const autores = fuente.authors
    ? quitarAfiliaciones(String(fuente.authors).split(/\s*;\s*/).map((p) => p.trim())).map(nombreParaReferencias).join('; ')
    : '';
  tramos.push({ texto: `${autores || '(Autor no consignado)'} ` });
  tramos.push({ texto: `(${fuente.year ?? 's. f.'}). ` });

  // En una obra suelta, el título ES el continente y va en cursiva.
  tramos.push({ texto: `${fuente.title}`, cursiva: suelta });
  tramos.push({ texto: '. ' });

  if (fuente.source) {
    const contenedor = String(fuente.source).trim().replace(/[.,]\s*$/, '');
    // En un artículo o un capítulo, el continente es la revista o el libro. En
    // una obra suelta esto es la editorial, y una editorial nunca va en cursiva.
    tramos.push({ texto: contenedor, cursiva: !suelta });

    if (!suelta && fuente.volume) {
      // El volumen acompaña a la revista en cursiva; el número, no.
      tramos.push({ texto: ', ' });
      tramos.push({ texto: String(fuente.volume), cursiva: true });
      if (fuente.issue) tramos.push({ texto: `(${fuente.issue})` });
    }

    if (!suelta && fuente.pages) tramos.push({ texto: `, ${fuente.pages}` });

    tramos.push({ texto: '. ' });
  }

  if (fuente.doi) tramos.push({ texto: `https://doi.org/${fuente.doi}` });
  else if (fuente.url) tramos.push({ texto: fuente.url });

  // Sin enlace, la entrada acaba en el punto que se puso arriba.
  const ultimo = tramos[tramos.length - 1];
  if (ultimo.texto === '. ') ultimo.texto = '.';

  return tramos;
}

/** La entrada completa de la lista de referencias, en APA y en texto plano. */
function entradaDeBibliografia(fuente) {
  return tramosDeBibliografia(fuente)
    .map((tramo) => tramo.texto)
    .join('');
}

/** Las claves que aparecen en un texto, sin repetir. */
function clavesDe(texto) {
  const encontradas = new Set();
  for (const [, clave] of texto.matchAll(MARCA)) encontradas.add(clave.toUpperCase());
  return [...encontradas];
}

/**
 * Cambia las marcas por citas de verdad.
 *
 * Una marca que no corresponde a ninguna fuente NO se borra ni se deja tal cual:
 * se deja visible y con una advertencia. Borrarla dejaría una afirmación sin
 * respaldo con aspecto de tenerlo, que es exactamente el error que este módulo
 * existe para evitar; dejarla como estaba haría que el tesista entregara un
 * corchete raro sin entender qué es.
 */
function resolver(texto, porClave) {
  // Aquí y no arriba: `project.csl` ya carga este archivo al arrancar.
  const { terminaCon, terminaConPalabra, inicioDeLosAutores } = require('./project.csl');
  const usadas = new Map();
  const perdidas = new Set();

  let resuelto = '';
  let desde = 0;
  for (const [original, clave, modificadores] of texto.matchAll(MARCA)) {
    const indice = texto.indexOf(original, desde);
    resuelto += texto.slice(desde, indice);
    desde = indice + original.length;

    // La ficha se guarda con la clave en mayúsculas, que es la forma canónica.
    const canonica = clave.toUpperCase();
    const fuente = porClave.get(canonica);
    if (!fuente) {
      perdidas.add(canonica);
      resuelto += '[CITA SIN LOCALIZAR: revísala]';
      continue;
    }
    usadas.set(canonica, fuente);

    // Lo mismo que hace la norma (`project.csl`): si el texto ya escribió los
    // autores antes de la marca, completos o acortados, no se repiten. Sin
    // esto salía «Peñaherrera y Yoza Peñaherrera Chipre y Yoza Rodríguez (2024)».
    const quien = autoresParaCita(fuente.authors) ?? 'Anónimo';
    const { narrativa: marcada, localizador } = modificadoresDe(modificadores);
    const inicio = inicioDeLosAutores(resuelto, quien);
    const narrativa = marcada || terminaConPalabra(resuelto, quien) || inicio >= 0;
    if (!narrativa) {
      resuelto += citaConModificadores(fuente, modificadores);
      continue;
    }

    const cuando = `(${fuente.year ?? 's. f.'}${localizador ? `, p. ${localizador}` : ''})`;
    if (terminaCon(resuelto, quien)) {
      resuelto += cuando;
    } else {
      if (inicio >= 0) resuelto = resuelto.slice(0, inicio);
      resuelto += `${quien} ${cuando}`;
    }
  }
  resuelto += texto.slice(desde);

  return { texto: resuelto, usadas, perdidas: [...perdidas] };
}

/**
 * La lista de referencias, ordenada como la pide APA.
 *
 * Alfabética por autor, y sin repetir: una fuente citada en cuatro capítulos
 * aparece una vez. Se ordena con `localeCompare` en español para que la Ñ y las
 * tildes caigan donde un jurado espera verlas.
 */
function bibliografia(fuentes) {
  return [...fuentes]
    .map(entradaDeBibliografia)
    .sort((a, b) => a.localeCompare(b, 'es', { sensitivity: 'base' }));
}

/**
 * Lo mismo, pero con las cursivas puestas, que es lo que baja al Word.
 *
 * Se ordena por el texto plano y no por los tramos: el orden es el mismo y
 * comparar cadenas es lo que sabe hacer `localeCompare`.
 */
function bibliografiaConCursivas(fuentes) {
  return [...fuentes]
    .map((fuente) => ({ texto: entradaDeBibliografia(fuente), tramos: tramosDeBibliografia(fuente) }))
    .sort((a, b) => a.texto.localeCompare(b.texto, 'es', { sensitivity: 'base' }));
}

module.exports = {
  hueco,
  HUECO_RE,
  modificadoresDe,
  citaConModificadores,
  MARCA,
  clavesDe,
  resolver,
  bibliografia,
  bibliografiaConCursivas,
  tramosDeBibliografia,
  esObraSuelta,
  citaEnElTexto,
  entradaDeBibliografia,
  datosDeLaPublicacion,
  autoresParaCita,
  apellidoLegible,
  institucionConSigla,
  nombreParaCita,
};
