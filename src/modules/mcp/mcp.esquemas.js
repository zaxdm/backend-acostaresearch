'use strict';
const { fromJsonSchema } = require('@modelcontextprotocol/server');
const normas = require('../projects/project.normas');
const etapas = require('../projects/project.etapas');
const bloquesDeAnalisis = require('../projects/project.bloques');
const ESQUEMA_FUENTES = fromJsonSchema({
  type: 'object',
  properties: {
    tema: {
      type: 'string',
      minLength: 3,
      description:
        'Sobre qué buscar, EN INGLÉS y en palabras del contenido, no una pregunta entera: ' +
        '«construct validity», «convenience sampling», «Cronbach alpha». ' +
        'Tradúcelo tú: el tesista escribe en español y la biblioteca de Acosta está en inglés.',
    },
    temaOriginal: {
      type: 'string',
      description:
        'El mismo tema EN ESPAÑOL, tal como lo dijo el tesista. Mándalo siempre. ' +
        'Con estas palabras se busca también en SU biblioteca —su Zotero, sus exports—, que ' +
        'suele estar en español y no la encuentra el tema en inglés. ' +
        'Y si no hay nada en ninguna, esta herramienta sale sola al catálogo abierto ' +
        'usando estas palabras, y ahí el español encuentra lo que el inglés no: Scielo, ' +
        'Redalyc y los repositorios latinoamericanos.',
    },
    pais: {
      type: 'string',
      description:
        'Código de dos letras del país del tesista: «pe» Perú, «es» España, «co» Colombia, «mx» México. ' +
        'Solo se usa si hay que salir al catálogo abierto, y sirve para traerle ' +
        'ANTECEDENTES NACIONALES, que es lo que le va a pedir su jurado.',
    },
    cuantas: {
      type: 'integer',
      minimum: 1,
      maximum: 15,
      description: 'Cuántas fuentes quieres. Por omisión, seis.',
    },
  },
  required: ['tema'],
  additionalProperties: false,
});

/**
 * La bola de nieve no pide tema: parte de lo que el tesista ya tiene.
 *
 * Es la diferencia con las otras dos búsquedas y conviene que se note en el
 * esquema: aquí no hay nada que teclear mal.
 */
/**
 * Añadir fuentes por DOI desde la conversación.
 *
 * El DOI y nada más: el título, los autores y el año se traen del catálogo. Si
 * se dejara al asistente mandar la ficha entera, la mitad de las fuentes de una
 * tesis acabarían con el año que le pareció y con un DOI que no resuelve, que
 * es exactamente lo que este producto existe para evitar.
 */
const ESQUEMA_ANADIR = fromJsonSchema({
  type: 'object',
  properties: {
    dois: {
      type: 'array',
      minItems: 1,
      maxItems: 60,
      items: { type: 'string', minLength: 7 },
      description:
        'Los DOI de las fuentes que el tesista quiere guardar, tal como aparecen en la lista ' +
        'que le enseñaste. NO los inventes ni los completes de memoria: si no tienes el DOI ' +
        'exacto, no la añadas.',
    },
  },
  required: ['dois'],
  additionalProperties: false,
});

/**
 * Ver su biblioteca sin tema.
 *
 * Es lo que pide quien dice «entra a mi Zotero» o «qué fuentes tengo», y no hay
 * palabra que buscar en esa frase.
 */
const ESQUEMA_MIS_FUENTES = fromJsonSchema({
  type: 'object',
  properties: {
    pagina: {
      type: 'integer',
      minimum: 1,
      description: 'Qué página de la lista. Por omisión, la primera; la respuesta dice cuántas hay.',
    },
    origen: {
      type: 'string',
      enum: ['todas', 'zotero', 'mendeley', 'subidas'],
      description:
        '«zotero» para ver solo lo que trajo de su Zotero; «mendeley», lo de su Mendeley; ' +
        '«subidas», lo que subió de un export o guardó por DOI. Por omisión, todas.',
    },
  },
  additionalProperties: false,
});

