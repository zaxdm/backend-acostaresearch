/**
 * Algunas revistas depositan en Crossref la afiliación del autor como si fuera
 * un autor más («Associate Professor, Department of Accounting…, Bangladesh.»).
 * Eso no es una persona ni una institución autora: es ruido, y al citar sale
 * «Associate Professor et al.».
 *
 * Una institución autora de verdad («Organización Mundial de la Salud») no trae
 * cargo ni lista de lugares separados por comas; por eso se exige una cosa u
 * otra y no solo la palabra «Department» o «University».
 */
const CARGO = /\b(professor|lecturer|researcher|ph\.?d\.? (student|candidate)|catedr[aá]tic[oa]|docente)\b/i;
const LUGAR = /\b(department|departamento|university|universidad|faculty|facultad|institute|instituto|school of)\b/i;

function pareceAfiliacion(texto) {
  const t = String(texto ?? '').trim();
  if (!t) return false;
  if (CARGO.test(t) && t.includes(',')) return true;
  return LUGAR.test(t) && t.split(',').length >= 3;
}

/**
 * Una universidad o facultad sin comas («University Tun Hussein Onn Malaysia»)
 * también es la afiliación cuando va entre personas: ningún artículo lo firman
 * «Ahmad, Zabri y la universidad». Sola sí puede ser la autora (un informe de la
 * Universidad Nacional de Trujillo), y entonces se queda.
 */
const CENTRO = /\b(universit\S*|universidad\S*|department|departamento|faculty|facultad|college|school of)\b/i;

/**
 * «Apellido, N.» es una persona. «University Tun Hussein Onn Malaysia, Malaysia»
 * también trae coma, pero lo de antes de la coma es la universidad, no un apellido.
 */
const esPersona = (persona) => persona.includes(',') && !CENTRO.test(persona.split(',')[0]);

/** Los autores de una ficha («Apellido, N.» o institución), sin las afiliaciones. */
function quitarAfiliaciones(personas) {
  const limpias = personas.filter((persona) => persona && !pareceAfiliacion(persona));
  const hayPersonas = limpias.some(esPersona);
  return hayPersonas ? limpias.filter((persona) => esPersona(persona) || !CENTRO.test(persona)) : limpias;
}

module.exports = { pareceAfiliacion, quitarAfiliaciones };
