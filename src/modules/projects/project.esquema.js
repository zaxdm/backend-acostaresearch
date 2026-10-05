'use strict';

/**
 * Los capítulos del DOCUMENTO, que no son los del método.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * Hasta ahora la estructura del Word era el catálogo de skills: «Capítulo III ·
 * Metodología», «Capítulo IV · Resultados», «Capítulo V · Discusión». Ese
 * catálogo es UNO para toda la plataforma, así que el tesista cuya facultad
 * numera de otra forma descargaba un documento que no cumplía su reglamento y
 * tenía que renumerarlo a mano, capítulo por capítulo, en cada versión.
 *
 * El caso que lo destapó es el de la UNSAAC, que pide un Capítulo III de
 * Hipótesis —que el método no tiene como fase suelta—, corre Metodología al IV
 * y junta Resultados con Discusión en el V. Es decir: no basta con renumerar.
 * Hacen falta tres operaciones distintas: renombrar, reordenar y FUNDIR varias
 * fases en un solo capítulo, más poder añadir un capítulo que el método no
 * tiene.
 *
 * QUÉ ES UN ESQUEMA
 * -----------------
 * La lista ordenada de los capítulos del documento. Cada uno dice de qué fases
 * del método sale su texto:
 *
 *   { titulo: 'Capítulo IV: Metodología',           de: ['metodologia'] }
 *   { titulo: 'Capítulo V: Resultados y discusión', de: ['analisis-datos-rstudio', 'discusion'] }
 *   { titulo: 'Capítulo III: Hipótesis',            clave: 'propio-capitulo-iii-hipotesis' }
 *
 * Un capítulo sin fases es PROPIO del reglamento: se guarda y se lee con su
 * clave, como las secciones aparte del informe, que ya funcionaban así.
 *
 * LO QUE NO SE NOMBRA NO SE PIERDE
 * --------------------------------
 * Una fase con texto que el esquema no mencione sale igual, al final del
 * documento y con su nombre del método. Es la regla más importante de aquí: un
 * esquema incompleto —y el asistente los va a mandar incompletos— no puede
 * hacer desaparecer en silencio un capítulo que alguien escribió. Se avisa, y
 * el texto sale.
 *
 * LAS CLAVES LAS PONE EL SERVIDOR
 * -------------------------------
 * De un capítulo propio, la clave sale de su título y nunca la manda el
 * asistente: una clave inventada por el modelo cambia entre conversaciones y el
 * texto guardado se queda huérfano. Y si luego se renombra el capítulo, se
 * conserva la clave que ya tenía texto (ver `reconciliar`).
 */

const { z } = require('zod');

/** Con qué empieza la clave de un capítulo que no es del método. */
const PREFIJO_PROPIO = 'propio-';

/**
 * Las fases que se trabajan pero no son capítulo de la tesis.
 *
 * El método tiene fases que producen texto sin que ese texto sea una parte del
 * documento: la propuesta de tema que se lleva al asesor, el cuestionario y la
 * bitácora del trabajo de campo. Ninguna tesis empieza con un capítulo
 * «Tema y delimitación», y ninguna lleva «Trabajo de campo» entre la
 * metodología y los resultados.
 *
 * Hasta aquí entraban igual, porque el Word se armaba con TODA fase que
 * tuviera texto guardado: al tesista que cerraba la Fase 1 se le abría la
 * tesis con la tabla de su propuesta, encabezado y índice incluidos. Las
 * skills del informe ya lo dicen en su sitio («esta fase no escribe texto del
 * informe, así que no usa guardar_capitulo»); las de tesis guardan igual, así
 * que la regla se pone aquí, que es donde vale para lo que YA está guardado.
 *
 * Lo guardado no se toca: sigue en el proyecto, se lee con `ver_capitulo`, y
 * cuenta para el repaso de evidencia y para el .bib. Lo único que cambia es
 * que no se imprime como capítulo. Si el reglamento de una facultad SÍ lo pide
 * como capítulo, su esquema lo nombra y entonces sale (ver `capitulosDelDocumento`).
 */
const FICHAS_DEL_ARTICULO = ['articulo', 'revision'].flatMap((ruta) => [
  `${ruta}-fase0-tema-y-orientacion`,
  `${ruta}-fase1-matriz-de-estrategia`,
]);

