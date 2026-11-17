'use strict';

/** Con volumen o número, APA cita el año del número, no el del online first. */
function anioDeCrossref(m) {
  const fechas = [
    m['journal-issue']?.['published-print'],
    m['published-print'],
    m.issued,
    m['published-online'],
  ];
  // Sin asignación a un número, la publicación sigue siendo la de internet.
  if (!m.volume && !m.issue && !m['journal-issue']?.issue) {
    fechas.unshift(m['published-online']);
  }
  for (const fecha of fechas) {
    const crudo = fecha?.['date-parts']?.[0]?.[0];
    const valor = Number(crudo);
    if (crudo !== null && crudo !== undefined && crudo !== '' && Number.isInteger(valor) && valor > 0) {
      return valor;
    }
  }
  return null;
}

/** Se usa con el Crossref que ya se consultó al completar los demás campos. */
function anioAlCompletar(ficha, deCrossref) {
  if (ficha.origin === 'ZOTERO' || ficha.origin === 'MENDELEY') return ficha.year ?? null;
  const tieneNumero = ficha.volume || ficha.issue || deCrossref?.volume || deCrossref?.issue;
  return tieneNumero
    ? deCrossref?.year ?? ficha.year ?? null
    : ficha.year ?? deCrossref?.year ?? null;
}

module.exports = { anioDeCrossref, anioAlCompletar };
