'use strict';

/**
 * El repaso antes de entregar.
 *
 * Es lo último que un asesor hace a mano y lo que más caro sale si falla: un
 * objetivo específico sin conclusión, una variable que se declaró y nunca se
 * midió, un capítulo dado por bueno que en realidad está vacío. Nada de eso
 * requiere entender la tesis; requiere cotejarla consigo misma, que es
 * exactamente lo que una persona cansada deja de hacer bien a las once de la
 * noche del día antes.
 *
 * QUÉ SE COMPRUEBA Y QUÉ NO
 * -------------------------
 * De los seis controles que pide el brief (§4.8), aquí están los que se pueden
 * comprobar de verdad. Los otros dos —que los números del texto cuadren con los
 * de las tablas, y que la fuente diga lo que la frase le atribuye— NO se pueden
 * hacer sin leer, y se dicen en voz alta en la salida en lugar de dejar creer
 * que se han mirado. Una revisión que promete de más es peor que ninguna,
 * porque el tesista deja de mirar él.
 *
 * NINGÚN HALLAZGO ES UNA SENTENCIA. Un tesista puede tener buenas razones para
 * todo lo que aquí sale marcado. Por eso los textos dicen «revísalo» y no «está
 * mal»: quien decide es él, y a esto se le pide que no se le pase nada, no que
 * tenga razón.
 */

const { normalizar } = require('../references/zotero.mapper');

/** Capítulos donde no citar nada es, casi siempre, un olvido. */
const EXIGEN_FUENTES = new Set(['marco-teorico', 'discusion', 'articulo-fase3-revision-literatura']);

/**
 * Palabras que no distinguen un objetivo de otro.
 *
 * Los verbos con los que empieza todo objetivo y los conectores que lleva
 * cualquier frase académica. Sin quitarlos, dos objetivos completamente
 * distintos se parecerían en un 60% y no se detectaría nada.
 */
const VACIAS = new Set([
  'identificar', 'determinar', 'analizar', 'establecer', 'describir', 'evaluar',
  'comparar', 'medir', 'conocer', 'explicar', 'proponer', 'relacion', 'relacionar',
  'mediante', 'durante', 'respecto', 'through', 'estudio', 'investigacion',
  'trabajo', 'presente', 'general', 'especifico', 'especificos', 'objetivo',
]);

/** Las palabras con contenido de una frase, normalizadas. */
function palabrasClave(frase) {
  return new Set(
    normalizar(frase)
      .split(/[^a-z0-9]+/)
      .filter((p) => p.length >= 6 && !VACIAS.has(p)),
  );
}

/**
 * ¿Aparece el contenido de esta frase en ese texto?
 *
 * Se pide que esté al menos la mitad de sus palabras con contenido. No es
 * comprensión: es cotejo, y por eso el resultado se enuncia como una duda —
 * «puede que no esté respondido»— y no como un veredicto.
 */
function apareceEn(frase, texto) {
  const claves = palabrasClave(frase);
  if (claves.size === 0) return true;

  const enTexto = normalizar(texto);
  let encontradas = 0;
  for (const palabra of claves) if (enTexto.includes(palabra)) encontradas += 1;

  return encontradas / claves.size >= 0.5;
}

const grave = (mensaje) => ({ nivel: 'grave', mensaje });
const aviso = (mensaje) => ({ nivel: 'aviso', mensaje });

/**
 * Revisa la tesis contra sí misma.
 *
 * `capitulos` son los que tienen texto, con su clave y su título; `etapas` es
 * lo que hay guardado de cada una; `evidencia` es el informe de respaldo, que ya
 * se calcula aparte y no se repite aquí.
 */