const ESQUEMA_BOLA = fromJsonSchema({
  type: 'object',
  properties: {
    desdeAnio: {
      type: 'integer',
      minimum: 1900,
      description:
        'Solo para lo que viene DESPUÉS: acota desde qué año quieres los trabajos que citan ' +
        'a los suyos. Útil cuando su marco teórico se ha quedado viejo y busca lo último.',
    },
    cuantas: {
      type: 'integer',
      minimum: 1,
      maximum: 15,
      description: 'Cuántas devolver de cada lado. Por defecto 8.',
    },
  },
  additionalProperties: false,
});

const ESQUEMA_LITERATURA = fromJsonSchema({
  type: 'object',
  properties: {
    tema: {
      type: 'string',
      minLength: 3,
      description:
        'Sobre qué buscar. AQUÍ SÍ VALE EL ESPAÑOL: esta base indexa Scielo, Redalyc y ' +
        'repositorios latinoamericanos. Escribe el tema como lo diría el tesista.',
    },
    idioma: {
      type: 'string',
      enum: ['es', 'en', 'pt'],
      description:
        'Acota el idioma de los trabajos. Úsalo con «es» cuando el tesista quiera fuentes ' +
        'que pueda leer sin traducir. Si lo omites, entran todos los idiomas.',
    },
    pais: {
      type: 'string',
      description:
        'Código de dos letras del país de los autores: «pe» Perú, «es» España, «co» Colombia, «mx» ' +
        'México, «cl» Chile. ES LO QUE PIDE UN JURADO cuando pregunta qué se ha estudiado ' +
        'sobre esto en el país. Sin él, entra la producción de todo el mundo.',
    },
    desdeAnio: {
      type: 'integer',
      minimum: 1900,
      description: 'Solo trabajos publicados desde ese año. Útil para «los últimos cinco años».',
    },
    cuantas: {
      type: 'integer',
      minimum: 1,
      maximum: 15,
      description: 'Cuántas fuentes quieres. Por omisión, seis.',
    },
  },
  required: ['tema'],
  additionalProperties: false,
});

const GUARDAR_AVANCE = {
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo sobre el que quedó algo decidido, tal como aparece en ' +
        'listar_capitulos. Omítelo si solo estás guardando el tema o la universidad.',
    },
    estado: {
      type: 'string',
      enum: ['PENDIENTE', 'EN_CURSO', 'LISTO'],
      description:
        'Cómo queda ese capítulo. Marca LISTO SOLO si el tesista ha dicho que lo da por ' +
        'bueno. No lo decidas tú porque hayáis escrito mucho: un capítulo que se da por ' +
        'cerrado sin que él lo cierre es el que luego no se sostiene ante el jurado.',
    },
    resumen: {
      type: 'string',
      maxLength: 1500,
      description:
        'Qué quedó decidido, en dos o tres frases y en concreto: los objetivos que se ' +
        'fijaron, la población que se eligió, el diseño acordado. NO el texto del ' +
        'capítulo — esto es la memoria de lo acordado, no el documento. Lo leerá el ' +
        'asistente que atienda al tesista la próxima vez, que no habrá visto esta ' +
        'conversación.',
    },
    tema: {
      type: 'string',
      description: 'El tema de la tesis ya delimitado, si se ha fijado o ha cambiado.',
    },
    carrera: { type: 'string', description: 'La carrera del tesista.' },
    universidad: { type: 'string', description: 'Su universidad.' },
    pais: {
      type: 'string',
      description:
        'El país donde estudia, en dos letras: «es» España, «mx» México, «co» Colombia. Si es del ' +
        'Perú no hace falta. GUÁRDALO en cuanto sepas que estudia fuera del Perú —por lo que diga o ' +
        'por su universidad—: con «es», "mi_proyecto" te dirá cómo adaptar el método a un TFG o un TFM.',
    },
    autor: {
      type: 'string',
      description:
        'Quién firma la tesis, tal como debe salir en la portada del Word y con sus dos ' +
        'apellidos («Ana María Quispe Flores»). Sin esto la portada sale con el nombre de la ' +
        'CUENTA, que no siempre es el del tesista: guárdalo en cuanto sepas que es otro.',
    },
    asesor: {
      type: 'string',
      description:
        'El nombre de su asesor o asesora, tal como debe salir en la portada del Word, con su ' +
        'grado si lo dice («Dr. Juan Pérez Gómez»). Si todavía no tiene, manda "" (vacío): así ' +
        'queda anotado que ya se preguntó y no se le vuelve a preguntar.',
    },
    estiloCitas: {
      type: 'string',
      enum: normas.IDS_DE_NORMA,
      description:
        'La norma de citas que exige su universidad o su asesor. El Word sale con las citas ' +
        'y las referencias ya escritas en ella, con notas al pie si la norma las pide. ' +
        'PREGÚNTASELA antes de que descargue su Word si el proyecto no la tiene elegida, y ' +
        'no la supongas por la universidad. Las que hay: ' +
        normas.NORMAS.map((n) => `${n.id} (${n.nombre})`).join('; ') +
        '.',
    },
    idiomaCitas: {
      type: 'string',
      enum: normas.IDS_DE_IDIOMA,
      description:
        'Idioma de las citas: decide «y» o «and», «s. f.» o «n.d.». Si no se dice, español ' +
        '(es-ES). Solo cámbialo si escribe la tesis en inglés o si se lo piden.',
    },
    datos: {
      type: 'object',
      description:
        'Lo mismo que el resumen pero por campos, para los capítulos que los tienen. ' +
        'Mándalo SIEMPRE que se fije uno de estos, además del resumen: el resumen se lee, ' +
        'los campos se usan.\n\n' +
        'tema-y-delimitacion: tema, poblacion, ambito, periodo.\n' +
        'problema-y-objetivos: problemaGeneral, objetivoGeneral, objetivosEspecificos ' +
        '(lista), hipotesis (lista), variables (lista).\n' +
        'metodologia: enfoque, diseno, nivel, muestra, muestreo, tecnica, instrumento, ' +
        'analisis (lista).\n' +
        'instrumento-investigacion: nombre, dimensiones (lista), items, escala, validez, ' +
        'confiabilidad.\n' +
        'analisis-datos-rstudio: pruebas (lista), software, hallazgos (lista).\n\n' +
        'Los capítulos que no salen aquí no llevan campos: para esos basta el resumen. ' +
        'Manda solo lo que se haya fijado; lo que no mandes se queda como estaba.',
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};

