'use strict';

/**
 * La ficha de un informe estudiantil: lo que sale en su portada y lo que manda
 * en su calendario.
 *
 * Una tesis tiene carrera, universidad y asesor, y eso ya son columnas del
 * proyecto. Un informe de curso tiene además curso, docente, integrantes,
 * ciclo y sección, fecha de entrega y la rúbrica con la que se califica. En vez
 * de seis columnas que tesis y artículo nunca usarían, va todo en una sola
 * columna JSON, `Project.fichaInforme`, y solo la escribe el producto de
 * informes (ver `productos/producto.perfil`).
 */

const { z } = require('zod');

const TIPOS = ['curso', 'proyecto', 'caso'];

const NOMBRE_DE_TIPO = {
  curso: 'informe académico de curso',
  proyecto: 'informe de proyecto',
  caso: 'análisis de caso',
};

const texto = (maximo, mensaje) => z.string().trim().max(maximo, mensaje);

/**
 * Lo que puede mandar el asistente. Todo opcional: la ficha se completa por
 * partes, a medida que el estudiante lo va diciendo.
 *
 * Lo que no está declarado se descarta en silencio, como en `project.etapas`:
 * un campo inventado no puede tumbar lo demás.
 */
const fichaInformeSchema = z
  .object({
    tipo: z.enum(TIPOS, { message: `El tipo de informe tiene que ser uno de estos: ${TIPOS.join(', ')}.` }),
    curso: texto(160, 'El curso admite hasta 160 caracteres.'),
    /** Vacío = el curso no tiene docente que poner: queda anotado que ya se preguntó. */
    docente: texto(160, 'El docente admite hasta 160 caracteres.'),
    integrantes: z
      .array(
        z.object({
          nombre: texto(160).min(1, 'Cada integrante necesita su nombre.'),
          codigo: texto(40).optional(),
        }),
      )
      .max(10, 'Hasta 10 integrantes.'),
    cicloSeccion: texto(60, 'El ciclo y la sección admiten hasta 60 caracteres.'),
    ciudad: texto(80),
    fechaEntrega: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha de entrega va como AAAA-MM-DD.'),
    /** Resumen de la rúbrica: los criterios con los que se va a calificar. */
    rubrica: texto(1500, 'El resumen de la rúbrica no puede pasar de 1500 caracteres.'),
  })
  .partial();

/**
 * Lo nuevo sobre lo que había. Lo que no viene no se toca, y los integrantes se
 * sustituyen enteros: una lista a medias con la anterior no significa nada.
 */
function fusionarFicha(anterior, nueva) {
  const base = anterior && typeof anterior === 'object' ? anterior : {};
  const cambios = Object.fromEntries(
    Object.entries(nueva ?? {}).filter(([, valor]) => valor !== undefined && valor !== null),
  );
  return { ...base, ...cambios };
}

/** Días de hoy a la fecha, contados en hora de Lima, que es la del estudiante. */
function diasHasta(fecha, ahora = new Date()) {
  const [anio, mes, dia] = fecha.split('-').map(Number);
  const lima = new Date(ahora.getTime() - 5 * 60 * 60 * 1000);
  const hoy = Date.UTC(lima.getUTCFullYear(), lima.getUTCMonth(), lima.getUTCDate());
  return Math.round((Date.UTC(anio, mes - 1, dia) - hoy) / (24 * 60 * 60 * 1000));
}

function lineaDeEntrega(fecha, ahora) {
  const dias = diasHasta(fecha, ahora);
  if (dias === 0) return `Entrega: ${fecha} (es HOY).`;
  if (dias === 1) return `Entrega: ${fecha} (es mañana).`;
  if (dias > 1) return `Entrega: ${fecha} (faltan ${dias} días).`;
  return `Entrega: ${fecha} (ya pasó hace ${-dias} ${dias === -1 ? 'día' : 'días'}; pregúntale si le dieron más plazo).`;
}

/**
 * Lo que lee el asistente de la ficha, línea a línea.
 *
 * `conRubrica` es para el contexto que viaja con el método: ahí sí hace falta
 * saber con qué se califica. En el panorama de «mi_proyecto» sobra.
 */
function lineasDeFicha(ficha, { ahora = new Date(), conRubrica = false } = {}) {
  if (!ficha || typeof ficha !== 'object') return [];
  const lineas = [];

  if (ficha.tipo) lineas.push(`Tipo: ${NOMBRE_DE_TIPO[ficha.tipo] ?? ficha.tipo}`);

  const curso = [ficha.curso && `Curso: ${ficha.curso}`, ficha.cicloSeccion && `Ciclo y sección: ${ficha.cicloSeccion}`]
    .filter(Boolean)
    .join(' · ');
  if (curso) lineas.push(curso);

  if (ficha.docente) {
    lineas.push(`Docente: ${ficha.docente}`);
  } else if (ficha.docente === undefined) {
    lineas.push(
      'Docente: sin dato. Sale en la portada del Word: pregúntaselo UNA vez y guárdalo con ' +
        '"guardar_avance" (informe.docente). Si no hay docente que poner, guarda docente vacío.',
    );
  }

  if (Array.isArray(ficha.integrantes) && ficha.integrantes.length > 0) {
    const nombres = ficha.integrantes.map((i) => (i.codigo ? `${i.nombre} (${i.codigo})` : i.nombre));
    lineas.push(`Integrantes: ${nombres.join('; ')}`);
  }

  if (ficha.fechaEntrega) lineas.push(lineaDeEntrega(ficha.fechaEntrega, ahora));
  if (conRubrica && ficha.rubrica) lineas.push(`Rúbrica del docente: ${ficha.rubrica}`);

  return lineas;
}

module.exports = { fichaInformeSchema, fusionarFicha, lineasDeFicha, diasHasta, TIPOS, NOMBRE_DE_TIPO };
