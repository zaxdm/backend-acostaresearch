'use strict';

/**
 * Lo que se puede elegir en la ficha del asesor.
 *
 * LAS ÁREAS SON TRES, NO TODAS
 * ----------------------------
 * Son las del piloto, no las carreras del Perú entero. Un catálogo con treinta
 * áreas y dos asesores dentro no parece completo, parece abandonado; y prometer
 * revisión en un campo donde no hay quien revise es prometer lo que no se
 * cumple. Abrir una más es añadir una línea aquí.
 *
 * LOS CÓDIGOS SE GUARDAN SEPARADOS POR COMA
 * -----------------------------------------
 * Como `Plan.soloPara`. Son listas cortas, cerradas y que solo se leen enteras;
 * una tabla aparte para guardar «EDUCACION, SALUD» sería más tabla que dato.
 */

/** Las áreas del piloto. La clave se guarda; el valor es lo que se lee. */
const AREAS = Object.freeze({
  EDUCACION: 'Educación',
  SALUD: 'Salud',
  ADMINISTRACION: 'Administración y negocios',
});

/** Qué enfoque sabe revisar. Decide qué pedidos se le pueden asignar. */
const METODOS = Object.freeze({
  CUANTITATIVO: 'Cuantitativo',
  CUALITATIVO: 'Cualitativo',
  MIXTO: 'Mixto',
});

/**
 * El grado más alto. No es un adorno del perfil: es lo que decide qué puede
 * revisar, porque un bachiller no observa la metodología de una tesis de
 * maestría. Por eso se pide dónde y cuándo lo obtuvo, que es lo que hace falta
 * para buscarlo en el Registro Nacional de Grados y Títulos.
 */
const GRADOS = Object.freeze({
  BACHILLER: 'Bachiller',
  MAGISTER: 'Magíster',
  DOCTOR: 'Doctor',
});

/** Cómo es cada documento. Igual que en el Libro de Reclamaciones. */
const DOCUMENTOS = Object.freeze({
  DNI: { etiqueta: 'DNI', patron: /^\d{8}$/, mensaje: 'El DNI tiene 8 dígitos.' },
  CE: {
    etiqueta: 'Carné de extranjería',
    patron: /^[A-Z0-9]{8,12}$/,
    mensaje: 'El carné de extranjería tiene entre 8 y 12 caracteres.',
  },
  PASAPORTE: {
    etiqueta: 'Pasaporte',
    patron: /^[A-Z0-9]{6,15}$/,
    mensaje: 'El pasaporte tiene entre 6 y 15 letras o números.',
  },
});

/** Los códigos de una lista guardada, sin repetir y sin los que ya no existen. */
function codigosDe(texto, catalogo) {
  const validos = new Set(Object.keys(catalogo));
  const codigos = String(texto ?? '')
    .split(/[\s,;]+/)
    .map((codigo) => codigo.trim().toUpperCase())
    .filter((codigo) => validos.has(codigo));
  return [...new Set(codigos)];
}

/** Cómo se guarda una lista: «EDUCACION, SALUD». Vacía = cadena vacía. */
function guardarLista(codigos, catalogo) {
  return codigosDe(Array.isArray(codigos) ? codigos.join(',') : codigos, catalogo).join(', ');
}

/** La lista como se lee: ['Educación', 'Salud']. */
function nombresDe(texto, catalogo) {
  return codigosDe(texto, catalogo).map((codigo) => catalogo[codigo]);
}

/**
 * El catálogo que necesita el formulario para pintarse.
 *
 * Viaja con la convocatoria y no escrito en la web: así añadir un área es
 * tocar este archivo y no dos repositorios.
 */
function catalogos() {
  const lista = (catalogo) =>
    Object.entries(catalogo).map(([codigo, nombre]) => ({ codigo, nombre }));

  return {
    areas: lista(AREAS),
    metodos: lista(METODOS),
    grados: lista(GRADOS),
    documentos: Object.entries(DOCUMENTOS).map(([codigo, { etiqueta }]) => ({
      codigo,
      nombre: etiqueta,
    })),
  };
}

module.exports = { AREAS, METODOS, GRADOS, DOCUMENTOS, codigosDe, guardarLista, nombresDe, catalogos };