const ESQUEMA_GUARDAR_AVANCE = fromJsonSchema(GUARDAR_AVANCE);

/**
 * El mismo esquema para el Trabajo de Suficiencia Profesional.
 *
 * Solo cambia la lista de campos por capítulo: a quien hace un TSP no se le
 * enseñan hipótesis, muestra ni instrumento, porque Claude acaba rellenando lo
 * que ve. Los campos son los de `project.etapas`.
 */
const ESQUEMA_GUARDAR_AVANCE_TSP = fromJsonSchema({
  ...GUARDAR_AVANCE,
  properties: {
    ...GUARDAR_AVANCE.properties,
    tema: {
      type: 'string',
      description: 'El título del trabajo de suficiencia profesional, si se ha fijado o ha cambiado.',
    },
    datos: {
      ...GUARDAR_AVANCE.properties.datos,
      description:
        'Lo mismo que el resumen pero por campos, para los capítulos que los tienen. ' +
        'Mándalo SIEMPRE que se fije uno de estos, además del resumen: el resumen se lee, ' +
        'los campos se usan.\n\n' +
        'tsp-fase0-experiencia: empresa, rubro, cargo, periodo, experiencia, problema, ' +
        'evidencias (lista).\n' +
        'tsp-fase1-introduccion: problemaGeneral, objetivoGeneral, objetivosEspecificos (lista).\n' +
        'tsp-fase3-experiencia: metodologia, actividades (lista), herramientas (lista).\n' +
        'tsp-fase4-resultados: indicadores (lista), logros (lista).\n\n' +
        'Los capítulos que no salen aquí no llevan campos: para esos basta el resumen. ' +
        'Manda solo lo que se haya fijado; lo que no mandes se queda como estaba.',
    },
  },
});

/**
 * El mismo esquema con la ficha del informe estudiantil.
 *
 * Aparte y no dentro del de siempre: tesis y artículo no tienen curso ni
 * docente, y una propiedad que Claude ve la acaba rellenando. Solo se registra
 * para el perfil de informe (ver `productos/producto.perfil`).
 */
