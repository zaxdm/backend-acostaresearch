'use strict';

/**
 * Las citas, en el idioma de la traducción.
 *
 * QUÉ SE TRADUCE Y QUÉ NO
 * -----------------------
 * De una cita solo cambian las palabras del estilo: el conector entre autores
 * («&», «y», «and», «e»), «n.d.» / «s.f.», «in press» / «en prensa», «cited
 * in» / «citado en», «e.g.» / «p. ej.». Los apellidos, los años, las páginas y
 * «et al.» —que APA deja en latín en los cuatro idiomas— no se tocan nunca.
 *
 * Se pidió el 24-sep-2026: un artículo en inglés traducido al español salía
 * con «(Ballesteros & Acosta Enriquez, 2024)» en medio del texto en español.
 *
 * POR QUÉ CON REGLAS Y NO CON EL MODELO
 * -------------------------------------
 * Porque una cita que el modelo «traduce» es una cita que puede volver con otro
 * apellido, otro año o dos autores juntados, y eso no se ve hasta que el jurado
 * la busca en la bibliografía. Con reglas solo cambia lo que está en esta
 * lista, y siempre igual.
 *
 * LAS CITAS DE ZOTERO
 * -------------------
 * Se cambia el texto que se VE del campo, y el campo sigue siendo de Zotero con
 * su JSON. Ojo: si el tesista pulsa «Refresh» en Zotero, Zotero reescribe ese
 * texto con el idioma que tenga puesto en las preferencias del documento. Para
 * que se quede en español, ahí hay que elegir el idioma de destino.
 */

/**
 * Lo que dice cada idioma. `yParentesis` es el conector dentro de una cita
 * entre paréntesis y `yNarrativa` el de una cita en el texto: en inglés APA usa
 * «&» en la primera y «and» en la segunda; los demás, la misma palabra.
 */
const ESTILO = {
  es: { yParentesis: 'y', yNarrativa: 'y', sinFecha: 's.f.', enPrensa: 'en prensa', citadoEn: 'citado en', porEjemplo: 'p. ej.', vease: 'véase' },
  en: { yParentesis: '&', yNarrativa: 'and', sinFecha: 'n.d.', enPrensa: 'in press', citadoEn: 'cited in', porEjemplo: 'e.g.', vease: 'see' },
  pt: { yParentesis: 'e', yNarrativa: 'e', sinFecha: 's.d.', enPrensa: 'no prelo', citadoEn: 'citado em', porEjemplo: 'p. ex.', vease: 'ver' },
};

/** Las formas de cada cosa en los idiomas que conocemos, para reconocerlas. */
const CONECTOR = '&|y|and|e';
const SIN_FECHA = /\b(?:n\.\s?d\.|s\.\s?f\.|s\.\s?d\.)/gi;
const EN_PRENSA = /\b(?:in press|en prensa|no prelo)\b/gi;
const CITADO_EN = /\b(?:as cited in|cited in|citado en|citado em|como se cita en)\b/gi;
const POR_EJEMPLO = /\b(?:e\.\s?g\.|p\.\s?ej\.|p\.\s?ex\.)/gi;
const VEASE = /(?<=^\(|;\s)(?:see|véase|ver)\b/gi;

/** Un conector entre dos apellidos: «Xiong & Zhang», «Pérez y Gómez». */
const ENTRE_APELLIDOS = new RegExp(`(?<=\\p{L}[\\p{L}'’.-]*\\s)(?:${CONECTOR})(?=\\s+\\p{Lu})`, 'gu');

/**
 * El texto de una cita con las palabras del estilo en `idioma`.
 *
 * Sin cambios si el idioma no está en la lista (el chino: sus revistas usan
 * cada una su convención, y no se adivina).
 */
function localizar(texto, idioma) {
  const estilo = ESTILO[idioma];
  if (!estilo) return texto;

  const entreParentesis = /^\s*\(/.test(texto);
  return String(texto)
    .replace(ENTRE_APELLIDOS, entreParentesis ? estilo.yParentesis : estilo.yNarrativa)
    .replace(SIN_FECHA, estilo.sinFecha)
    .replace(EN_PRENSA, estilo.enPrensa)
    .replace(CITADO_EN, estilo.citadoEn)
    .replace(POR_EJEMPLO, estilo.porEjemplo)
    .replace(VEASE, estilo.vease);
}

/**
 * El XML de un campo de cita con el texto que se ve ya localizado.
 *
 * Solo lo que va detrás de `separate` —antes está la instrucción con el JSON,
 * que no se toca— y solo en campos de cita (Zotero, Mendeley, EndNote): un
 * hipervínculo o una referencia cruzada se devuelven como estaban.
 */
function localizarCampo(xml, idioma, { escapar, desescapar }) {
  if (!ESTILO[idioma] || !/ADDIN|CITATION/i.test(xml)) return xml;

  const corte = xml.indexOf('w:fldCharType="separate"');
  const desde = corte === -1 ? 0 : corte;
  const cabeza = xml.slice(0, desde);
  const cola = xml.slice(desde);

  // El texto puede venir en varias corridas; se localiza por corrida, que es
  // como lo escribe Zotero (una sola, casi siempre).
  const hecha = cola.replace(/(<w:t(?:\s[^>]*)?>)([\s\S]*?)(<\/w:t>)/g, (_, abre, contenido, cierra) =>
    `${abre}${escapar(localizar(desescapar(contenido), idioma))}${cierra}`,
  );
  return cabeza + hecha;
}

/**
 * Un trozo de cita como expresión que admite cualquiera de sus formas: el
 * modelo, al traducir, puede cambiar «&» por «y» o «n.d.» por «s.f.», y eso
 * no la convierte en otra cita. Lo usa `preparar.campos` para reconocerla.
 */
function formasDe(trozo) {
  if (/^(?:&|y|and|e)$/i.test(trozo)) return `(?:${CONECTOR})`;
  // «n.d.», «s.f.», «s.d.», con la coma o el paréntesis que lleven pegados.
  const sinFecha = /^(n\.d\.|s\.f\.|s\.d\.)(.*)$/i.exec(trozo);
  if (sinFecha) return `(?:n\\.d\\.|s\\.f\\.|s\\.d\\.)${sinFecha[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`;
  return trozo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { localizar, localizarCampo, formasDe, ESTILO };
