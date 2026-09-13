'use strict';

const projectRepository = require('../projects/project.repository');
const almacen = require('../projects/project.storage');
const citas = require('../projects/project.citas');

/**
 * Las claves de sus fuentes que ya están citadas en algún capítulo guardado.
 *
 * POR QUÉ EXISTE
 * --------------
 * La clave con la que se cita —AR + ocho caracteres— la calcula MySQL a partir
 * del `id` de la fila, que es aleatorio. Así que borrar una fuente y volver a
 * traerla NO recupera su clave: sale otra, y la cita del capítulo se queda
 * apuntando a una fila que ya no existe. En el Word aparece como «CITA SIN
 * LOCALIZAR», a la vista del asesor.
 *
 * El 13 de septiembre de 2026 una tesis de prueba tenía 19 así en un solo
 * capítulo. Las dos vías que borran fuentes de un tesista —«Borrar todas» y la
 * limpieza de lo que sacó de su colección de Zotero— preguntan aquí antes, y
 * lo que está citado se queda. Si luego vuelve a subirla, el `upsert` encuentra
 * esa misma fila y la cita sigue valiendo.
 *
 * Se leen TODOS sus proyectos, no uno: la biblioteca es de la persona y la
 * comparten su tesis y su artículo.
 */
async function clavesCitadas(userId) {
  const proyectos = await projectRepository.listarDeUsuario(userId);
  const claves = new Set();

  for (const proyecto of proyectos) {
    for (const etapa of proyecto.stages ?? []) {
      // Sin palabras no hay archivo: no se gasta una lectura de disco en nada.
      if (!((etapa.palabras ?? 0) > 0)) continue;

      const texto = await almacen.leer(proyecto.id, etapa.skillCode);
      if (texto) for (const clave of citas.clavesDe(texto)) claves.add(clave);
    }
  }

  return [...claves].sort();
}

module.exports = { clavesCitadas };