const ESQUEMA_GUARDAR_AVANCE_INFORME = fromJsonSchema({
  ...GUARDAR_AVANCE,
  properties: {
    ...GUARDAR_AVANCE.properties,
    informe: {
      type: 'object',
      description:
        'La ficha del informe: sale en la portada del Word y marca el calendario hasta la ' +
        'entrega. Un informe de curso usa tipo, curso, docente, integrantes, cicloSeccion, ciudad, ' +
        'fechaEntrega y rubrica; uno de empresa, ambito "empresa" y los campos marcados «Empresa». ' +
        'No mezcles los de un ámbito con los del otro. ' +
        'Mándala EN CUANTO te diga uno de estos datos, sin esperar a ' +
        'tenerlos todos. Lo que no mandes se queda como estaba; los integrantes se mandan ' +
        'TODOS cada vez, porque la lista sustituye a la anterior.',
      properties: {
        ambito: {
          type: 'string',
          enum: ['curso', 'empresa'],
          description:
            'Mándalo SOLO en un informe de empresa, con "empresa". En uno de curso no lo mandes: ' +
            'una ficha sin ámbito es de curso.',
        },
        tipo: {
          type: 'string',
          enum: [
            'curso', 'proyecto', 'caso', 'monografia',
            'diagnostico', 'gestion', 'factibilidad', 'mercado', 'tecnico', 'auditoria', 'avance',
            'incidente', 'sostenibilidad', 'duediligence', 'desempeno', 'clima', 'otro',
          ],
          description:
            'De curso: curso = informe académico sobre un tema del curso; proyecto = informe de un ' +
            'proyecto que hizo; caso = análisis de un caso que le dieron; monografia = monografía o ' +
            'trabajo monográfico, un tema desarrollado a fondo con fuentes. De empresa: diagnostico, ' +
            'gestion (resultados de un periodo), factibilidad (o plan de negocio), mercado, ' +
            'tecnico, auditoria (interna), avance (de un proyecto), incidente, sostenibilidad, ' +
            'duediligence, desempeno, clima u otro.',
        },
        curso: { type: 'string', description: 'El nombre del curso, como sale en su sílabo.' },
        docente: {
          type: 'string',
          description:
            'El docente, como debe salir en la portada, con su grado si lo dice. "" (vacío) si ' +
            'no hay docente que poner: así no se le vuelve a preguntar.',
        },
        integrantes: {
          type: 'array',
          maxItems: 10,
          description: 'Quienes firman el informe, en el orden de la portada.',
          items: {
            type: 'object',
            properties: {
              nombre: { type: 'string', description: 'Nombres y apellidos.' },
              codigo: { type: 'string', description: 'Su código de estudiante, si la portada lo pide.' },
            },
            required: ['nombre'],
            additionalProperties: false,
          },
        },
        cicloSeccion: { type: 'string', description: 'Ciclo y sección: «IV ciclo, sección B».' },
        ciudad: { type: 'string', description: 'La ciudad que va en la portada.' },
        fechaEntrega: {
          type: 'string',
          description: 'La fecha de entrega que puso el docente, como AAAA-MM-DD.',
        },
        rubrica: {
          type: 'string',
          maxLength: 1500,
          description:
            'Los criterios de la rúbrica o de la consigna, resumidos. Con esto se revisa el ' +
            'informe antes de entregarlo: NO los inventes si no te los ha dado.',
        },
        // ── Solo en un informe de empresa ──
        empresa: { type: 'string', description: 'Empresa: la empresa que se analiza, con su nombre comercial.' },
        sector: { type: 'string', description: 'Empresa: el sector y el tamaño, en texto.' },
        destinatario: {
          type: 'string',
          description: 'Empresa: a quién va el informe («Gerencia General», «el directorio», «Banco X»).',
        },
        preparadoPor: {
          type: 'string',
          description: 'Empresa: quien lo firma: la consultora, el área o la persona.',
        },
        cargo: { type: 'string', description: 'Empresa: el cargo de quien lo firma.' },
        periodo: { type: 'string', description: 'Empresa: lo que cubre el informe («enero a marzo de 2026»).' },
        confidencial: {
          type: 'boolean',
          description: 'Empresa: verdadero si la portada lleva la marca de documento confidencial.',
        },
        decision: {
          type: 'string',
          maxLength: 300,
          description: 'Empresa: la decisión que tiene que apoyar el informe, en una frase.',
        },
        alcance: {
          type: 'string',
          maxLength: 1500,
          description: 'Empresa: qué entra, qué no entra y las limitaciones, resumidos.',
        },
        terminos: {
          type: 'string',
          maxLength: 1500,
          description:
            'Empresa: lo que pidió el cliente en sus términos de referencia, resumido. Con esto se ' +
            'revisa el informe antes de entregarlo: NO lo inventes.',
        },
      },
      additionalProperties: false,
    },
  },
});

