'use strict';

const { z } = require('zod');

/**
 * A qué producto le sirve un video o una guía en PDF.
 *
 * Cada uno puede estar en VARIOS (el de conectar Claude vale para todos; el del
 * marco teórico, para tesis y para suficiencia). En la base va como texto con
 * comas —son seis palabras cortas y nadie consulta por ellas en SQL— y fuera
 * siempre como lista. La conversión vive aquí y en un solo sitio.
 *
 * VACÍO = PARA TODOS. Así lo que ya estaba publicado antes de separar por
 * producto sigue saliendo en todas partes sin tocar nada.
 *
 * La misma lista, con sus nombres, está en la web:
 * `src/app/shared/contenido/productos-de-ayuda.ts`. Si se añade uno, en los dos.
 */
const PRODUCTOS_DE_AYUDA = ['tesis', 'articulo', 'revision', 'tsp', 'informe', 'humanizador', 'edicion'];

/** De la base a la lista: «tesis,tsp» → ['tesis', 'tsp']. Lo que no se conoce, fuera. */
const aLista = (texto) =>
  String(texto ?? '')
    .split(',')
    .map((codigo) => codigo.trim())
    .filter((codigo) => PRODUCTOS_DE_AYUDA.includes(codigo));

/** De la lista a la base, sin repetidos y en el orden de la lista de arriba. */
const aTexto = (lista) => PRODUCTOS_DE_AYUDA.filter((codigo) => lista.includes(codigo)).join(',');

/**
 * Lo que llega del panel: una lista en el JSON, o texto con comas cuando la
 * ficha viaja en la query (al subir el PDF de una guía). Sale ya como texto
 * para la columna.
 */
const productosSchema = z
  .preprocess(
    (valor) => (typeof valor === 'string' ? valor.split(',').map((v) => v.trim()).filter(Boolean) : valor),
    z.array(z.enum(PRODUCTOS_DE_AYUDA, { message: 'Ese producto no existe.' })).max(PRODUCTOS_DE_AYUDA.length),
  )
  .transform(aTexto);

/**
 * De un acceso al conector, a qué productos de ayuda da derecho.
 *
 * Por prefijo del código, igual que `productos/producto.perfil` y que la página
 * de planes: `ARTICULO…REVIEW` es el de revisión, y lo que no se reconoce es el
 * método de tesis. Todos los métodos traen el Humanizador académico, así que
 * quien compró cualquiera ve también sus videos; quien compró SOLO el
 * Humanizador no ve los de ninguna ruta.
 */
function deAcceso(productCode) {
  const codigo = String(productCode ?? '').trim().toUpperCase();
  if (codigo.startsWith('HUMANIZ')) return ['humanizador'];

  let ruta = 'tesis';
  if (codigo.startsWith('ARTICULO')) ruta = codigo.includes('REVIEW') ? 'revision' : 'articulo';
  else if (codigo.startsWith('INFORME')) ruta = 'informe';
  else if (codigo.startsWith('TSP')) ruta = 'tsp';
  return [ruta, 'humanizador'];
}

/**
 * Todo lo que alguien compró, como productos de ayuda sin repetir.
 *
 * `accesos` son los códigos de sus licencias; `palabras`, si tiene alguna bolsa
 * de palabras de pago (la de prueba no cuenta: la recibe todo el que se
 * registra); `documentos`, si tiene membresía de Edición y Traducción.
 */
function deLoComprado({ accesos = [], palabras = false, documentos = false }) {
  const suyos = new Set(accesos.flatMap(deAcceso));
  if (palabras) suyos.add('humanizador');
  if (documentos) suyos.add('edicion');
  return PRODUCTOS_DE_AYUDA.filter((codigo) => suyos.has(codigo));
}

module.exports = { PRODUCTOS_DE_AYUDA, aLista, aTexto, productosSchema, deAcceso, deLoComprado };
