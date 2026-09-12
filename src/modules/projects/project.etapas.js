'use strict';

/**
 * Qué deja cada etapa, y qué necesita de las anteriores.
 *
 * EL PROBLEMA QUE RESUELVE
 * ------------------------
 * La memoria del proyecto ya guarda un resumen en prosa de cada capítulo, y eso
 * basta para que el asistente no pregunte dos veces lo mismo. Lo que no basta es
 * para RESPONDER: «¿cuáles son los objetivos específicos?» sale de releer un
 * párrafo e interpretarlo, y dos asistentes distintos lo interpretan distinto.
 * Con los campos separados, el objetivo específico número dos es el número dos.
 *
 * Y sobre todo permite avisar. Un tesista que empieza metodología sin haber
 * fijado su población va a redactar un capítulo III que no cuadra con el I, y
 * hoy nadie se lo dice hasta que se lo dice su asesor.
 *
 * ESTO ES UN REGISTRO, NO CÓDIGO
 * ------------------------------
 * Añadir una etapa es añadir una entrada aquí. Se empieza por las dos primeras
 * del método de tesis a propósito: es el salto más corto, el que más se repite,
 * y si el planteamiento no funciona ahí no va a funcionar en las diez. Las
 * etapas que no aparecen siguen guardando su resumen en prosa como hasta ahora.
 */

/** Cuánto se admite en un campo suelto y en una lista. */
const MAXIMO_TEXTO = 600;
const MAXIMO_POR_LISTA = 8;