const GUARDAR_CAPITULO = {
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description: 'Clave del capítulo, tal como aparece en listar_capitulos.',
    },
    texto: {
      type: 'string',
      minLength: 1,
      maxLength: 30000,
      description:
        'El texto del capítulo tal y como va a la tesis, en Markdown: ## para los ' +
        'subtítulos y párrafos separados por una línea en blanco. NADA de comentarios ' +
        'tuyos, ni «aquí tienes», ni notas tuyas entre corchetes —solo valen las claves de ' +
        'cita, [FALTA FUENTE] y la marca de una figura—: esto se convierte en el Word ' +
        'que el tesista entrega. Si pasa de 30.000 caracteres, mándalo por partes. ' +
        'LAS TABLAS van en Markdown y salen en el Word como tablas en formato APA, en un solo ' +
        'bloque sin líneas en blanco: «**Tabla 1**», en la línea siguiente «*Título de la tabla*», ' +
        'luego la cabecera «| Col A | Col B |», la fila «|---|---|», las filas, y si hace falta ' +
        '«*Nota.* …» justo debajo. Las celdas admiten citas con clave. NO armes tú un Word para ' +
        'tener las tablas: el servidor ya las pone. ' +
        'LAS FIGURAS, también en un solo bloque: «**Figura 1**», «*Título de la figura*», ' +
        '«[Insertar aquí la Figura 1: nombre-del-archivo.png]» y, si hace falta, «*Nota.* …». Si ' +
        'el gráfico se dibujó en "trabajar_en_r", PON EL NOMBRE DEL PNG TAL CUAL lo guardaste en ' +
        'la sesión: el Word lo incrusta ya en su sitio. Si la imagen es del tesista, el Word deja ' +
        'una marca resaltada donde la pegue él: dile cuál va en cada marca.',
    },
    anadir: {
      type: 'boolean',
      description:
        'Verdadero para pegarlo detrás de lo que ya había, en vez de reemplazarlo. ' +
        'Úsalo para las partes segunda y siguientes de un capítulo largo. ' +
        'Si el tesista corrigió el capítulo entero, mándalo completo SIN esta marca.',
    },
  },
  required: ['capitulo', 'texto'],
  additionalProperties: false,
};

const ESQUEMA_GUARDAR_CAPITULO = fromJsonSchema(GUARDAR_CAPITULO);

/**
 * El mismo esquema para el informe estudiantil: admite las claves de sus
 * secciones aparte y habla del informe y del estudiante, no de la tesis.
 */
const ESQUEMA_GUARDAR_CAPITULO_INFORME = fromJsonSchema({
  ...GUARDAR_CAPITULO,
  properties: {
    ...GUARDAR_CAPITULO.properties,
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo, tal como aparece en listar_capitulos, o la de una sección aparte ' +
        'del informe: «informe-resumen» o «informe-introduccion». Esas dos se escriben al final ' +
        'y el Word las pone delante.',
    },
    texto: {
      ...GUARDAR_CAPITULO.properties.texto,
      description: GUARDAR_CAPITULO.properties.texto.description
        .replaceAll('a la tesis', 'al informe')
        .replaceAll('el tesista', 'el estudiante'),
    },
  },
});