const FASES_DE_TRABAJO = new Set([
  'tema-y-delimitacion',
  'instrumento-investigacion',
  'recoleccion-datos',
  // La ficha de la experiencia del TSP: empresa, cargo y periodo para las
  // fases siguientes. Es su «tema y delimitación»: no es capítulo de nadie.
  'tsp-fase0-experiencia',
  // La Ficha de Orientación y la Matriz de Estrategia del artículo (empírico y
  // de revisión). Por el conector se guardan para que las fases siguientes las
  // lean con `ver_capitulo`, pero son documentos de trabajo: el manuscrito
  // empieza en la Introducción.
  ...FICHAS_DEL_ARTICULO,
]);

/**
 * Las propuestas que no entran al documento ni aunque el esquema las nombre.
 *
 * Las otras fases de trabajo sí pueden salir si el reglamento las pide —el
 * cuestionario como anexo—; estas son notas para el asesor y nada más.
 */
const NUNCA_EN_EL_DOCUMENTO = new Set([
  'tema-y-delimitacion',
  'tsp-fase0-experiencia',
  ...FICHAS_DEL_ARTICULO,
]);

/**
 * Las secciones que solo lleva el PROYECTO de tesis, no el informe final.
 *
 * Los aspectos administrativos —recursos, presupuesto, financiamiento y
 * cronograma— justifican que el estudio se puede hacer; una vez hecho, casi
 * ningún reglamento los pide. El servidor no sabe si el tesista está en el
 * proyecto o en el informe, así que se mira lo escrito: con resultados,
 * discusión o conclusiones guardados ya es el informe, y la sección deja de
 * imprimirse. Lo guardado no se toca, y si el esquema de su facultad la nombra,
 * sale (el reglamento manda).
 */
const SOLO_DEL_PROYECTO = new Set(['aspectos-administrativos']);

/** Con texto en cualquiera de estas, el documento ya es el informe final. */
const DEL_INFORME_FINAL = Object.freeze([
  'analisis-datos-rstudio',
  'analisis-cualitativo',
  'discusion',
  'conclusiones-abstract',
]);

const yaEsInformeFinal = (conTexto) => DEL_INFORME_FINAL.some((code) => conTexto.has(code));

/**
 * Sin esquema, las secciones del proyecto van justo detrás de la Metodología.
 *
 * El `orden` del catálogo es uno solo para todos los grupos y no deja huecos
 * entre la Metodología y el Instrumento; una fase nueva cae al final, detrás de
 * las Conclusiones. Aquí se coloca donde la pone cualquier guía de proyecto.
 */
function trasLaMetodologia(lista) {
  const delProyecto = lista.filter((c) => SOLO_DEL_PROYECTO.has(c.partes[0]));
  const metodologia = lista.findIndex((c) => c.partes[0] === 'metodologia');
  if (delProyecto.length === 0 || metodologia === -1) return lista;
  const resto = lista.filter((c) => !SOLO_DEL_PROYECTO.has(c.partes[0]));
  const tras = resto.findIndex((c) => c.partes[0] === 'metodologia') + 1;
  return [...resto.slice(0, tras), ...delProyecto, ...resto.slice(tras)];
}

/**
 * Los anexos van DETRÁS de las referencias, siempre.
 *
 * Ningún reglamento pone los anexos antes de la lista de referencias: la
 * bibliografía cierra el cuerpo del trabajo y lo que viene después —el
 * cuestionario, la matriz de consistencia, el consentimiento informado— es
 * material de apoyo. El Word los sacaba en el orden en que estaban en el
 * esquema, así que una facultad que ponía «ANEXOS» como último capítulo
 * terminaba con las referencias detrás de los anexos.
 *
 * Se decide por el título porque es lo único que hay: un anexo es un capítulo
 * más del esquema que manda el asistente, sin marca propia. Un capítulo que
 * EMPIEZA por «Anexo», «Anexos» o «Apéndice» es un anexo; «Anexos» dentro del
 * título («Índice de anexos») no lo es, y por eso se mira solo el principio.
 */
const TITULO_DE_ANEXO = /^(anexos?|apendices?|annexes?|appendix|appendices)\b/;

