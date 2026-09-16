'use strict';

/**
 * La ficha de un informe: lo que sale en su portada y lo que manda en su
 * calendario.
 *
 * DOS ÁMBITOS EN LA MISMA RUTA
 * ----------------------------
 * Desde el 16 de septiembre de 2026 la ruta del informe sirve para un curso y
 * para una empresa. Una ficha sin `ambito` es de curso: así son todas las que
 * ya existían, y las skills del ámbito curso NO mandan `ambito` para que el
 * servidor de antes siguiera aceptándolas. Las de empresa mandan
 * `ambito: 'empresa'` y sus propios campos (empresa, destinatario, alcance…).
 * Un ámbito no usa los campos del otro, pero no se rechazan: la ficha se
 * completa por partes y rechazar un campo haría perder los demás.
 *
 * Una tesis tiene carrera, universidad y asesor, y eso ya son columnas del
 * proyecto. Un informe de curso tiene además curso, docente, integrantes,
 * ciclo y sección, fecha de entrega y la rúbrica con la que se califica. En vez
 * de seis columnas que tesis y artículo nunca usarían, va todo en una sola
 * columna JSON, `Project.fichaInforme`, y solo la escribe el producto de
 * informes (ver `productos/producto.perfil`).
 */

const { z } = require('zod');

const AMBITOS = ['curso', 'empresa'];

const TIPOS_DE_CURSO = ['curso', 'proyecto', 'caso'];
const TIPOS_DE_EMPRESA = [
  'diagnostico',
  'gestion',
  'factibilidad',
  'mercado',
  'tecnico',
  'auditoria',
  'avance',
  'incidente',
  'sostenibilidad',
  'duediligence',
  'desempeno',
  'clima',
  'otro',
];
const TIPOS = [...TIPOS_DE_CURSO, ...TIPOS_DE_EMPRESA];

const NOMBRE_DE_TIPO = {
  curso: 'informe académico de curso',
  proyecto: 'informe de proyecto',
  caso: 'análisis de caso',
  diagnostico: 'diagnóstico',
  gestion: 'informe de gestión',
  factibilidad: 'estudio de factibilidad',
  mercado: 'estudio de mercado',
  tecnico: 'informe técnico',
  auditoria: 'informe de auditoría interna',
  avance: 'informe de avance de proyecto',
  incidente: 'informe de incidente',
  sostenibilidad: 'informe de sostenibilidad',
  duediligence: 'due diligence comercial',
  desempeno: 'evaluación de desempeño',
  clima: 'estudio de clima laboral',
  otro: 'informe',
};

/** ¿Es de empresa? Sin ámbito guardado, no: las fichas de antes son de curso. */
const esDeEmpresa = (ficha) => Boolean(ficha && ficha.ambito === 'empresa');

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

    // ── Ámbito empresa ──
    ambito: z.enum(AMBITOS, { message: `El ámbito tiene que ser uno de estos: ${AMBITOS.join(', ')}.` }),
    /** La empresa que se analiza, o la del proyecto. */
    empresa: texto(160, 'La empresa admite hasta 160 caracteres.'),
    sector: texto(160, 'El sector admite hasta 160 caracteres.'),
    /** A quién va el informe: «Gerencia General», «el directorio», «Banco X». */
    destinatario: texto(160, 'El destinatario admite hasta 160 caracteres.'),
    /** Quién lo firma: la consultora, el área o la persona. */
    preparadoPor: texto(160, 'Quien lo firma admite hasta 160 caracteres.'),
    cargo: texto(120, 'El cargo admite hasta 120 caracteres.'),
    /** Lo que cubre el informe: «enero a marzo de 2026». */
    periodo: texto(120, 'El periodo admite hasta 120 caracteres.'),
    /** Si la portada lleva la marca de documento confidencial. */
    confidencial: z.boolean(),
    /** La decisión que apoya el informe, en una frase. */
    decision: texto(300, 'La decisión admite hasta 300 caracteres.'),
    /** Qué entra, qué no entra y las limitaciones. */
    alcance: texto(1500, 'El alcance no puede pasar de 1500 caracteres.'),
    /** Resumen de los términos de referencia: lo que pidió el cliente. */
    terminos: texto(1500, 'El resumen de los términos no puede pasar de 1500 caracteres.'),
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
  if (esDeEmpresa(ficha)) return lineasDeEmpresa(ficha, { ahora, conRubrica });
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

/**
 * Las líneas de una ficha de empresa.
 *
 * La primera es SIEMPRE «Ámbito: empresa»: las skills de la ruta deciden el
 * ámbito leyendo esa línea, y sin ella tratarían el informe como uno de curso.
 * No se pide el docente, que un informe de empresa no tiene.
 *
 * `conRubrica` hace aquí lo mismo que en curso: lo que manda en la revisión
 * (la decisión, el alcance y los términos) solo viaja con el método.
 */
function lineasDeEmpresa(ficha, { ahora, conRubrica }) {
  const lineas = ['Ámbito: empresa'];

  if (ficha.tipo) lineas.push(`Tipo: ${NOMBRE_DE_TIPO[ficha.tipo] ?? ficha.tipo}`);

  const empresa = [ficha.empresa && `Empresa: ${ficha.empresa}`, ficha.sector && `Sector: ${ficha.sector}`]
    .filter(Boolean)
    .join(' · ');
  if (empresa) lineas.push(empresa);

  if (ficha.destinatario) lineas.push(`Para: ${ficha.destinatario}`);
  const firma = [ficha.preparadoPor, ficha.cargo].filter(Boolean).join(', ');
  if (firma) lineas.push(`Lo firma: ${firma}`);
  if (ficha.periodo) lineas.push(`Periodo: ${ficha.periodo}`);
  if (ficha.confidencial === true) lineas.push('Confidencial: la portada lleva la marca de documento confidencial.');

  if (ficha.fechaEntrega) lineas.push(lineaDeEntrega(ficha.fechaEntrega, ahora));

  if (conRubrica) {
    if (ficha.decision) lineas.push(`Decisión que apoya el informe: ${ficha.decision}`);
    if (ficha.alcance) lineas.push(`Alcance: ${ficha.alcance}`);
    if (ficha.terminos) lineas.push(`Términos de referencia: ${ficha.terminos}`);
  }

  return lineas;
}

module.exports = {
  fichaInformeSchema,
  fusionarFicha,
  lineasDeFicha,
  diasHasta,
  esDeEmpresa,
  AMBITOS,
  TIPOS,
  TIPOS_DE_CURSO,
  TIPOS_DE_EMPRESA,
  NOMBRE_DE_TIPO,
};