const ESQUEMA_GUARDAR_ANALISIS = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo de resultados. Normalmente «analisis-datos-rstudio» en tesis o ' +
        '«articulo-fase5-resultados» en artículo.',
    },
    script: {
      type: 'string',
      maxLength: 30000,
      description:
        'El script de R que le pasaste al tesista, tal cual. Se guarda sin ejecutarlo: sirve ' +
        'para poder responder dentro de un año de dónde salió cada número.',
    },
    salida: {
      type: 'string',
      maxLength: 30000,
      description: 'Lo que le devolvió la consola de R, pegado tal cual, sin resumir.',
    },
    resultados: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Las cifras que van a aparecer en el texto, una por línea y con su etiqueta: ' +
        '«alfa de Cronbach = 0.87», «R2 = 0.4231», «p = 0.003», «beta = -0.31». ' +
        'SÁCALAS DE LA SALIDA que pegó el tesista, no de memoria. A partir de aquí, cualquier ' +
        'número que escribas en el capítulo y no esté en esta lista sale marcado en el repaso. ' +
        'SE SUMAN a las que ya había: manda solo las que falten, no la lista entera. Caben ' +
        `${etapas.MAXIMO_CIFRAS} por capítulo, y si pasas se te dice cuáles quedaron fuera.`,
    },
    reemplazar: {
      type: 'boolean',
      description:
        'Solo para empezar de cero: borra las cifras guardadas y deja únicamente las de esta ' +
        'llamada. Úsalo si se guardaron cifras equivocadas. Si no lo pones, se suman.',
    },
  },
  required: ['capitulo'],
  additionalProperties: false,
});

const ESQUEMA_VER_ANALISIS = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo. Déjala vacía para el de resultados del método, que es donde ' +
        'cae lo que se corre con trabajar_en_r.',
    },
    // Lista cerrada a propósito. Un texto libre sobre la consola de R devuelve
    // el bloque equivocado sin avisar: «ANOVA» casa con el veredicto de
    // normalidad, que nombra tres pruebas, y «Pearson» casa también con el
    // chi-cuadrado, que R llama «Pearson's Chi-squared test».
    bloque: {
      type: 'string',
      enum: [
        ...bloquesDeAnalisis.claves(),
        'script',
        'todo',
      ],
      description:
        'Qué parte quieres. Sin esto se devuelve el índice de lo que hay. "script" da el ' +
        'guion de R; "todo", la consola entera.',
    },
    desde: {
      type: 'integer',
      minimum: 1,
      description:
        'Primera línea de consola de un tramo pedido a mano, para lo que no cae en ningún ' +
        'bloque. Los números de línea salen del índice.',
    },
    hasta: {
      type: 'integer',
      minimum: 1,
      description: `Última línea del tramo. Se sirven ${bloquesDeAnalisis.MAXIMO_LINEAS} como máximo por petición.`,
    },
  },
  additionalProperties: false,
});

const ESQUEMA_TRABAJAR_EN_R = fromJsonSchema({
  type: 'object',
  properties: {
    codigo: {
      type: 'string',
      maxLength: 20000,
      description:
        'El código de R que ejecutar, tal cual. Varias líneas valen: se ejecutan en orden, como ' +
        'en la consola, y se para en el primer error. Déjalo vacío para ver qué hay en la sesión.',
    },
    reiniciar: {
      type: 'boolean',
      description:
        'Borra todos los objetos y el guion y vuelve a leer sus datos desde el archivo. Solo si la ' +
        'sesión quedó enredada, no antes de cada prueba.',
    },
    descargar: {
      type: 'string',
      description:
        'Nombre de un archivo de la sesión para darle al tesista un enlace de descarga: ' +
        '«resultados.csv», «figura1.png» o «graficos/grafico-01.png». Los que hay salen en la respuesta.',
    },
    subir: {
      type: 'boolean',
      description:
        'Un enlace para subir OTRO archivo aunque la sesión ya tenga datos: su matriz corregida, o ' +
        'el exporte de Scopus o WoS para un mapeo bibliométrico. Lo que suba reemplaza lo que hay ' +
        'en la sesión: díselo antes. Sin datos en la sesión, el enlace sale solo.',
    },
    informe: {
      type: 'object',
      description:
        'SOLO cuando el tesista pida el informe o el capítulo de resultados en Word. Mándalo solo, ' +
        'sin código en la misma llamada. Ver INFORME EN WORD en la descripción de la herramienta.',
      properties: {
        titulo: {
          type: 'string',
          maxLength: 200,
          description: 'El título, un renglón por línea: «CAPÍTULO IV\nRESULTADOS» o «Informe de resultados».',
        },
        texto: {
          type: 'string',
          minLength: 1,
          maxLength: 60000,
          description:
            'El informe en Markdown, con las tablas y las figuras en la sintaxis de la descripción y las ' +
            'citas con las claves de sus fuentes.',
        },
        norma: {
          type: 'string',
          enum: normas.IDS_DE_NORMA,
          description:
            'La norma de citas que eligió el tesista para este informe. PREGÚNTASELA si su proyecto no ' +
            'tiene una. Sin ella sale la de su proyecto, o APA 7.',
        },
      },
      required: ['texto'],
      additionalProperties: false,
    },
  },
  additionalProperties: false,
});

