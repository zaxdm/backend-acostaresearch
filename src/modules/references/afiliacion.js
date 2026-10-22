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

module.exports = { pareceAfiliacion };