const ETAPAS = {
  'tema-y-delimitacion': {
    campos: {
      tema: {
        titulo: 'Tema delimitado',
        pista: 'El tema con su recorte, no el área general.',
      },
      poblacion: {
        titulo: 'Población',
        pista: 'A quién se estudia: «estudiantes de primer ciclo de universidades públicas de Lima».',
      },
      ambito: {
        titulo: 'Ámbito',
        pista: 'Dónde. Ciudad, institución o región.',
      },
      periodo: {
        titulo: 'Periodo',
        pista: 'Los años que abarca el estudio.',
      },
    },
    necesita: [],
  },

  'problema-y-objetivos': {
    campos: {
      problemaGeneral: {
        titulo: 'Problema general',
        pista: 'La pregunta de investigación, en interrogativa.',
      },
      objetivoGeneral: {
        titulo: 'Objetivo general',
        pista: 'Empieza por un verbo en infinitivo.',
      },
      objetivosEspecificos: {
        titulo: 'Objetivos específicos',
        lista: true,
        pista: 'Uno por línea. Suelen ser entre dos y cuatro.',
      },
      hipotesis: {
        titulo: 'Hipótesis',
        lista: true,
        pista: 'Solo si el estudio las lleva. Un estudio descriptivo puede no tenerlas.',
      },
      variables: {
        titulo: 'Variables',
        lista: true,
        pista: 'Las que se van a medir, tal como se van a nombrar en toda la tesis.',
      },
    },
    /**
     * Sin el tema delimitado y sin población, el problema se plantea en el aire.
     * Es el error que más caro sale: un objetivo general escrito antes de saber
     * a quién se estudia obliga a rehacer el capítulo I entero.
     */
    necesita: [{ etapa: 'tema-y-delimitacion', campos: ['tema', 'poblacion'] }],
  },

  metodologia: {
    campos: {
      enfoque: {
        titulo: 'Enfoque',
        pista: 'Cuantitativo, cualitativo o mixto. Tal cual, sin adornos.',
      },
      diseno: {
        titulo: 'Diseño',
        pista: 'No experimental, cuasiexperimental, fenomenológico…',
      },
      nivel: {
        titulo: 'Nivel o alcance',
        pista: 'Descriptivo, correlacional, explicativo.',
      },
      muestra: {
        titulo: 'Muestra',
        pista: 'Cuántos y de dónde. «120 estudiantes de la Facultad de Educación».',
      },
      muestreo: {
        titulo: 'Muestreo',
        pista: 'Probabilístico, por conveniencia, por saturación…',
      },
      tecnica: {
        titulo: 'Técnica',
        pista: 'Encuesta, entrevista, observación, análisis documental.',
      },
      instrumento: {
        titulo: 'Instrumento previsto',
        pista: 'Cómo se llama lo que se va a aplicar: «cuestionario de deserción».',
      },
      analisis: {
        titulo: 'Análisis previsto',
        lista: true,
        pista: 'Qué pruebas se piensan hacer. Una por línea.',
      },
    },
    /**
     * La metodología sin objetivos ni variables se escribe a ciegas: se acaba
     * eligiendo un diseño que no sirve para responder lo que se preguntó.
     */
    necesita: [
      { etapa: 'tema-y-delimitacion', campos: ['poblacion'] },
      { etapa: 'problema-y-objetivos', campos: ['objetivoGeneral', 'variables'] },
    ],
  },

  'instrumento-investigacion': {
    campos: {
      nombre: {
        titulo: 'Nombre del instrumento',
        pista: 'El mismo que se anunció en metodología.',
      },
      dimensiones: {
        titulo: 'Dimensiones',
        lista: true,
        pista: 'Las que mide. Deberían cubrir las variables declaradas.',
      },
      items: {
        titulo: 'Número de ítems',
        pista: 'Cuántas preguntas o reactivos tiene.',
      },
      escala: {
        titulo: 'Escala',
        pista: 'Likert de cinco puntos, dicotómica, abierta…',
      },
      validez: {
        titulo: 'Validez',
        pista: 'Cómo se validó: juicio de expertos, V de Aiken…',
      },
      confiabilidad: {
        titulo: 'Confiabilidad',
        pista: 'La prueba y su valor: «alfa de Cronbach 0,87».',
      },
    },
    necesita: [{ etapa: 'metodologia', campos: ['enfoque', 'tecnica'] }],
  },

  'analisis-datos-rstudio': {
    campos: {
      pruebas: {
        titulo: 'Pruebas realizadas',
        lista: true,
        pista: 'Las que de verdad se corrieron, no las que se pensaban correr.',
      },
      software: {
        titulo: 'Software',
        pista: 'R, SPSS, JASP…',
      },
      hallazgos: {
        titulo: 'Hallazgos principales',
        lista: true,
        pista: 'Uno por objetivo específico, en una línea cada uno.',
      },
      /**
       * Los números que devolvió el análisis, tal cual.
       *
       * De aquí sale la comprobación de que ninguna cifra del capítulo de
       * resultados se haya escrito sola. Ver `project.cifras`.
       */
      resultados: {
        titulo: 'Cifras obtenidas',
        lista: true,
        pista:
          'Un número por línea, con su etiqueta y tal como lo devolvió el análisis: ' +
          '«alfa de Cronbach = 0.87», «R2 = 0.4231», «p = 0.003».',
      },
    },
    necesita: [{ etapa: 'metodologia', campos: ['enfoque', 'analisis'] }],
  },
};

/** Los campos que admite una etapa, o null si esa etapa no está registrada. */
function definicionDe(skillCode) {
  return ETAPAS[skillCode] ?? null;
}

/**
 * Limpia lo que manda el asistente.
 *
 * Se descarta en silencio lo que no está declarado en vez de rechazar la
 * llamada entera: si el asistente se inventa un campo, lo que importa es que se
 * guarde bien lo demás. Rechazarlo todo por un extra haría perder también lo
 * bueno, y esto se llama en mitad de una conversación.
 */