const ESQUEMA_VER_CAPITULO = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description: 'Clave del capítulo, tal como aparece en mi_proyecto.',
    },
    texto: {
      type: 'boolean',
      description:
        'Verdadero para leer el TEXTO GUARDADO del capítulo en vez de lo acordado. Úsalo para ' +
        'escribir contra lo que ya está escrito —la Discusión contra los Resultados, las ' +
        'Conclusiones contra todo lo anterior— en vez de pedirle al tesista que lo pegue.',
    },
    parte: {
      type: 'integer',
      minimum: 1,
      description:
        'Con "texto": qué parte leer. Un capítulo largo sale por partes; la respuesta dice ' +
        'cuántas hay y cuál pedir después. Por omisión, la primera.',
    },
    numerado: {
      type: 'boolean',
      description:
        'Con "texto": true, el texto sale con cada párrafo numerado (¶7), para cambiar párrafos sueltos ' +
        'con "reescribir_parrafos" sin volver a guardar el capítulo entero.',
    },
    desde: {
      type: 'integer',
      minimum: 1,
      description: 'Con "numerado": el número de párrafo desde el que seguir leyendo.',
    },
  },
  required: ['capitulo'],
  additionalProperties: false,
});

const ESQUEMA_REVISAR_EVIDENCIA = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo a revisar. Si lo omites se revisa todo lo escrito, que es lo ' +
        'que conviene antes de entregar.',
    },
  },
  additionalProperties: false,
});

const ESQUEMA_REDACTAR = fromJsonSchema({
  type: 'object',
  properties: {
    capitulo: {
      type: 'string',
      description:
        'Clave del capítulo o de la herramienta de apoyo, tal como aparece en listar_capitulos.',
    },
    mensaje: {
      type: 'string',
      minLength: 1,
      description: 'Lo que el tesista quiere hacer, o su respuesta al paso anterior.',
    },
    paso: {
      type: 'integer',
      minimum: 1,
      description:
        'Solo en los capítulos que se entregan como método: número del tramo que quieres. ' +
        'Si lo omites, se sirve el siguiente al último que recibiste.',
    },
    referencia: {
      type: 'string',
      description:
        'Solo en los capítulos que se entregan como método: nombre del material de apoyo ' +
        'que quieres, tal como aparece en el listado del capítulo.',
    },
    sesion: {
      type: 'string',
      description:
        'Identificador de esta conversación, elegido por ti: invéntalo la primera vez ' +
        'y repite el mismo en todas las llamadas del mismo hilo, para no empezar de cero. ' +
        'Usa uno distinto para cada conversación nueva.',
    },
  },
  required: ['capitulo', 'mensaje'],
  additionalProperties: false,
});


module.exports = { ESQUEMA_FUENTES, ESQUEMA_ANADIR, ESQUEMA_MIS_FUENTES, ESQUEMA_BOLA, ESQUEMA_LITERATURA, GUARDAR_AVANCE, ESQUEMA_GUARDAR_AVANCE, ESQUEMA_GUARDAR_AVANCE_TSP, ESQUEMA_GUARDAR_AVANCE_INFORME, GUARDAR_CAPITULO, ESQUEMA_GUARDAR_CAPITULO, ESQUEMA_GUARDAR_CAPITULO_INFORME, ESQUEMA_GUARDAR_ANALISIS, ESQUEMA_VER_ANALISIS, ESQUEMA_TRABAJAR_EN_R, ESQUEMA_VER_CAPITULO, ESQUEMA_REVISAR_EVIDENCIA, ESQUEMA_REDACTAR };