/** ¿Este capítulo es un anexo, y por tanto va detrás de las referencias? */
function esAnexo(titulo) {
  const limpio = String(titulo ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    // «7 · Anexos» y «Fase 7 — Anexos»: el prefijo con que se nombra una fase
    // en nuestro panel, que el Word ya quita al imprimir el título.
    .replace(/^\s*\d+[a-z]?\s*·\s*/i, '')
    .replace(/^\s*fase\s+\d+[a-z]?\s*[—–-]\s*/i, '')
    .trim()
    .toLowerCase();
  return TITULO_DE_ANEXO.test(limpio);
}

/**
 * Los anexos de una tesis a la que nadie le ha dicho cómo son los suyos.
 *
 * Sin esquema de su facultad, el documento salía con los capítulos del método y
 * nada más: el instrumento y la bitácora del trabajo de campo quedaban fuera
 * (ver `FASES_DE_TRABAJO`) porque como CAPÍTULO no van —«Trabajo de campo»
 * entre la metodología y los resultados no lo lleva ninguna tesis—, y como no
 * había dónde ponerlos, no salían en ninguna parte. Su sitio es este: detrás de
 * las referencias, numerados, que es donde los pide cualquier reglamento.
 *
 * Solo cuando el tesista NO ha dictado la estructura de su facultad. Si la
 * dictó, manda ella: los anexos que nombre y ningún otro.
 */
const ANEXOS_POR_DEFECTO = Object.freeze([
  Object.freeze({ code: 'instrumento-investigacion', titulo: 'Instrumento de recolección de datos' }),
  Object.freeze({ code: 'recoleccion-datos', titulo: 'Bitácora del trabajo de campo' }),
]);

/** Un reglamento con más de esto no es un reglamento, es un error del modelo. */
const MAXIMO_CAPITULOS = 24;
/** Fundir más de cuatro fases en un capítulo no lo pide ningún reglamento. */
const MAXIMO_FASES_POR_CAPITULO = 4;

const esClavePropia = (clave) => String(clave ?? '').startsWith(PREFIJO_PROPIO);

/** «Capítulo III: Hipótesis» → «propio-capitulo-iii-hipotesis». */
function claveDe(titulo) {
  const base = String(titulo ?? '')
    .normalize('NFD')
    // El rango de las tildes, por código: escritos tal cual son invisibles en
    // el editor y cualquiera los borra sin verlos.
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .toLowerCase();
  return `${PREFIJO_PROPIO}${base || 'capitulo'}`;
}

/**
 * Lo que puede mandar el asistente.
 *
 * `de` son claves de fases del método; que existan se comprueba fuera, contra
 * el catálogo de la licencia (ver `normalizar`). La clave de un capítulo propio
 * no se admite aquí: la pone el servidor.
 */
const esquemaSchema = z.object({
  capitulos: z
    .array(
      z.object({
        titulo: z
          .string({ required_error: 'Cada capítulo necesita su título.' })
          .trim()
          .min(1, 'El título de un capítulo no puede ir vacío.')
          .max(120, 'El título de un capítulo admite hasta 120 caracteres.'),
        de: z
          .array(z.string().trim().min(1).max(64))
          .max(
            MAXIMO_FASES_POR_CAPITULO,
            `Un capítulo no puede juntar más de ${MAXIMO_FASES_POR_CAPITULO} fases del método.`,
          )
          .optional(),
      }),
    )
    .min(1, 'El esquema necesita al menos un capítulo.')
    .max(MAXIMO_CAPITULOS, `Un esquema de más de ${MAXIMO_CAPITULOS} capítulos no es un reglamento.`),
});

class EsquemaNoValido extends Error {}

/**
 * El esquema que manda el asistente, comprobado contra el catálogo.
 *
 * Lanza `EsquemaNoValido` con un mensaje que se le puede devolver tal cual: al
 * otro lado hay un modelo que puede corregir y reintentar, y un «datos no
 * válidos» no le dice qué arreglar.
 */
function normalizar(entrada, { catalogo = [], anterior = null, conTexto = new Set() } = {}) {
  const datos = esquemaSchema.safeParse(entrada ?? {});
  if (!datos.success) throw new EsquemaNoValido(datos.error.issues[0]?.message ?? 'El esquema no es válido.');

  const delMetodo = new Map(catalogo.map((s) => [s.code, s]));
  const usadas = new Set();
  const titulos = new Set();

  const capitulos = datos.data.capitulos.map((capitulo) => {
    const titulo = capitulo.titulo;
    const clave = titulo.toLocaleLowerCase('es');
    if (titulos.has(clave)) {
      throw new EsquemaNoValido(`Hay dos capítulos titulados «${titulo}». Cada uno tiene que ser distinto.`);
    }
    titulos.add(clave);

    const de = (capitulo.de ?? []).filter(Boolean);
    for (const fase of de) {
      if (!delMetodo.has(fase)) {
        throw new EsquemaNoValido(
          `No hay ninguna fase con la clave "${fase}". Usa listar_capitulos para ver las que hay.`,
        );
      }
      /**
       * Y la propuesta de tema no es un capítulo de nadie.
       *
       * El esquema es la puerta por la que un reglamento puede pedir una fase
       * de trabajo dentro del documento —el cuestionario como anexo, que sí
       * pasa—, pero la propuesta que se lleva al asesor no es parte de ninguna
       * tesis, y quien escribe el esquema es el modelo. Bastó con que metiera
       * «tema-y-delimitacion» en el Capítulo I para que la tabla de la
       * propuesta volviera a encabezar la tesis, con índice y todo, que es
       * justo lo que se quitó.
       */
      if (NUNCA_EN_EL_DOCUMENTO.has(fase)) {
        throw new EsquemaNoValido(
          `La fase "${fase}" no va dentro del documento: ` +
            (fase === 'tema-y-delimitacion'
              ? 'la propuesta de tema es lo que el tesista lleva al asesor, no un capítulo de su tesis. '
              : fase === 'tsp-fase0-experiencia'
                ? 'la ficha de la experiencia es la base de los capítulos, no un capítulo. '
                : 'la ficha y la matriz son documentos de trabajo; el artículo empieza en la Introducción. ') +
            'Quítala del esquema ' +
            'y deja el capítulo con las fases que sí se escriben.',
        );
      }
      if (usadas.has(fase)) {
        throw new EsquemaNoValido(
          `La fase "${fase}" está en dos capítulos a la vez. Cada una va en uno solo.`,
        );
      }
      usadas.add(fase);
    }

    return de.length > 0 ? { titulo, de } : { titulo, clave: claveDe(titulo) };
  });

  return { capitulos: reconciliar(capitulos, anterior, conTexto) };
}

/**
 * Las claves de los capítulos propios que ya tenían texto se conservan.
 *
 * Si no, renombrar «Capítulo III: Hipótesis» a «Capítulo III: Hipótesis de la
 * investigación» cambiaba la clave y el texto guardado se quedaba en el disco
 * sin capítulo que lo reclamara: el tesista veía desaparecer un capítulo entero
 * del Word por haber corregido un título. Se emparejan por su posición entre
 * los capítulos propios, que es lo que se conserva al renombrar.
 */
function reconciliar(capitulos, anterior, conTexto) {
  const antesPropios = (anterior?.capitulos ?? []).filter((c) => c.clave);
  if (antesPropios.length === 0) return capitulos;

  let i = -1;
  return capitulos.map((capitulo) => {
    if (!capitulo.clave) return capitulo;
    i += 1;
    const antes = antesPropios[i];
    // Solo si la de antes tenía texto: si no, la clave nueva es mejor, porque
    // se parece al título.
    if (!antes || !conTexto.has(antes.clave) || conTexto.has(capitulo.clave)) return capitulo;
    return { ...capitulo, clave: antes.clave };
  });
}

/**
 * Los capítulos del documento, ya resueltos contra el catálogo y lo escrito.
 *
 * Devuelve, en orden: lo que dice el esquema y, detrás, las fases con texto que
 * el esquema no nombra (`sobrantes`), para que no se pierda nada. Sin esquema
 * devuelve el catálogo tal cual, que es como salía el Word hasta ahora.
 *
 * `partes` son las claves de donde sale el texto, en orden. Un capítulo propio
 * tiene una sola parte: él mismo.
 *
 * Las fases de trabajo (`FASES_DE_TRABAJO`) quedan fuera del cuerpo, salvo que
 * el esquema de su facultad las nombre: ahí manda el reglamento. Sin esquema
 * salen como ANEXOS al final (ver `ANEXOS_POR_DEFECTO`). Con
 * `incluirFasesDeTrabajo` entran tal cual y sin anexos, que es lo que necesita
 * todo lo que recorre lo ESCRITO y no lo impreso: el .bib, el repaso de
 * evidencia y la auditoría, que sí tienen que mirar el cuestionario.
 *
 * Cada capítulo dice además si es `anexo`, porque el Word los imprime detrás de
 * la lista de referencias y no en su sitio del esquema (ver `esAnexo`).
 */
function capitulosDelDocumento({
  esquema,
  catalogo = [],
  conTexto = new Set(),
  incluirFasesDeTrabajo = false,
}) {
  const informeFinal = yaEsInformeFinal(conTexto);
  const imprimible = (code) =>
    incluirFasesDeTrabajo ||
    (!FASES_DE_TRABAJO.has(code) && !(informeFinal && SOLO_DEL_PROYECTO.has(code)));

  const delCatalogo = trasLaMetodologia(
    catalogo
      .filter((s) => imprimible(s.code))
      .map((s) => ({ titulo: s.displayName, partes: [s.code], anexo: esAnexo(s.displayName) })),
  );
  if (!tieneEsquema(esquema)) {
    // La estructura por defecto: los capítulos del método, las referencias —que
    // las pone el Word— y detrás los anexos que tengan texto, numerados.
    const anexos = incluirFasesDeTrabajo
      ? []
      : ANEXOS_POR_DEFECTO.filter((a) => conTexto.has(a.code)).map((a, i) => ({
          titulo: `Anexo ${i + 1}: ${a.titulo}`,
          partes: [a.code],
          anexo: true,
          // Los nuestros, no los de un reglamento: el Word los agrupa bajo un
          // solo «Anexos» (ver `armar` en `project.docx`).
          porDefecto: true,
        }));
    return { capitulos: [...delCatalogo, ...anexos], sobrantes: [] };
  }

  const nombradas = new Set(esquema.capitulos.flatMap((c) => c.de ?? []));
  const capitulos = esquema.capitulos.map((c) => ({
    titulo: c.titulo,
    anexo: esAnexo(c.titulo),
    /**
     * Y de un esquema ya guardado, la propuesta de tema se cae igual.
     *
     * `normalizar` ya no la deja entrar, pero los esquemas que se guardaron
     * antes siguen en la base y se imprimen en cada descarga: el tesista veía
     * su Capítulo I encabezado por la tabla de la propuesta.
     */
    partes: c.clave
      ? [c.clave]
      : c.de.filter((code) => incluirFasesDeTrabajo || !NUNCA_EN_EL_DOCUMENTO.has(code)),
    // Un capítulo propio no está en el catálogo: se dice, para poder tratarlo
    // como las secciones aparte del informe.
    ...(c.clave ? { propio: true } : {}),
  }));

  const sobrantes = catalogo.filter(
    (s) => !nombradas.has(s.code) && conTexto.has(s.code) && imprimible(s.code),
  );
  return {
    capitulos: [
      ...capitulos,
      ...sobrantes.map((s) => ({
        titulo: s.displayName,
        partes: [s.code],
        anexo: esAnexo(s.displayName),
      })),
    ],
    sobrantes,
  };
}

/**
 * ¿Este proyecto tiene esquema propio?
 *
 * Por los capítulos y no por el objeto: quitarlo deja un `{}` guardado —la base
 * no admite volver a nulo desde aquí—, y un `{}` es «la estructura del método»,
 * igual que no tener nada.
 */
const tieneEsquema = (esquema) => Boolean(esquema?.capitulos?.length);

/** El capítulo propio de esa clave, si el esquema lo tiene. */
function capituloPropio(esquema, clave) {
  if (!esClavePropia(clave)) return null;
  const suyo = (esquema?.capitulos ?? []).find((c) => c.clave === clave);
  return suyo ? { code: suyo.clave, displayName: suyo.titulo, productCodes: [] } : null;
}

/** El esquema, dicho para que lo lea el asistente. */
function comoTexto(esquema, catalogo = []) {
  if (!tieneEsquema(esquema)) return null;
  const nombreDe = new Map(catalogo.map((s) => [s.code, s.displayName]));

  const lineas = esquema.capitulos.map((c) => {
    if (c.clave) return `  ${c.titulo}  (clave: ${c.clave}) — capítulo propio de su reglamento`;
    const fases = c.de.map((f) => nombreDe.get(f) ?? f).join(' + ');
    return `  ${c.titulo}  ← ${fases}`;
  });

  const conAnexos = esquema.capitulos.some((c) => esAnexo(c.titulo));

  return [
    'ESTRUCTURA DE CAPÍTULOS DE SU FACULTAD (así sale su Word, y no como los numera el método):',
    ...lineas,
    ...(conAnexos
      ? [
          'Los capítulos que empiezan por «Anexo» o «Apéndice» los imprime el Word DETRÁS de la ' +
            'lista de referencias, estén donde estén en esta lista: primero las referencias y ' +
            'después los anexos.',
        ]
      : []),
    'Nómbrale los capítulos así al hablar con él. Las claves para guardar y leer NO cambian: ' +
      'siguen siendo las del método, salvo las que ponen "clave:" aquí arriba.',
  ].join('\n');
}

module.exports = {
  normalizar,
  tieneEsquema,
  capitulosDelDocumento,
  FASES_DE_TRABAJO,
  SOLO_DEL_PROYECTO,
  yaEsInformeFinal,
  ANEXOS_POR_DEFECTO,
  esAnexo,
  capituloPropio,
  comoTexto,
  claveDe,
  esClavePropia,
  EsquemaNoValido,
  PREFIJO_PROPIO,
};