function limpiar(skillCode, datos) {
  const definicion = definicionDe(skillCode);
  if (!definicion || !datos || typeof datos !== 'object') return null;

  const limpio = {};

  for (const [clave, campo] of Object.entries(definicion.campos)) {
    const valor = datos[clave];
    if (valor === undefined || valor === null) continue;

    if (campo.lista) {
      const lista = (Array.isArray(valor) ? valor : [valor])
        .map((v) => String(v).trim())
        .filter(Boolean)
        .map((v) => v.slice(0, MAXIMO_TEXTO))
        .slice(0, MAXIMO_POR_LISTA);
      if (lista.length > 0) limpio[clave] = lista;
      continue;
    }

    const texto = String(valor).trim().slice(0, MAXIMO_TEXTO);
    if (texto !== '') limpio[clave] = texto;
  }

  return Object.keys(limpio).length > 0 ? limpio : null;
}

/**
 * Fusiona lo nuevo con lo que ya había.
 *
 * Un asistente que corrige los objetivos específicos no puede borrar de paso el
 * problema general solo porque esa llamada no lo mencionaba. Es la misma regla
 * que en el resto de la memoria: lo que no viene, no se toca.
 */
function fusionar(anterior, nuevo) {
  return { ...(anterior ?? {}), ...(nuevo ?? {}) };
}

/**
 * Qué le falta a una etapa para poder empezarse.
 *
 * Devuelve una lista de textos ya redactados, listos para enseñar. Vacía
 * significa que puede empezar, y también significa eso cuando la etapa no está
 * registrada: no se inventan requisitos donde no se han declarado.
 */
function queFalta(skillCode, porEtapa) {
  const definicion = definicionDe(skillCode);
  if (!definicion) return [];

  const avisos = [];

  for (const requisito of definicion.necesita) {
    const previa = ETAPAS[requisito.etapa];
    const datos = porEtapa.get(requisito.etapa) ?? {};

    for (const clave of requisito.campos) {
      const valor = datos[clave];
      const puesto = Array.isArray(valor) ? valor.length > 0 : Boolean(valor);
      if (puesto) continue;

      const titulo = previa?.campos?.[clave]?.titulo ?? clave;
      avisos.push(titulo);
    }
  }

  return avisos;
}

/** Cómo se ven los datos de una etapa dentro del bloque que lee el asistente. */
function comoTexto(skillCode, datos) {
  const definicion = definicionDe(skillCode);
  if (!definicion || !datos) return [];

  const lineas = [];

  for (const [clave, campo] of Object.entries(definicion.campos)) {
    const valor = datos[clave];
    if (valor === undefined || valor === null) continue;

    if (campo.lista) {
      if (!Array.isArray(valor) || valor.length === 0) continue;
      lineas.push(`      ${campo.titulo}:`);
      valor.forEach((v, i) => lineas.push(`        ${i + 1}. ${v}`));
      continue;
    }

    lineas.push(`      ${campo.titulo}: ${valor}`);
  }

  return lineas;
}

/**
 * Los campos de UNA etapa, en el orden en que están declarados.
 *
 * Devuelve lista vacía cuando la etapa no está registrada, que es lo mismo que
 * dice `definicionDe`: esos capítulos se apañan con el resumen en prosa y eso
 * no es un fallo, es que no llevan campos.
 */
function camposDe(skillCode) {
  const definicion = definicionDe(skillCode);
  if (!definicion) return [];

  return Object.entries(definicion.campos).map(([clave, campo]) => ({
    clave,
    titulo: campo.titulo,
    pista: campo.pista,
    lista: campo.lista === true,
  }));
}

/** Para la descripción de la herramienta: qué campos acepta cada etapa. */
function catalogoParaElAsistente() {
  return Object.keys(ETAPAS).map((skillCode) => {
    const campos = camposDe(skillCode).map(
      (campo) => `${campo.clave}${campo.lista ? ' (lista)' : ''} — ${campo.pista}`,
    );
    return `${skillCode}:\n    ${campos.join('\n    ')}`;
  });
}

module.exports = {
  ETAPAS,
  definicionDe,
  limpiar,
  fusionar,
  queFalta,
  comoTexto,
  camposDe,
  catalogoParaElAsistente,
  MAXIMO_TEXTO,
  MAXIMO_POR_LISTA,
};
