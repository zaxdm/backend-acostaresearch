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

/** La marca que escribe el asistente. Ocho caracteres tras «AR». */
const MARCA = /\[(AR[0-9A-F]{8})\]/g;

/**
 * Los apellidos, en el formato que pide APA para la cita en el texto.
 *
 * Los autores llegan como «Apellido, N.; Apellido, N.» —así los guarda el
 * corpus— y APA quiere solo el primer apellido con «et al.» a partir de tres.
 */
function autoresParaCita(autores) {
  if (!autores) return null;

  const personas = String(autores)
    .split(/\s*;\s*/)
    .map((persona) => persona.split(',')[0].trim())
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

/** La entrada completa de la lista de referencias, en APA. */
function entradaDeBibliografia(fuente) {
  const partes = [];
  partes.push(fuente.authors || '(Autor no consignado)');
  partes.push(`(${fuente.year ?? 's. f.'}).`);
  partes.push(`${fuente.title}.`);

  const publicacion = datosDeLaPublicacion(fuente);
  if (publicacion) partes.push(publicacion);

  if (fuente.doi) partes.push(`https://doi.org/${fuente.doi}`);
  else if (fuente.url) partes.push(fuente.url);
  return partes.join(' ');
}

/** Las claves que aparecen en un texto, sin repetir. */
function clavesDe(texto) {
  const encontradas = new Set();
  for (const [, clave] of texto.matchAll(MARCA)) encontradas.add(clave);
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
  const usadas = new Map();
  const perdidas = new Set();

  const resuelto = texto.replace(MARCA, (original, clave) => {
    const fuente = porClave.get(clave);
    if (!fuente) {
      perdidas.add(clave);
      return '[CITA SIN LOCALIZAR: revísala]';
    }
    usadas.set(clave, fuente);
    return citaEnElTexto(fuente);
  });

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

module.exports = {
  MARCA,
  clavesDe,
  resolver,
  bibliografia,
  citaEnElTexto,
  entradaDeBibliografia,
  datosDeLaPublicacion,
  autoresParaCita,
};