function auditar({ proyecto, catalogo, etapas, capitulos, evidencia, citasRotas = [] }) {
  const hallazgos = [];

  const porCodigo = new Map(catalogo.map((s) => [s.code, s]));
  const textoDe = new Map(capitulos.map((c) => [c.code, c.texto]));
  const nombre = (code) => porCodigo.get(code)?.displayName ?? code;

  // ── 1. Lo que se dio por bueno sin escribirlo ──────────────────────────
  for (const etapa of etapas) {
    if (etapa.estado !== 'LISTO') continue;
    if ((etapa.palabras ?? 0) > 0) continue;
    // El humanizador y las etapas de trabajo no producen capítulo; solo se
    // señalan las que sí deberían haber dejado texto.
    if (!porCodigo.has(etapa.skillCode)) continue;

    hallazgos.push(
      grave(
        `«${nombre(etapa.skillCode)}» está dado por bueno pero no tiene texto guardado. ` +
          'O falta guardarlo con "guardar_capitulo", o no debería estar cerrado.',
      ),
    );
  }

  // ── 2. Coherencia entre objetivos, variables y conclusiones ────────────
  const datos = new Map(etapas.map((e) => [e.skillCode, e.datos ?? {}]));
  const objetivos = datos.get('problema-y-objetivos') ?? {};

  const especificos = objetivos.objetivosEspecificos ?? [];
  const variables = objetivos.variables ?? [];

  if (objetivos.objetivoGeneral && especificos.length === 0) {
    hallazgos.push(
      aviso('Hay objetivo general pero ningún objetivo específico guardado. Revísalo.'),
    );
  }

  // Una variable declarada que no asoma en ningún objetivo se mide sin que
  // nadie se lo haya propuesto, o se propuso y se quedó sin medir.
  const textoObjetivos = [objetivos.objetivoGeneral, ...especificos].filter(Boolean).join(' ');
  if (textoObjetivos && variables.length > 0) {
    for (const variable of variables) {
      if (!apareceEn(variable, textoObjetivos)) {
        hallazgos.push(
          aviso(
            `La variable «${variable}» no aparece en ningún objetivo. ` +
              'O sobra en la lista, o falta un objetivo que la recoja.',
          ),
        );
      }
    }
  }

  // Cada objetivo específico debería tener su conclusión. Es de las primeras
  // cosas que mira un jurado, y de las que más se caen al final.
  const conclusiones = textoDe.get('conclusiones-abstract');
  if (conclusiones && especificos.length > 0) {
    especificos.forEach((objetivo, i) => {
      if (!apareceEn(objetivo, conclusiones)) {
        hallazgos.push(
          aviso(
            `El objetivo específico ${i + 1} —«${objetivo}»— puede que no esté respondido en ` +
              'las conclusiones. Compruébalo: es de lo primero que mira un jurado.',
          ),
        );
      }
    });
  }

  // ── 2b. Metodología → instrumento → análisis ───────────────────────────
  //
  // La cadena que un jurado recorre entera: se dijo que se iba a medir X con
  // tal técnica, el instrumento tiene que medir X, y el análisis tiene que ser
  // el que corresponde a ese enfoque. Se rompe por el medio con una facilidad
  // sorprendente, porque cada capítulo se escribe semanas después del anterior.
  const metodo = datos.get('metodologia') ?? {};
  const instrumento = datos.get('instrumento-investigacion') ?? {};
  const analisis = datos.get('analisis-datos-rstudio') ?? {};

  if (metodo.instrumento && instrumento.nombre && !apareceEn(metodo.instrumento, instrumento.nombre)) {
    hallazgos.push(
      aviso(
        `En metodología se anuncia «${metodo.instrumento}» y el instrumento guardado es ` +
          `«${instrumento.nombre}». Si son el mismo, llámalo igual en los dos sitios.`,
      ),
    );
  }

  // Una variable que el instrumento no mide es una variable que no se va a
  // poder responder, y no se descubre hasta los resultados.
  const dimensiones = (instrumento.dimensiones ?? []).join(' ');
  if (dimensiones && variables.length > 0) {
    for (const variable of variables) {
      if (!apareceEn(variable, dimensiones)) {
        hallazgos.push(
          aviso(
            `La variable «${variable}» no aparece entre las dimensiones del instrumento. ` +
              'Si no se mide, no se va a poder responder en los resultados.',
          ),
        );
      }
    }
  }

  // Un enfoque cualitativo con pruebas estadísticas encima es de los descuadres
  // que se ven a un metro de distancia.
  const ESTADISTICAS = /\b(chi|cuadrado|pearson|spearman|anova|regresi[óo]n|t de student|cronbach|kolmog[óo]rov|shapiro)\b/i;
  const pruebas = (analisis.pruebas ?? []).join(' ');
  if (/cualitativ/i.test(metodo.enfoque ?? '') && ESTADISTICAS.test(pruebas)) {
    hallazgos.push(
      grave(
        `El enfoque declarado es «${metodo.enfoque}» y las pruebas realizadas son estadísticas. ` +
          'Una de las dos cosas no es la que se hizo.',
      ),
    );
  }

  // Lo que se prometió analizar y no aparece entre lo analizado.
  if ((metodo.analisis ?? []).length > 0 && pruebas) {
    for (const previsto of metodo.analisis) {
      if (!apareceEn(previsto, pruebas)) {
        hallazgos.push(
          aviso(
            `En metodología se anunció «${previsto}» y no aparece entre las pruebas ` +
              'realizadas. O se hizo y falta anotarlo, o hay que explicar por qué no.',
          ),
        );
      }
    }
  }

  // ── 3. Requisitos sin cubrir ───────────────────────────────────────────
  for (const etapa of etapas) {
    if (etapa.estado === 'PENDIENTE' && (etapa.palabras ?? 0) === 0) continue;
    for (const falta of etapa.faltan ?? []) {
      hallazgos.push(
        aviso(`«${nombre(etapa.skillCode)}» se apoya en ${falta}, que no está fijado.`),
      );
    }
  }

  // ── 4. Citas ───────────────────────────────────────────────────────────
  for (const clave of citasRotas) {
    hallazgos.push(
      grave(
        `La cita ${clave} no corresponde a ninguna fuente. En el Word sale como «CITA SIN ` +
          'LOCALIZAR», a la vista de quien lo lea.',
      ),
    );
  }

  for (const capitulo of capitulos) {
    if (!EXIGEN_FUENTES.has(capitulo.code)) continue;
    const tiene = evidencia?.capitulos?.find((c) => c.titulo === nombre(capitulo.code));
    if (tiene && tiene.conRespaldo.length === 0) {
      hallazgos.push(
        grave(`«${nombre(capitulo.code)}» no cita ni una sola fuente. En ese capítulo eso no cuela.`),
      );
    }
  }

  // ── 5. Lo que ya sabe la capa de evidencia ─────────────────────────────
  if (evidencia?.total?.citasAMano > 0) {
    hallazgos.push(
      grave(
        `Hay ${evidencia.total.citasAMano} citas escritas a mano que no salen de ninguna ficha. ` +
          'Nadie ha comprobado que existan. Pásalas por "revisar_evidencia".',
      ),
    );
  }

  if (evidencia?.total?.sinRespaldo > 0) {
    hallazgos.push(
      aviso(
        `Hay ${evidencia.total.sinRespaldo} afirmaciones que piden fuente y no citan ninguna. ` +
          'Las tienes una a una en "revisar_evidencia".',
      ),
    );
  }

  // ── 6. Lo que falta por escribir ───────────────────────────────────────
  const escritos = new Set(capitulos.map((c) => c.code));
  const sinEscribir = catalogo.filter((s) => !escritos.has(s.code));

  return {
    hallazgos,
    graves: hallazgos.filter((h) => h.nivel === 'grave').length,
    avisos: hallazgos.filter((h) => h.nivel === 'aviso').length,
    escritos: capitulos.length,
    sinEscribir: sinEscribir.map((s) => s.displayName),
    tema: proyecto?.tema ?? null,
  };
}

module.exports = { auditar, apareceEn, palabrasClave, EXIGEN_FUENTES };
