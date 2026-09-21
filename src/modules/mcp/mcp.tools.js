'use strict';

const { McpServer, fromJsonSchema } = require('@modelcontextprotocol/server');
const env = require('../../config/env');
const logger = require('../../config/logger');
const skillService = require('../skills/skill.service');
const skillRunner = require('../skills/skill.runner');
const skillDelivery = require('../skills/skill.delivery');
const licenseService = require('../licensing/license.service');
const { analizarIntencion, RESPUESTA_RECHAZO } = require('../licensing/license.guard');
const prisma = require('../../lib/prisma');
const referenceService = require('../references/reference.service');
const propiasService = require('../references/propias.service');
const projectService = require('../projects/project.service');
const documentoService = require('../projects/documento.service');
const subidaFormato = require('../projects/project.subida-formato');
const subidaMaterial = require('../projects/project.subida-material');
const subidaDocumento = require('../projects/project.subida-documento');
const { enlaceClic } = require('../../shared/utils/enlaceClic');
const enlaceCorto = require('../enlaces/enlaceCorto.service');

/**
 * Lo que dura un enlace del conector cuando quien lo pide no dice otra cosa.
 *
 * Todos los enlaces firmados de este backend duran media hora —subida de
 * documento, de formato, de material, de entrevistas, descarga— y hay una
 * llamada que no pasa sus minutos porque no los enseña al tesista. Al acortar
 * sí hacen falta: el código tiene que vencer a la vez que el token.
 */
const MINUTOS_POR_DEFECTO = 30;
const materialService = require('../projects/material.service');
const cualitativoService = require('../cualitativo/cualitativo.service');
const subidaEntrevistas = require('../cualitativo/cualitativo.enlaces');
const { CodificacionNoValida } = require('../cualitativo/cualitativo.codificacion');
const memosCualitativos = require('../cualitativo/cualitativo.memos');
const rEnlaces = require('../r/r.enlaces');
const consejos = require('../projects/project.consejos');
const normas = require('../projects/project.normas');
const etapas = require('../projects/project.etapas');
const esquemaDeCapitulos = require('../projects/project.esquema');
const bloquesDeAnalisis = require('../projects/project.bloques');
const rService = require('../r/r.service');
const { perfilDe } = require('../productos/producto.perfil');

/**
 * Los esquemas de las herramientas van en JSON Schema, no en Zod.
 *
 * El SDK de MCP necesita convertirlos a JSON Schema para responder a
 * `tools/list`, y solo sabe hacerlo desde Zod 4.2 en adelante. El resto del
 * backend valida con Zod 3 y actualizarlo entero por tres esquemas sería
 * cambiar código que ya funciona; `fromJsonSchema` deja el problema aquí
 * encerrado.
 */
/**
 * El salto de línea, con nombre corto.
 *
 * Se usaba en un mensaje SIN ESTAR DEFINIDA en ninguna parte: la rama de «no
 * hay resultados» de buscar_en_la_literatura lanzaba un ReferenceError en vez
 * de dar la explicación que tiene escrita. No lo cazó nadie porque solo se
 * llega ahí cuando una búsqueda no devuelve nada.
 */
const N = '\n';

const SIN_ARGUMENTOS = fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false });

/** «16 de septiembre de 2026», para que el tesista reconozca qué versión subió. */
const fechaCorta = (iso) =>
  iso
    ? new Date(iso).toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' })
    : 'fecha desconocida';

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
        'Código de dos letras del país del tesista: «pe» Perú, «co» Colombia, «mx» México. ' +
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
        'Código de dos letras del país de los autores: «pe» Perú, «co» Colombia, «mx» ' +
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
            'curso', 'proyecto', 'caso',
            'diagnostico', 'gestion', 'factibilidad', 'mercado', 'tecnico', 'auditoria', 'avance',
            'incidente', 'sostenibilidad', 'duediligence', 'desempeno', 'clima', 'otro',
          ],
          description:
            'De curso: curso = informe académico sobre un tema del curso; proyecto = informe de un ' +
            'proyecto que hizo; caso = análisis de un caso que le dieron. De empresa: diagnostico, ' +
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

const NOMBRE_SERVIDOR = 'acosta-research-tesis';
const VERSION_SERVIDOR = '1.0.0';

/**
 * Hilo de entrega de una licencia. Guarda por qué tramo va, de modo que el
 * asistente pueda pedir «el siguiente» sin llevar él la cuenta.
 */
async function sesionDeEntrega(licenseId, clientKey, skillCode) {
  const clave = clientKey || 'principal';
  const existente = await prisma.mcpSession.findUnique({
    where: { licenseId_clientKey: { licenseId, clientKey: clave } },
  });

  // Cambiar de capítulo reinicia la cuenta: los tramos son de cada uno.
  if (existente && existente.skillCode === skillCode) return existente;

  if (existente) {
    return prisma.mcpSession.update({
      where: { id: existente.id },
      data: { skillCode, lastSection: 0 },
    });
  }

  return prisma.mcpSession.create({
    data: { licenseId, clientKey: clave, skillCode, messages: '[]', lastSection: 0 },
  });
}

function guardarTramo(sessionId, skillCode, numero) {
  return prisma.mcpSession.update({
    where: { id: sessionId },
    data: { skillCode, lastSection: numero, turns: { increment: 1 } },
  });
}

/** Respuesta de texto plano, que es lo que el cliente sabe mostrar siempre. */
function texto(contenido) {
  return { content: [{ type: 'text', text: contenido }] };
}

/**
 * La primera línea de una búsqueda abierta que salió por Crossref, o nada.
 *
 * Crossref es el respaldo de OpenAlex y no acota por país ni por idioma. Si el
 * tesista pidió antecedentes peruanos, la lista NO lo es, y el asistente tiene
 * que saberlo antes de presentarla.
 */
function avisoDeCrossref(origen, filtrosSinAplicar = []) {
  if (origen !== 'crossref') return '';
  const sinFiltro =
    filtrosSinAplicar.length > 0
      ? ` Y NO SE PUDO ACOTAR POR ${filtrosSinAplicar.join(' NI POR ').toUpperCase()}: no presentes ` +
        'estas fuentes como si lo estuvieran; revisa en cada una de dónde es antes de decirlo.'
      : '';
  return (
    'OpenAlex no respondía, así que esta búsqueda salió por Crossref, el registro de los DOI. ' +
    `No trae si hay PDF gratis ni el idioma.${sinFiltro}${N}${N}`
  );
}

/**
 * Construye el servidor MCP para UNA licencia concreta.
 *
 * Se crea uno por petición y muere con ella: así la licencia queda cerrada
 * dentro de las herramientas y no hay forma de que una petición acabe
 * respondiendo con los datos de otro comprador.
 */
function construirServidor(licencia, { cliente = 'otro' } = {}) {
  const server = new McpServer({ name: NOMBRE_SERVIDOR, version: VERSION_SERVIDOR });

  /**
   * Los enlaces, en la forma que entienda el asistente con el que se habla.
   *
   * Un enlace en Markdown se pulsa limpio en claude.ai y ChatGPT lo rompe. Todas
   * las herramientas que reparten enlaces pasan por aquí para no tener que
   * acordarse de ello una por una. El porqué, en `mcp.cliente` y `enlaceClic`.
   *
   * Y SE ACORTA SIEMPRE, sea cual sea el asistente. Al principio esto era solo
   * para ChatGPT, que entrega la dirección entera pero no la copia: la reescribe
   * y en 400 caracteres al azar se equivoca en uno. Se dejó a Claude con el
   * enlace largo porque allí el Markdown funciona, y funciona… hasta que el
   * modelo decide reescribir la línea en vez de copiarla. El 20-sep-2026 le
   * pasó dos veces en la misma conversación: al tesista le llegaron dos enlaces
   * con un carácter cambiado y dos veces «llegó incompleto o alterado».
   *
   * Ocho caracteres no se le tuercen a nadie, y el que menos escribe el modelo
   * es el que menos puede estropear. Ver `enlaceCorto.service`.
   *
   * Si acortar falla, `acortar` devuelve el enlace largo: una dirección fea es
   * mucho mejor que quedarse sin darle ninguna.
   */
  const darEnlace = async (args) => {
    const url = await enlaceCorto.acortar({
      destino: args.url,
      // Los dos tienen que vencer a la vez: un código vivo que lleve a un token
      // muerto le diría «llegó incompleto» a quien solo llegó tarde.
      minutos: args.minutos ?? MINUTOS_POR_DEFECTO,
      base: env.apiPublicUrl,
    });

    return enlaceClic({ ...args, url, cliente });
  };

  /**
   * Cómo se llama lo que está escribiendo este comprador.
   *
   * El servidor se construye por licencia, así que el producto se sabe aquí y
   * las herramientas pueden hablar en sus términos. Decirle «tu tesis» a quien
   * está escribiendo un artículo para una revista no es un detalle de estilo:
   * es el asistente demostrando que no sabe qué está haciendo, en la primera
   * frase.
   */
  const perfil = perfilDe(licencia.productCode);
  const SU_OBRA = perfil.obra;

  /**
   * En un conector de prueba, las herramientas que trabajan también gastan cupo.
   *
   * A un comprador solo le descuenta `redactar`: lo demás es su proyecto y ya lo
   * pagó. Un invitado no pagó nada, y «Consultas al día» en el enlace se lee
   * como lo que dice: cuántas veces puede usar el conector. Sin esto, un
   * invitado con tope de 5 hizo trece búsquedas en la literatura en una tarde.
   *
   * Siguen sin gastar lo que orienta —lista, estado, proyecto, ver— y lo que
   * guarda: su Claude guarda avances por su cuenta, y cobrarlos dejaría a
   * alguien sin cupo por conservar lo que ya se le dio.
   *
   * Devuelve `{ bloqueo }` con la respuesta si no le queda, o `{ reserva }`.
   */
  const esPrueba = Boolean(licencia.user?.trialLink);
  async function cupoDePrueba(tool, prompt) {
    if (!esPrueba) return {};
    const cupo = await licenseService.reserveLimits(licencia);
    if (cupo.permitido) return { reserva: cupo.reserva };
    await licenseService.recordUsage({
      licenseId: licencia.id,
      tool,
      prompt,
      ok: false,
      kind: 'BLOCKED_LIMIT',
    });
    return { bloqueo: texto(cupo.motivo) };
  }

  // ── Catálogo ─────────────────────────────────────────────────────────────
  server.registerTool(
    'listar_capitulos',
    {
      title: 'Capítulos disponibles',
      description:
        'El catálogo de ESTA licencia: los capítulos que trabaja el método y las herramientas ' +
        'de apoyo que trae, con lo que hace cada uno y lo que necesita. ÚSALA cuando haga falta ' +
        'saber qué tiene disponible el tesista, o qué hace algo en concreto. No en cada ' +
        'conversación: por dónde va su proyecto lo dice "mi_proyecto" — aquí están las ' +
        'capacidades, allí el estado.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      // Solo los capítulos del grupo que esta licencia compró. Sin el filtro,
      // quien pagara el humanizador vería también el método de tesis.
      const skills = await skillService.listCatalog(licencia.productCode);
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'listar_capitulos' });

      if (skills.length === 0) {
        return texto('Todavía no hay capítulos publicados. Escribe a Acosta | IA & Research.');
      }

      // Una licencia de entrega no necesita que la skill esté subida a la
      // Skills API: el método sale del bundle que ya está en este servidor.
      // Sin esto, el catálogo diría «pendiente de publicar» mientras `redactar`
      // funciona, que es la peor combinación posible.
      const entregaDirecta = licencia.delivery === 'INSTRUCTIONS';
      const disponible = (s) => entregaDirecta || Boolean(s.anthropicSkillId);
      const publicados = skills.filter(disponible);

      const lineas = skills.map((s) => {
        // El motivo tiene que ser inequívoco: sin él, el asistente se inventa
        // una explicación —«será que no has definido el tema»— y el tesista se
        // queda pensando que el fallo es suyo.
        const pendiente = disponible(s)
          ? ''
          : env.skillsSimuladas
            ? '  [MODO DE PRUEBA]'
            : '  [pendiente de publicar por Acosta]';
        return `${s.displayName}${pendiente}\n    clave: ${s.code}\n    ${s.summary}`;
      });

      // En modo de prueba se avisa por delante: el asistente tiene que decirlo,
      // porque el texto que va a recibir el usuario NO sirve para su tesis y no
      // debe confundirse con el producto.
      const aviso = env.skillsSimuladas && !entregaDirecta
        ? '\n\nESTE SERVIDOR ESTÁ EN MODO DE PRUEBA. Los capítulos responden, pero con ' +
          'texto de ejemplo, no con el método real. Adviértelo antes de trabajar nada.'
        : publicados.length === 0
          ? '\n\nNINGÚN capítulo está publicado todavía. No es nada que haya hecho ' +
            'el usuario ni le falte configurar: es que Acosta | IA & Research aún no los ' +
            'ha activado en el servidor. No sugieras soluciones al usuario ni le pidas datos.'
          : '';

      return texto(
        `${perfil.tipo === 'informe' ? 'Ruta del informe' : 'Método de tesis'} — Acosta | IA & Research\n\n${lineas.join('\n\n')}${aviso}\n\n` +
          'Para trabajar un capítulo usa la herramienta "redactar" con la clave correspondiente.',
      );
    },
  );

  // ── Estado de la licencia ────────────────────────────────────────────────
  server.registerTool(
    'estado_licencia',
    {
      title: 'Estado de la licencia',
      description: 'Muestra a nombre de quién está esta licencia y cuánto se ha usado.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'estado_licencia' });

      const uso = await licenseService.usageSummary(licencia);
      const caduca = licencia.expiresAt
        ? `Caduca el ${licencia.expiresAt.toISOString().slice(0, 10)}.`
        : 'Sin fecha de caducidad.';

      // El cupo solo se menciona si existe: decirle «0 de 0» a quien no tiene
      // tope no informa de nada y preocupa. La redacción vive en
      // `license.limits` porque es donde está el porqué, y porque así se puede
      // probar sin levantar medio servidor.
      const cupo = licenseService.describirCupo(uso);

      // El titular de un conector de prueba es de relleno: su correo no existe
      // y enseñarlo solo haría pensar que alguien se equivocó de cuenta.
      const titular = licencia.user.trialLink
        ? `Conector de prueba de «${licencia.user.trialLink.name}».`
        : `Licencia activa a nombre de ${licencia.user.firstName} (${licencia.user.email}).`;

      return texto(
        `${titular}\n` +
          `Producto: ${licencia.productCode}\n` +
          // En una prueba ese total mezcla lo que no gasta cupo, y al lado de
          // «5 consultas cada día» se lee como que ya se pasó. El cupo lo dice.
          (esPrueba ? '' : `Consultas realizadas en total: ${licencia.callsTotal}\n`) +
          (cupo.length > 0 ? `${cupo.join('\n')}\n` : '') +
          `${caduca}\n\n` +
          'Esta licencia es individual. Compartir la URL del conector puede provocar su revocación.',
      );
    },
  );

  // ── La memoria del proyecto ──────────────────────────────────────────────
  //
  // Estas dos son la diferencia entre un conector que contesta y uno que
  // acompaña una tesis. Van fuera de cualquier condición: no dependen de que
  // haya corpus, ni de cómo se entregue el método.

  server.registerTool(
    'mi_proyecto',
    {
      title: 'Por dónde va su tesis',
      description:
        'El panorama del proyecto del tesista: su tema, su universidad, en qué punto está ' +
        'cada capítulo y cuál le toca. LLÁMALA AL EMPEZAR CUALQUIER CONVERSACIÓN NUEVA, ' +
        'antes de preguntarle nada. Si ya lo sabemos, preguntárselo otra vez es hacerle ' +
        'repetir lo que ya contó. Lo ACORDADO en un capítulo no viene aquí: eso se pide ' +
        'con "ver_capitulo".',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'mi_proyecto' });

      const panorama = await projectService.resumen(licencia.user.id, licencia.productCode);
      // Un documento subido para citar no es avance de capítulos: se dice aparte,
      // y también a quien no tiene nada más guardado.
      const subido = await documentoService
        .aviso(licencia.user.id, licencia.productCode)
        .catch(() => null);

      if (!panorama && subido) return texto(subido);

      if (!panorama) {
        return texto(
          'Todavía no hay nada guardado de este proyecto.\n\n' +
            'Según vayáis fijando cosas —el tema, los objetivos, la metodología— guárdalas ' +
            'con "guardar_avance". No lo dejes para el final de la conversación: si se corta, ' +
            'se pierde, y el tesista tendrá que contarlo todo otra vez.',
        );
      }

      // Debajo del panorama, nunca delante: primero dónde está, luego qué más
      // puede hacer en la web. Si falla, el panorama sale igual.
      const consejo = await consejos
        .consejoPara({ userId: licencia.user.id, productCode: licencia.productCode })
        .catch((error) => {
          logger.error({ err: error, licenseId: licencia.id }, 'No se pudo preparar el consejo');
          return null;
        });

      const conDocumento = subido ? `${panorama}\n\n${subido}` : panorama;
      return texto(consejo ? `${conDocumento}\n\n───────────\n\n${consejo}` : conDocumento);
    },
  );

  server.registerTool(
    'ver_capitulo',
    {
      title: 'Lo acordado en un capítulo',
      description:
        'Lo que quedó decidido en UN capítulo: los campos ya fijados, los que faltan y lo ' +
        'que necesita de capítulos anteriores. ÚSALA ANTES DE PREGUNTARLE NADA sobre un ' +
        'capítulo: "mi_proyecto" da el panorama y esta da el detalle. ' +
        'Con "texto": true devuelve en cambio el TEXTO GUARDADO del capítulo, por partes: ' +
        'LÉELO cuando un capítulo se escribe sobre otro —la Discusión sobre los Resultados, las ' +
        'Conclusiones sobre todo lo anterior— en vez de pedirle al tesista que lo pegue.',
      inputSchema: ESQUEMA_VER_CAPITULO,
    },
    async ({ capitulo, texto: conTexto, parte }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'ver_capitulo' });

      // Mismo filtro que en guardar_capitulo: leer el acuerdo de un capítulo
      // que no es de esta licencia es leer el proyecto de otro método.
      // Las secciones aparte del informe (resumen, introducción) no están en el
      // catálogo, pero se leen como un capítulo. En tesis y artículo no hay.
      const aparte = await projectService.seccionDelDocumento(licencia.user.id, licencia.productCode, capitulo);
      const skill = aparte ?? (await skillService.findByCode(capitulo));
      if (!skill || (!aparte && !skillService.perteneceAlGrupo(skill, licencia.productCode))) {
        return texto(
          `No existe ningún capítulo con la clave "${capitulo}". ` +
            'Usa mi_proyecto para ver las claves válidas.',
        );
      }

      // El texto guardado, cuando se pide. Es lo que Claude necesita para
      // escribir un capítulo sobre otro sin que el tesista tenga que pegarlo.
      if (conTexto) {
        const leido = await projectService.textoDeCapitulo(
          licencia.user.id,
          licencia.productCode,
          capitulo,
          { parte },
        );
        if (!leido) {
          return texto(
            `Ya no se puede consultar «${skill.displayName}» con esta licencia. ` +
              'Usa mi_proyecto para ver los capítulos disponibles.',
          );
        }
        if (leido.vacio) {
          return texto(
            `«${skill.displayName}» todavía no tiene texto guardado. Si el tesista lo escribió ` +
              'fuera de la plataforma, pídele que lo pegue; si se redactó en otra conversación y ' +
              'no se guardó, guárdalo antes con "guardar_capitulo".',
          );
        }

        const sigue =
          leido.parte < leido.partes
            ? `SIGUE: pide "parte": ${leido.parte + 1} para leer el resto.`
            : 'Es el final del capítulo.';
        return texto(
          `Texto guardado de «${skill.displayName}» · parte ${leido.parte} de ${leido.partes} · ` +
            `${leido.palabras} palabras en total.${N}${N}${leido.texto}${N}${N}${sigue}${N}${N}` +
            'Está tal como se guardó: las citas van con su clave [AR…] y las tablas en su bloque. ' +
            'Úsalo para leer lo ya escrito. NO lo vuelvas a guardar con cambios que el tesista ' +
            'no haya pedido.',
        );
      }

      if (aparte) {
        return texto(
          `«${skill.displayName}» es una sección aparte: no tiene campos que fijar. ` +
            'Pide "texto": true para leer lo que tiene guardado.',
        );
      }

      const detalle = await projectService.detalleDeCapitulo(
        licencia.user.id,
        licencia.productCode,
        capitulo,
      );

      // Solo se llega aquí si el capítulo dejó de ser de esta licencia entre
      // la comprobación de arriba y la lectura. Un capítulo que existe pero
      // todavía no tiene nada guardado SÍ devuelve detalle: sus campos en
      // blanco son justo lo que hay que ir preguntándole al tesista.
      if (!detalle) {
        return texto(
          `Ya no se puede consultar «${skill.displayName}» con esta licencia. ` +
            'Usa mi_proyecto para ver los capítulos disponibles.',
        );
      }

      return texto(detalle);
    },
  );

  server.registerTool(
    'guardar_avance',
    {
      title: 'Recordar lo que quedó decidido',
      description:
        'Guarda en el servidor lo que se ha acordado, para que siga estando la próxima vez ' +
        'aunque sea en otra conversación. Úsala EN CUANTO se fije algo —el tema, los ' +
        'objetivos, la población, el diseño—, no al terminar. Guarda lo acordado en dos o ' +
        'tres frases, nunca el texto del capítulo.',
      inputSchema: perfil.tipo === 'informe' ? ESQUEMA_GUARDAR_AVANCE_INFORME : ESQUEMA_GUARDAR_AVANCE,
    },
    async (entrada) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'guardar_avance' });

      // Guardar el avance de un capítulo que no es suyo escribiría en la
      // memoria del proyecto una clave que después nadie sabe interpretar.
      if (entrada.capitulo) {
        const skill = await skillService.findByCode(entrada.capitulo);
        if (!skill || !skillService.perteneceAlGrupo(skill, licencia.productCode)) {
          return texto(
            `No existe ningún capítulo con la clave "${entrada.capitulo}". ` +
              'Usa listar_capitulos para ver las claves válidas. No se ha guardado nada.',
          );
        }
      }

      try {
        const { etapa, camposGuardados } = await projectService.guardarAvance({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          ...entrada,
        });

        const guardado = [];
        if (entrada.tema) guardado.push('el tema');
        if (entrada.carrera) guardado.push('la carrera');
        if (entrada.universidad) guardado.push('la universidad');
        if (entrada.informe) guardado.push('la ficha del informe');
        if (entrada.estiloCitas) {
          guardado.push(`la norma de citas (${normas.normaDe(entrada.estiloCitas).nombre})`);
        }
        if (entrada.idiomaCitas) {
          guardado.push(`el idioma de las citas (${normas.idiomaDe(entrada.idiomaCitas).nombre})`);
        }
        if (etapa) {
          guardado.push(
            `el capítulo ${etapa.skillCode}` +
              (etapa.estado === 'LISTO' ? ', que queda dado por bueno' : ''),
          );
        }
        // Se dice CUÁLES se guardaron, no cuántos. Si el asistente mandó un
        // campo con otro nombre, así lo ve en vez de dar por hecho que entró.
        if (camposGuardados?.length > 0) guardado.push(camposGuardados.join(', '));

        return texto(
          guardado.length > 0
            ? `Guardado: ${guardado.join(', ')}. Estará aquí la próxima vez que abra una conversación.`
            : 'No mandaste nada que guardar.',
        );
      } catch (error) {
        // Un fallo al guardar no puede parecer un éxito: el asistente daría por
        // recordado algo que se perdió, y nadie lo sabría hasta semanas después.
        logger.error(
          { err: error, licenseId: licencia.id },
          'No se pudo guardar el avance del proyecto',
        );
        return texto(
          'No se pudo guardar eso: ' +
            (error?.issues?.[0]?.message ?? 'error del servidor') +
            '. Vuelve a intentarlo; si insiste, sigue trabajando y avísale de que este ' +
            'avance no ha quedado guardado.',
        );
      }
    },
  );

  server.registerTool(
    'guardar_capitulo',
    {
      title: 'Guardar el capítulo escrito',
      description:
        'Guarda el texto de un capítulo en el servidor, para que el tesista se lo pueda ' +
        'descargar en Word con todos los demás, en orden y con su portada. ' +
        'GUÁRDALO EN CUANTO el tesista dé por bueno lo redactado, sin que te lo pida: no ' +
        'sabe que esto existe, y lo que no se guarde aquí lo tendrá que copiar y pegar él. ' +
        'Manda el texto limpio, sin comentarios tuyos.',
      inputSchema: perfil.tipo === 'informe' ? ESQUEMA_GUARDAR_CAPITULO_INFORME : ESQUEMA_GUARDAR_CAPITULO,
    },
    async (entrada) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'guardar_capitulo' });

      const aparte = await projectService.seccionDelDocumento(
        licencia.user.id,
        licencia.productCode,
        entrada.capitulo,
      );
      const skill = aparte ?? (await skillService.findByCode(entrada.capitulo));
      if (!skill || (!aparte && !skillService.perteneceAlGrupo(skill, licencia.productCode))) {
        return texto(
          `No existe ningún capítulo con la clave "${entrada.capitulo}". ` +
            'Usa listar_capitulos para ver las claves del método, y mi_proyecto para las de los ' +
            'capítulos propios de su facultad. No se ha guardado nada.',
        );
      }

      try {
        const { palabras } = await projectService.guardarCapitulo({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          ...entrada,
        });

        return texto(
          `Guardado. «${skill.displayName}» lleva ${palabras} palabras.\n\n` +
            `Dile que ya puede descargar ${SU_OBRA} en Word desde su panel, en ` +
            'acostaresearch.com/perfil, y que sale con todos los capítulos que llevéis.',
        );
      } catch (error) {
        logger.error(
          { err: error, licenseId: licencia.id },
          'No se pudo guardar el texto del capítulo',
        );
        // Decirle «guardado» cuando no se guardó sería lo peor que puede pasar
        // aquí: el tesista cerraría la conversación creyendo que su capítulo
        // está a salvo.
        return texto(
          'NO se pudo guardar: ' +
            (error?.issues?.[0]?.message ?? 'error del servidor') +
            '. AVÍSALE de que este capítulo no ha quedado guardado en el servidor y que ' +
            'no cierre la conversación sin copiarlo.',
        );
      }
    },
  );

  /**
   * La estructura de capítulos que exige su facultad.
   *
   * Solo en la tesis: es donde hay reglamento. Un artículo lo estructura la
   * revista y un informe, el docente, y para esos dos el método ya encaja.
   *
   * No entra en `guardar_avance` a propósito. Ahí van datos sueltos que se
   * corrigen sin consecuencias; esto REORDENA el documento entero, y tiene que
   * costar una llamada aparte, con su confirmación y su respuesta enseñando
   * cómo queda.
   */
  if (perfil.tipo === 'tesis') {
    server.registerTool(
      'estructura_de_la_tesis',
      {
        title: 'Los capítulos que pide su facultad',
        description:
          'Fija CÓMO SE NUMERAN Y SE LLAMAN los capítulos en el Word, cuando el reglamento de ' +
          'su facultad no coincide con el método. El método numera III Metodología, IV ' +
          'Resultados y V Discusión; hay universidades que meten un III de Hipótesis y corren ' +
          'las demás, o que juntan Resultados y Discusión en un solo capítulo. ' +
          'ÚSALA cuando el tesista diga que su reglamento pide otra estructura, o cuando al ' +
          'mirar su formato veas que no cuadra. NO la uses por tu cuenta ni supongas la ' +
          'estructura por la universidad: PÍDESELA y repítesela para que la confirme ANTES de ' +
          'guardarla, porque reordena su documento entero. ' +
          'Manda SIEMPRE la lista completa de capítulos, en orden: lo que mandes sustituye a lo ' +
          'que hubiera. Una fase con texto que no nombres sale igual, al final del Word.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            capitulos: {
              type: 'array',
              minItems: 1,
              maxItems: 24,
              description:
                'Los capítulos del documento, EN ORDEN, tal como los quiere su facultad.',
              items: {
                type: 'object',
                properties: {
                  titulo: {
                    type: 'string',
                    maxLength: 120,
                    description:
                      'Cómo se titula en el Word, con su numeración tal cual la pide el ' +
                      'reglamento: «CAPÍTULO IV: METODOLOGÍA», «Capítulo V. Resultados y discusión».',
                  },
                  de: {
                    type: 'array',
                    items: { type: 'string' },
                    maxItems: 4,
                    description:
                      'Las claves de las fases del método de las que sale su texto, en orden ' +
                      '(«metodologia»; o «analisis-datos-rstudio» y «discusion» para juntar ' +
                      'Resultados y Discusión en un capítulo). Cada fase va en un capítulo y solo ' +
                      'en uno. DÉJALO VACÍO si es un capítulo que el método no tiene, como ' +
                      'Hipótesis: el servidor le dará su propia clave para guardar su texto.',
                  },
                },
                required: ['titulo'],
              },
            },
            quitar: {
              type: 'boolean',
              description:
                'Manda true, y nada más, para volver a la numeración del método. El texto ' +
                'guardado no se toca.',
            },
          },
        }),
      },
      async (entrada) => {
        await licenseService.recordUsage({ licenseId: licencia.id, tool: 'estructura_de_la_tesis' });

        if (entrada?.quitar === true) {
          const habia = await projectService.quitarEsquema({
            userId: licencia.user.id,
            productCode: licencia.productCode,
          });
          return texto(
            habia
              ? 'Hecho: su Word vuelve a salir con los capítulos del método. El texto que tenía ' +
                  'guardado sigue ahí, incluido el de los capítulos propios de su facultad.'
              : 'No había ninguna estructura propia guardada: su Word ya sale con la del método.',
          );
        }

        try {
          const { esquema, catalogo, sobrantes, huerfanos } = await projectService.guardarEsquema({
            userId: licencia.user.id,
            productCode: licencia.productCode,
            capitulos: entrada?.capitulos,
          });

          const nombreDe = new Map(catalogo.map((s) => [s.code, s.displayName]));
          const lineas = esquema.capitulos.map((c, i) => {
            const origen = c.clave
              ? `capítulo propio de su facultad · guarda su texto con la clave "${c.clave}"`
              : c.de.map((f) => nombreDe.get(f) ?? f).join(' + ');
            return `${i + 1}. ${c.titulo}\n     ← ${origen}`;
          });

          const avisos = [];
          if (sobrantes.length > 0) {
            avisos.push(
              'NO has nombrado estas fases, que tienen texto guardado: ' +
                `${sobrantes.map((s) => s.displayName).join(', ')}. Saldrán igual, al FINAL del ` +
                'Word y con su nombre del método. Si van dentro de algún capítulo, vuelve a ' +
                'mandar la estructura entera con ellas en su sitio.',
            );
          }
          if (huerfanos.length > 0) {
            avisos.push(
              'Estos capítulos propios ya no están en la estructura, pero su texto sigue ' +
                `guardado: ${huerfanos.join(', ')}. No saldrá en el Word mientras no los vuelvas ` +
                'a incluir.',
            );
          }

          return texto(
            `Guardada. Su Word sale así:${N}${N}${lineas.join(N)}${N}${N}` +
              (avisos.length > 0 ? `${avisos.join(`${N}${N}`)}${N}${N}` : '') +
              'Nómbrale los capítulos así de ahora en adelante. Las claves para guardar y leer ' +
              'NO cambian: siguen siendo las del método, salvo las de los capítulos propios.',
          );
        } catch (error) {
          if (error instanceof esquemaDeCapitulos.EsquemaNoValido) {
            return texto(`NO se ha guardado: ${error.message}`);
          }
          logger.error(
            { err: error, licenseId: licencia.id },
            'No se pudo guardar la estructura de capítulos',
          );
          return texto(
            'NO se ha guardado la estructura: error del servidor. Su Word sigue saliendo con ' +
              'los capítulos del método.',
          );
        }
      },
    );
  }

  server.registerTool(
    'continuar',
    {
      title: 'Seguir por donde toca',
      description:
        'Abre el capítulo que le toca al tesista, sin tener que saber su clave. ' +
        'ÚSALA cuando diga «sigamos», «¿qué sigue?», «continuemos con la tesis» o cualquier ' +
        'cosa parecida. Es el camino normal: "redactar" con una clave concreta es para ' +
        'cuando quiere saltar a un capítulo determinado.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'continuar' });

      const siguiente = await projectService.siguientePaso(
        licencia.user.id,
        licencia.productCode,
      );

      if (!siguiente) {
        return texto(
          `Tiene todos los capítulos dados por buenos. Si quiere revisar ${SU_OBRA} antes de ` +
            `${perfil.entregarla}, usa "${perfil.revision}".`,
        );
      }

      const falta = await projectService.loQueFalta(
        licencia.user.id,
        licencia.productCode,
        siguiente.code,
      );

      return texto(
        `Le toca: ${siguiente.displayName}\n\n` +
          (falta ? `${falta}\n\n` : '') +
          `Ábrelo con "redactar" y la clave ${siguiente.code}. ` +
          'Díselo antes de empezar, para que sepa en qué punto está.',
      );
    },
  );

  server.registerTool(
    'guardar_analisis',
    {
      title: 'Guardar el análisis y sus cifras',
      description:
        'Guarda el script de R, lo que devolvió la consola y las cifras obtenidas. ' +
        'Si el análisis lo corriste tú con "trabajar_en_r", el script y la salida YA ESTÁN ' +
        'guardados: usa esta herramienta solo para las cifras. Si el tesista lo corrió en su ' +
        'propio RStudio y te pega el resultado, guárdalo EN CUANTO te lo pegue.\n\n' +
        'Por qué importa: a partir de ese momento, cualquier cifra que aparezca en el ' +
        'capítulo de resultados y no esté entre las guardadas sale marcada en el repaso. ' +
        'Es lo que impide que un número se escriba solo porque ahí pegaba un número.',
      inputSchema: ESQUEMA_GUARDAR_ANALISIS,
    },
    async ({ capitulo, script, salida, resultados, reemplazar }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'guardar_analisis' });

      const skill = await skillService.findByCode(capitulo);
      if (!skill || !skillService.perteneceAlGrupo(skill, licencia.productCode)) {
        return texto(
          `No existe ningún capítulo con la clave "${capitulo}". ` +
            'Usa listar_capitulos para ver las claves válidas. No se ha guardado nada.',
        );
      }

      try {
        const { escritos, cifras } = await projectService.guardarAnalisis({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          capitulo,
          script,
          salida,
          resultados,
          reemplazar,
        });

        const partes = [];
        if (escritos.includes('script')) partes.push('el script');
        if (escritos.includes('salida')) partes.push('la salida de la consola');

        const lineas = [];
        if (cifras) {
          if (cifras.nuevas > 0) partes.push(`${cifras.nuevas} cifras nuevas`);
          if (cifras.repetidas > 0) {
            lineas.push(`${cifras.repetidas} ya estaban guardadas y no se duplicaron.`);
          }
          if (cifras.sustituidas > 0) {
            lineas.push(`Sustituyen a las ${cifras.sustituidas} que había, como pediste.`);
          }
          lineas.push(`En total hay ${cifras.lista.length} cifras guardadas en este capítulo.`);

          // Lo que no cabe se dice con nombre y apellido. Callarlo fue el
          // defecto: el asistente mandaba 37, se guardaban 8, y creía que 37.
          if (cifras.fuera.length > 0) {
            lineas.push(
              `NO SE GUARDARON ${cifras.fuera.length}: el máximo es ${cifras.maximo} por ` +
                `capítulo. Quedaron fuera: ${cifras.fuera.join(' | ')}. ` +
                'AVÍSALE al tesista. Si no van al texto no hace falta guardarlas; si van, ' +
                'hay que dejarles sitio.',
            );
          }
        }

        if (partes.length === 0 && lineas.length === 0) return texto('No mandaste nada que guardar.');

        const hayCifras = Boolean(cifras && cifras.lista.length > 0);
        return texto(
          `Guardado: ${partes.length > 0 ? partes.join(', ') : 'nada nuevo'}.` +
            (lineas.length > 0 ? `\n${lineas.join('\n')}` : '') +
            '\n\n' +
            (hayCifras
              ? 'A partir de ahora, cualquier número del capítulo de resultados que no esté ' +
                'entre esas cifras saldrá marcado en el repaso. Si vas a escribir uno que ' +
                'falte, guárdalo antes: se suma a las que ya hay.'
              : 'No guardaste ninguna cifra. Sin ellas no se puede comprobar que los números ' +
                'del texto salgan del análisis, que es de lo que más se aprovecha aquí.'),
        );
      } catch (error) {
        logger.error({ err: error, licenseId: licencia.id }, 'No se pudo guardar el análisis');
        return texto(
          'NO se pudo guardar el análisis. AVÍSALE al tesista de que no ha quedado guardado ' +
            'y de que no cierre la conversación sin copiar su script.',
        );
      }
    },
  );

  server.registerTool(
    'ver_analisis',
    {
      title: 'Leer el análisis del tesista',
      description:
        'El análisis de R guardado en el proyecto: lo que corriste con "trabajar_en_r" o lo ' +
        'que el tesista trajo de su RStudio. LLÁMALA ANTES DE REDACTAR LOS ' +
        'RESULTADOS y cada vez que diga que ya corrió su análisis: cada cifra del capítulo ' +
        'tiene que salir de aquí.\n\n' +
        'SIN ARGUMENTOS devuelve el índice: qué pruebas hay en la consola y en qué líneas. ' +
        'EL ÍNDICE NO CONTIENE LAS CIFRAS, solo dice dónde están. No redactes ningún número ' +
        'a partir del índice: pide su bloque —ver_analisis(bloque: "alfa")— y léelo. ' +
        '"script" da el guion de R y "todo" la consola entera.\n\n' +
        'Después guarda con "guardar_analisis" (campo resultados) las cifras que vayas a ' +
        'usar en el texto. Sin eso, el repaso no puede comprobar que ningún número se ' +
        'escribió solo.',
      inputSchema: ESQUEMA_VER_ANALISIS,
    },
    async ({ capitulo, bloque, desde, hasta }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'ver_analisis' });

      // Una clave de otro método leería un archivo que no es de este proyecto.
      if (capitulo) {
        const skill = await skillService.findByCode(capitulo);
        if (!skill || !skillService.perteneceAlGrupo(skill, licencia.productCode)) {
          return texto(
            `No existe ningún capítulo con la clave "${capitulo}". Déjala vacía para el de ` +
              'resultados, o usa listar_capitulos para ver las claves válidas.',
          );
        }
      }

      // Defensa en tiempo de ejecución aunque el esquema ya sea un enum: el
      // esquema lo valida el cliente, y la autoridad es el servidor.
      if (bloque !== undefined && bloque !== 'script' && bloque !== 'todo') {
        if (!bloquesDeAnalisis.definicionDe(bloque)) {
          return texto(
            `"${bloque}" no es un bloque de análisis. Los que existen son: ` +
              `${bloquesDeAnalisis.claves().join(', ')}, más "script" y "todo".`,
          );
        }
      }

      const respuesta = await projectService.consultarAnalisis(
        licencia.user.id,
        licencia.productCode,
        { capitulo, bloque, desde, hasta },
      );

      if (!respuesta) {
        return texto(
          'Todavía no hay ningún análisis guardado. Córrelo tú con "trabajar_en_r": pregúntale ' +
            'por sus variables y su hipótesis, y la herramienta le da el enlace para subir sus ' +
            'datos. Si ya lo hizo en su RStudio, que te pegue el script y la salida.',
        );
      }

      return texto(respuesta);
    },
  );

  server.registerTool(
    'revisar_evidencia',
    {
      title: 'Qué sostiene cada afirmación',
      description:
        'Repasa lo que el tesista lleva escrito y dice qué afirmaciones tienen fuente y ' +
        'cuáles no. ÚSALA ANTES DE REDACTAR LA DISCUSIÓN: ahí es donde se contrasta lo ' +
        'encontrado con la literatura, y contrastarlo de memoria es como se cuelan los ' +
        'autores que no dijeron eso. También sirve como repaso antes de entregar. ' +
        'Sin argumentos revisa todo; con "capitulo", solo ese.',
      inputSchema: ESQUEMA_REVISAR_EVIDENCIA,
    },
    async ({ capitulo }) => {
      const cupo = await cupoDePrueba('revisar_evidencia');
      if (cupo.bloqueo) return cupo.bloqueo;
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'revisar_evidencia' });

      const informe = await projectService.revisarEvidencia(
        licencia.user.id,
        licencia.productCode,
        { capitulo: capitulo || null },
      );

      if (!informe) {
        return texto(
          'Todavía no hay ningún capítulo escrito que revisar. ' +
            'Guarda lo redactado con "guardar_capitulo" y vuelve a intentarlo.',
        );
      }

      const bloques = [];

      for (const c of informe.capitulos) {
        const lineas = [`── ${c.titulo}`];

        lineas.push(`   Con fuente: ${c.conRespaldo.length} afirmaciones.`);

        // Las citas escritas a mano van PRIMERO, aunque sean menos. Son las
        // graves: parecen respaldadas y no lo están, así que ni el tesista ni
        // el jurado tienen motivo para mirarlas dos veces.
        if (c.citasAMano.length > 0) {
          lineas.push('', `   CITAS SIN ENLAZAR (${c.citasAMano.length}) — revísalas una a una:`);
          for (const a of c.citasAMano) lineas.push(`     · ${a.frase}`);
        }

        if (c.sinRespaldo.length > 0) {
          lineas.push('', `   AFIRMACIONES SIN FUENTE (${c.sinRespaldo.length}):`);
          for (const a of c.sinRespaldo) lineas.push(`     · ${a.frase}`);
        }

        bloques.push(lineas.join('\n'));
      }

      const t = informe.total;
      const cierre =
        t.citasAMano > 0
          ? '\n\nLAS CITAS SIN ENLAZAR SON LO PRIMERO. Están escritas como «(Autor, año)» pero ' +
            'no salen de ninguna ficha del servidor, así que nadie ha comprobado que existan. ' +
            'Busca cada una con "buscar_fuentes": si aparece, cámbiala por su clave entre ' +
            'corchetes y vuelve a guardar el capítulo. SI NO APARECE, DÍSELO AL TESISTA: puede ' +
            'que esa referencia no exista, y un DOI que no lleva a ninguna parte lo comprueba ' +
            'un jurado en diez segundos.'
          : t.sinRespaldo > 0
            ? '\n\nPara cada afirmación sin fuente: o le buscas una con "buscar_fuentes", o la ' +
              'reescribes para que no afirme más de lo que podéis sostener. No la dejes como ' +
              'está.'
            : '\n\nTodo lo que afirma algo tiene de dónde agarrarse.';

      return texto(
        `Revisión de lo escrito:\n\n${bloques.join('\n\n')}\n\n` +
          `Total: ${t.conRespaldo} con fuente · ${t.sinRespaldo} sin fuente · ` +
          `${t.citasAMano} citas sin enlazar.${cierre}\n\n` +
          'Esto dice si una afirmación tiene de dónde agarrarse. NO dice si es cierta, ni si ' +
          'la fuente dice lo que la frase le atribuye: eso hay que leerlo.',
      );
    },
  );

  server.registerTool(
    perfil.revision,
    {
      title: 'Repaso antes de entregar',
      description:
        perfil.tipo === 'informe'
          ? 'Coteja el informe consigo mismo y devuelve lo que no cuadra: secciones dadas por ' +
            'buenas sin texto, citas rotas y afirmaciones sin fuente. ÚSALA CUANDO EL ESTUDIANTE ' +
            'VAYA A ENTREGAR, y ofrécesela tú al cerrar. Después repasa TÚ, criterio por criterio, ' +
            'la rúbrica que sale en su ficha de "mi_proyecto": esta herramienta no la conoce.'
          : `Coteja ${perfil.laObra} consigo mismo y devuelve lo que no cuadra: capítulos dados por ` +
            'buenos sin texto, variables que no aparecen en ningún objetivo, objetivos sin ' +
            'conclusión, citas rotas y afirmaciones sin fuente. ' +
            'ÚSALA CUANDO EL TESISTA VAYA A ENTREGAR, y ofrécesela tú si ves que está cerrando ' +
            'capítulos: nadie sabe que esto existe y es lo último que se revisa a mano.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      const cupo = await cupoDePrueba('revisar_la_tesis');
      if (cupo.bloqueo) return cupo.bloqueo;
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'revisar_la_tesis' });

      const informe = await projectService.auditar(licencia.user.id, licencia.productCode);

      if (!informe) {
        return texto(
          'Todavía no hay proyecto que revisar. Esto se usa cuando ya hay capítulos escritos.',
        );
      }

      const partes = [];

      if (informe.hallazgos.length === 0) {
        partes.push('No he encontrado nada que no cuadre.');
      } else {
        // Lo grave primero. Un listado donde lo importante está en la posición
        // catorce es un listado que se lee hasta la cuarta.
        const graves = informe.hallazgos.filter((h) => h.nivel === 'grave');
        const avisos = informe.hallazgos.filter((h) => h.nivel === 'aviso');

        if (graves.length > 0) {
          partes.push(`HAY QUE ARREGLAR (${graves.length}):`);
          partes.push(graves.map((h) => `  · ${h.mensaje}`).join('\n'));
        }
        if (avisos.length > 0) {
          partes.push(`\nPARA MIRAR (${avisos.length}):`);
          partes.push(avisos.map((h) => `  · ${h.mensaje}`).join('\n'));
        }
      }

      partes.push(`\nCapítulos con texto guardado: ${informe.escritos}.`);
      if (informe.sinEscribir.length > 0) {
        partes.push(`Sin escribir todavía: ${informe.sinEscribir.join(', ')}.`);
      }

      return texto(
        `Repaso de ${perfil.tuObra}:\n\n${partes.join('\n')}\n\n` +
          'LO QUE ESTE REPASO NO MIRA, y hay que mirar aparte: si los números del texto ' +
          'cuadran con los de las tablas, y si cada fuente dice de verdad lo que la frase le ' +
          'atribuye. Ninguna de las dos cosas se puede comprobar sin leer. ' +
          'Y nada de lo de arriba es una sentencia: puede haber buenas razones para todo. ' +
          'Repásalo con el tesista en vez de cambiarlo por tu cuenta.',
      );
    },
  );

  // ── Redacción de un capítulo ─────────────────────────────────────────────
  server.registerTool(
    'redactar',
    {
      title: 'Trabajar un capítulo',
      description:
        'Trabaja un capítulo de la tesis con el método de Acosta | IA & Research, y abre ' +
        'también las herramientas de apoyo de esta licencia: van por el mismo "capitulo", con ' +
        'su clave del catálogo. Envía lo que el tesista quiere hacer o responder, y devuelve el ' +
        'siguiente paso. Es una conversación: manda el mismo "sesion" en cada llamada del mismo ' +
        'hilo.\n\n' +
        'Las herramientas de apoyo NO esperan a que la tesis esté terminada: se abren en cuanto ' +
        'él tiene lo que piden —un informe de similitud y su documento, un texto que suena a IA, ' +
        'un capítulo que quiere pulir—, aunque esté a mitad de otra cosa. Qué hace cada una y ' +
        'qué le pide, en "listar_capitulos".',
      inputSchema: ESQUEMA_REDACTAR,
    },
    async ({ capitulo, mensaje, sesion, referencia, paso }) => {
      const inicio = Date.now();

      // ── 1. Filtro de intención ───────────────────────────────────────────
      // Va lo primero: un intento de extracción no debe llegar a gastar cupo
      // ni a tocar la base de datos del catálogo.
      const intencion = analizarIntencion(mensaje);
      if (intencion.sospechoso) {
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `redactar:${capitulo}`,
          prompt: mensaje,
          sessionId: sesion,
          ok: false,
          kind: 'EXTRACTION_ATTEMPT',
          durationMs: Date.now() - inicio,
        });
        logger.warn(
          { licenseId: licencia.id, patrones: intencion.patrones },
          'Intento de extracción bloqueado',
        );
        return texto(RESPUESTA_RECHAZO);
      }

      const skill = await skillService.findByCode(capitulo);

      // Un capítulo de otro grupo se trata como inexistente, no como prohibido.
      // Que no salga en la lista no impide pedirlo por su clave, y la clave no
      // es ningún secreto; decir «no tienes acceso a ese» sería confirmarle a
      // quien va probando que ahí hay algo que comprar.
      const suyo = skill && skillService.perteneceAlGrupo(skill, licencia.productCode);

      if (!skill || !skill.active || !suyo) {
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: 'redactar',
          ok: false,
          durationMs: Date.now() - inicio,
        });
        return texto(
          `No existe ningún capítulo con la clave "${capitulo}". ` +
            'Usa listar_capitulos para ver las claves válidas.',
        );
      }

      /**
       * Registro que NO descuenta cupo.
       *
       * Todas las llamadas se anotan —el detector necesita verlas todas—, pero
       * solo descuenta la que de verdad hace el trabajo. Si el fallo es nuestro
       * (servicio apagado, capítulo sin publicar), sería cobrarle al comprador
       * por nada: gastaría su cuota del día sin recibir una sola línea.
       */
      const anotarSinCobrar = (motivo) =>
        licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `redactar:${skill.code}`,
          prompt: mensaje,
          sessionId: sesion,
          ok: false,
          kind: motivo,
          durationMs: Date.now() - inicio,
        });

      // ── 2. Licencias de entrega: el método viaja, no se ejecuta ──────────
      //
      // No llama a ningún modelo, así que no cuesta nada y no hay coste que
      // descontar. Sí cuenta para el tope diario, que aquí solo hace de freno
      // ante una descarga masiva.
      if (licencia.delivery === 'INSTRUCTIONS') {
        const cupoEntrega = await licenseService.reserveLimits(licencia);
        if (!cupoEntrega.permitido) {
          await anotarSinCobrar('BLOCKED_LIMIT');
          return texto(cupoEntrega.motivo);
        }

        // El servidor recuerda por dónde va, para poder servir el tramo
        // siguiente aunque el asistente no lleve la cuenta.
        const hilo = await sesionDeEntrega(licencia.id, sesion, skill.code);

        let contenido;
        try {
          contenido = referencia
            ? skillDelivery.entregarReferencia({ skill, licencia, nombre: referencia })
            : skillDelivery.entregar({
                skill,
                licencia,
                paso,
                ultimoEntregado: hilo.lastSection,
              });

          if (!referencia) {
            await guardarTramo(hilo.id, skill.code, contenido.numero);
          }
        } catch (error) {
          await licenseService.releaseLimits(cupoEntrega.reserva);
          await anotarSinCobrar('NORMAL');
          logger.error(
            { err: error, licenseId: licencia.id, skill: skill.code },
            'No se pudo entregar el método',
          );
          return texto(
            'No pudimos recuperar ese capítulo ahora mismo. No se te ha descontado nada.',
          );
        }

        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: `entregar:${skill.code}`,
          prompt: mensaje,
          sessionId: sesion,
          durationMs: Date.now() - inicio,
          // Entregar no consume tokens nuestros: el coste va a cero y solo
          // cuenta como consulta.
          costCents: 0,
          // Ya se descontó al reservarla, antes de entregar.
          cupoReservado: true,
        });

        /**
         * La memoria del proyecto viaja con el primer tramo del capítulo.
         *
         * Va aquí y no en una herramienta aparte porque delegar en que el
         * asistente se acuerde de consultarla es exactamente lo que no
         * funciona: no se acuerda, y el tesista cuenta su tema por cuarta vez.
         *
         * Solo en el primero. Repetir el contexto en cada tramo engordaría cada
         * respuesta con lo mismo, y lo que se repite se acaba ignorando.
         */
        const primerTramo = !referencia && !hilo.lastSection;
        if (primerTramo) {
          const [memoria, falta] = await Promise.all([
            projectService.contexto(licencia.user.id, licencia.productCode),
            projectService.loQueFalta(licencia.user.id, licencia.productCode, skill.code),
          ]).catch((error) => {
            // Que falle la memoria no puede dejar sin capítulo a nadie: el
            // método es el producto, esto es la ayuda.
            logger.error(
              { err: error, licenseId: licencia.id },
              'No se pudo leer la memoria del proyecto',
            );
            return [null, null];
          });

          // El aviso va ARRIBA DEL TODO, por delante del método.
          //
          // Quien empieza metodología sin haber fijado su población va a
          // redactar un capítulo III que no cuadra con el I, y hoy nadie se lo
          // dice hasta que se lo dice su asesor. Puesto detrás del método, el
          // asistente ya se ha lanzado a redactar antes de llegar a leerlo.
          // El consejo de la plataforma va al FINAL, detrás del método: la
          // Skill es el producto y se lee primero. Si falla, el capítulo sale.
          const consejo = await consejos
            .consejoPara({
              userId: licencia.user.id,
              productCode: licencia.productCode,
              capitulo: skill.code,
            })
            .catch((error) => {
              logger.error({ err: error, licenseId: licencia.id }, 'No se pudo preparar el consejo');
              return null;
            });

          const partes = [falta, memoria, contenido.texto, consejo].filter(Boolean);
          if (partes.length > 1) return texto(partes.join('\n\n───────────\n\n'));
        }

        return texto(contenido.texto);
      }

      // ── 3. ¿Podemos atenderle siquiera? ──────────────────────────────────
      // Va antes del cupo a propósito: a quien pide un capítulo que aún no
      // existe hay que decírselo, no anunciarle que se quedó sin consultas.
      if (!env.rewriteEnabled) {
        logger.warn('Se pidió redactar sin ANTHROPIC_API_KEY configurada');
        await anotarSinCobrar('NORMAL');
        return texto(
          'La redacción todavía no está activada en el servidor de Acosta | IA & Research. ' +
            'No es un problema del usuario ni de su licencia, y no se arregla reintentando. ' +
            'Comunícaselo tal cual, sin sugerirle pasos ni pedirle datos.',
        );
      }

      if (!skill.anthropicSkillId && !env.skillsSimuladas) {
        await anotarSinCobrar('NORMAL');
        return texto(
          `El capítulo "${skill.displayName}" todavía no está publicado en el servidor de ` +
            'Acosta | IA & Research. No es un fallo del usuario ni le falta configurar nada, ' +
            'y no hay nada que pueda hacer para arreglarlo. Dilo así, sin proponerle soluciones.',
        );
      }

      // ── 4. Topes del plan ────────────────────────────────────────────────
      // Se toma ANTES de gastar tokens, que es lo que cuesta dinero, y en la
      // misma sentencia que lo comprueba: dos llamadas a la vez no pueden
      // llevarse las dos la última consulta del día.
      const cupo = await licenseService.reserveLimits(licencia);
      if (!cupo.permitido) {
        await anotarSinCobrar('BLOCKED_LIMIT');
        return texto(cupo.motivo);
      }

      // ── 5. El trabajo ────────────────────────────────────────────────────
      // La skill se ejecuta AQUÍ, con nuestra clave y contra la Skills API. Sus
      // instrucciones no pasan por el Claude del comprador en ningún momento:
      // de vuelta solo sale el texto redactado.
      let resultado;
      try {
        resultado = await skillRunner.ejecutar({
          licenseId: licencia.id,
          skill,
          mensaje,
          clientKey: sesion,
        });
      } catch (error) {
        // El fallo no lo paga el comprador: se anota y se le devuelve.
        await licenseService.releaseLimits(cupo.reserva);
        await anotarSinCobrar('NORMAL');
        logger.error(
          { err: error, licenseId: licencia.id, skill: skill.code },
          'Falló la ejecución de la skill',
        );

        if (error.codigo === 'REWRITE_REFUSED') {
          return texto(
            'No puedo atender esa petición tal como está planteada. ' +
              'Reformúlala centrándote en tu propio trabajo de tesis.',
          );
        }

        return texto(
          'Hubo un problema al trabajar el capítulo y no se te ha descontado la consulta. ' +
            'Vuelve a intentarlo en un momento.',
        );
      }

      // Salió bien: ahora sí se descuenta, con el coste real.
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: `redactar:${skill.code}`,
        prompt: mensaje,
        sessionId: sesion,
        durationMs: resultado.durationMs,
        inputTokens: resultado.inputTokens,
        outputTokens: resultado.outputTokens,
        cachedTokens: resultado.cachedTokens,
        costCents: resultado.costCents,
        cupoReservado: true,
      });

      return texto(resultado.texto);
    },
  );

  // ── Corpus bibliográfico ─────────────────────────────────────────────────
  // Solo existe si hay corpus configurado. Una herramienta anunciada que
  // responde «no hay nada» en cada llamada es peor que no tenerla: el
  // asistente la sigue intentando y el tesista cree que le falta algo por
  // activar.
  if (env.zoteroEnabled) {
    server.registerTool(
      'buscar_fuentes',
      {
        title: 'Buscar fuentes en la biblioteca, su Zotero incluido',
        description:
          'Busca referencias reales y verificadas en DOS bibliotecas a la vez: la de Acosta | ' +
          'IA & Research y LA DEL PROPIO TESISTA, que incluye la colección de SU ZOTERO y la ' +
          'carpeta de SU MENDELEY que conectó desde su perfil en la web, sus exports de Scopus, ' +
          'Web of Science o SciELO y lo que guardó por DOI. ' +
          'SI TE PIDE CITAR DE SU ZOTERO O DE SU MENDELEY, ES AQUÍ: esas fuentes ya están dentro ' +
          'y salen marcadas «de tu Zotero» o «de tu Mendeley». No busques otro conector ni le ' +
          'digas que no tienes acceso. Para ver su lista entera, sin tema, usa "mis_fuentes". ' +
          'ÚSALA SIEMPRE que haga falta citar: antecedentes, marco teórico, metodología o ' +
          'discusión. NO cites de memoria: los datos bibliográficos que no salen de aquí ' +
          'suelen tener el año o el DOI equivocados, y eso lo comprueba un jurado en segundos. ' +
          'EN "tema", EN INGLÉS: la biblioteca de Acosta son artículos indexados en Scopus y ' +
          'Web of Science, con títulos y resúmenes en inglés. El tesista te escribe en español, ' +
          'así que traduce tú el tema antes de buscar («validez de constructo» → «construct ' +
          'validity»). ' +
          'MANDA SIEMPRE "temaOriginal" con el tema en español y "pais" con el del tesista: con ' +
          '"temaOriginal" se busca también en su biblioteca, que suele estar en español, y si no ' +
          'hay nada en ninguna, esta misma herramienta sale al catálogo abierto y no te deja ' +
          'sin fuentes. ' +
          'Las de la biblioteca de Acosta llevan su criterio; las del tesista y las del catálogo ' +
          'abierto no, y la respuesta te lo dirá para que lo adviertas.',
        inputSchema: ESQUEMA_FUENTES,
      },
      async ({ tema, temaOriginal, pais, cuantas }) => {
        const cupo = await cupoDePrueba('buscar_fuentes', tema);
        if (cupo.bloqueo) return cupo.bloqueo;
        await licenseService.recordUsage({
          licenseId: licencia.id,
          tool: 'buscar_fuentes',
          prompt: tema,
        });

        // Mismo filtro que el catálogo de capítulos: cada licencia ve lo suyo.
        // Las fuentes sin producto —la metodología— las ve todo el mundo.
        const fuentes = await referenceService.buscarParaLicencia({
          tema,
          // Para buscar también en español dentro de su biblioteca: su Zotero
          // no está en inglés como el fondo de la casa.
          temaOriginal,
          cuantas,
          productCode: licencia.productCode,
          // Las que subió este tesista de su export de Scopus, además del fondo
          // de la casa. Las de otros compradores NO: el filtro va dentro de la
          // consulta, y este es el único sitio desde donde se le pasa un dueño.
          ownerUserId: licencia.userId,
        });

        // ── Sin nada en la biblioteca: NO se vuelve con las manos vacías ────
        //
        // Antes esto devolvía un muro de instrucciones y cero fuentes. El
        // tesista se quedaba igual que empezó, y lo peor: la salida que le
        // quedaba era que el asistente citara de memoria.
        //
        // Ahora sale al catálogo abierto en la misma llamada. Con las palabras
        // EN ESPAÑOL del tesista, que es lo que encuentra Scielo y Redalyc: el
        // término en inglés que sirve para la biblioteca de la casa no
        // encuentra un artículo peruano publicado en español.
        if (fuentes.length === 0) {
          const enEspanol = (temaOriginal || '').trim() || tema;
          const abierta = await referenceService.buscarEnLaLiteratura({
            tema: enEspanol,
            pais: pais || null,
            cuantas,
          });

          // Que no contestara no es que no haya nada. Decir «tu tema está poco
          // estudiado» porque un servidor ajeno estaba caído mandaría al
          // tesista a escribirlo en su justificación.
          if (abierta.caida) {
            return texto(
              `No hay nada sobre «${tema}» ni en la biblioteca de Acosta ni en la del tesista, ` +
                'y el catálogo abierto no está respondiendo ahora mismo, así que NO SE SABE si ' +
                'hay literatura fuera.\n\n' +
                'DÍSELO AL TESISTA ASÍ: no concluyas que su tema está poco estudiado. Que vuelva ' +
                'a intentar en un rato con "buscar_en_la_literatura", y sigue sin citar ahí.',
            );
          }

          if (abierta.fuentes.length === 0) {
            return texto(
              `No hay nada sobre «${tema}» ni en la biblioteca de Acosta, ni en la del ` +
                `tesista, ni en el catálogo abierto.\n\n` +
                'DÍSELO AL TESISTA TAL CUAL y sigue sin citar ahí. Que su tema esté poco ' +
                'estudiado es un hallazgo que va en la justificación, no un problema que se ' +
                'tape citando de memoria.\n\n' +
                'Y dile que puede traer SUS PROPIAS fuentes desde su perfil en la web: ' +
                'conectando su Zotero o su Mendeley en «Tus herramientas», o subiendo su export de Scopus, Web of ' +
                'Science o SciELO en «Método de tesis → Mis fuentes». Desde ese momento estas ' +
                'búsquedas también leen de ahí. Si ya las trajo, "mis_fuentes" le enseña qué hay.',
            );
          }

          const deFuera = abierta.fuentes.map((f, i) => {
            const lineas = [`${i + 1}. ${f.cita}`];
            const señas = [];
            if (f.citas > 0) señas.push(`citado ${f.citas} veces`);
            if (f.pdfLibre) señas.push('PDF gratis');
            if (f.idioma) señas.push(`en ${f.idioma}`);
            if (señas.length > 0) lineas.push(`   [${señas.join(' · ')}]`);
            if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
            return lineas.join('\n');
          });

          return texto(
            // «Ni en la de Acosta ni en la tuya», no «en la biblioteca»: si el
            // tesista tiene fuentes subidas, tiene derecho a saber que también
            // se miraron las suyas. Y evita que el asistente aprenda que «la
            // biblioteca» significa siempre «la de Acosta», que es de donde
            // salía luego atribuirle a Acosta fuentes que no había revisado.
            avisoDeCrossref(abierta.origen, abierta.filtrosSinAplicar) +
              `No hay nada sobre «${tema}» ni en la biblioteca de Acosta ni en la del tesista ` +
              `—su Zotero y lo que subió—, así que busqué en el catálogo abierto con ` +
              `«${enEspanol}»:` +
              `\n\n${deFuera.join('\n\n')}\n\n` +
              'AVISA DE QUE ESTAS NO ESTÁN REVISADAS POR ACOSTA: vienen de un catálogo ' +
              'abierto donde entra de todo, preprints y repositorios incluidos. El tesista ' +
              'debería comprobar dónde se publicó cada una antes de citarla. ' +
              'Cita EXACTAMENTE como están, sin traducir los títulos.',
          );
        }

        const fichas = fuentes.map((f, i) => {
          // La clave va primero, pegada al número, porque es lo que hay que
          // copiar al texto. Lo que va delante es lo que se copia.
          const lineas = [`${i + 1}. [${f.clave}]  ${f.cita}`];
          // La nota vale más que el resumen: el resumen lo escribió la revista
          // para vender su artículo; la nota la escribió Acosta diciendo para
          // qué sirve la fuente.
          if (f.nota) lineas.push(`   Nota de Acosta: ${f.nota.slice(0, 400)}`);
          else if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
          // De dónde salió. Va en cada ficha y no en un encabezado porque las
          // dos procedencias se mezclan en la misma lista, y el tesista tiene
          // derecho a distinguir las que eligió él de las que le pusimos.
          lineas.push(
            f.deZotero
              ? '   [de tu Zotero]'
              : f.deMendeley
                ? '   [de tu Mendeley]'
                : f.propia
                ? '   [de tu biblioteca]'
                : '   [biblioteca de Acosta · curada]',
          );
          return lineas.join('\n');
        });

        /**
         * De dónde salió el conjunto, dicho en la PRIMERA línea.
         *
         * La marca por ficha —`[de tu biblioteca]`— no basta y se comprobó en
         * uso: el encabezado decía «Fuentes de la biblioteca» y el mensaje de
         * cuando no hay nada dice «la biblioteca de Acosta no tenía…», así que
         * el asistente concluye que «la biblioteca» es la de Acosta y presenta
         * como «revisada por Acosta» una fuente que subió el propio tesista de
         * su export de Scopus.
         *
         * Eso no es un matiz de redacción: le atribuye a una fuente sin revisar
         * la garantía por la que pagó. Se corrige en el encabezado, que es lo
         * que el modelo usa para narrar el conjunto.
         */
        const deSuZotero = fuentes.filter((f) => f.deZotero).length;
        const deSuMendeley = fuentes.filter((f) => f.deMendeley).length;
        const subidas = fuentes.filter((f) => f.propia && !f.deZotero && !f.deMendeley).length;
        const deLaCasa = fuentes.length - deSuZotero - deSuMendeley - subidas;

        const partes = [
          deSuZotero > 0 ? `${deSuZotero} de su Zotero` : null,
          deSuMendeley > 0 ? `${deSuMendeley} de su Mendeley` : null,
          subidas > 0 ? `${subidas} que subió él` : null,
          deLaCasa > 0 ? `${deLaCasa} de la biblioteca de Acosta` : null,
        ].filter(Boolean);

        const procedencia =
          deLaCasa === fuentes.length
            ? 'de la biblioteca curada de Acosta'
            : deLaCasa === 0
              ? `de la biblioteca del PROPIO TESISTA, no de la de Acosta: ${partes.join(' y ')}`
              : partes.join(', ');

        return texto(
          `Fuentes sobre «${tema}» (${procedencia}):\n\n${fichas.join('\n\n')}\n\n` +
            'RESPETA LA PROCEDENCIA DE CADA UNA, que va marcada bajo su ficha. Las que dicen ' +
            '«de tu Zotero», «de tu Mendeley» o «de tu biblioteca» las eligió el tesista: son suyas y NO están revisadas ' +
            'por Acosta, así que no se las presentes como si lo estuvieran. Las que dicen ' +
            '«biblioteca de Acosta» sí pasaron por su criterio, y eso es justo lo que las ' +
            'distingue.\n\n' +
            'CÓMO SE CITAN. Al redactar el capítulo, escribe la clave entre corchetes donde ' +
            'vaya la cita —así: «…afecta al rendimiento [AR97D22F86].»— y guarda el capítulo ' +
            'con esa marca puesta. Al armar el Word, el servidor la cambia por la cita EN LA ' +
            'NORMA DEL PROYECTO —APA, IEEE, Vancouver, Chicago…— y añade la fuente a la lista ' +
            'de referencias, las dos cosas sacadas de la misma ficha. ' +
            'Si el autor va en la frase, añade «:n» —«[AR97D22F86:n] sostienen que…»— y el ' +
            'servidor pondrá «García et al. (2024) sostienen…» o «García et al. [3] sostienen…» ' +
            'según la norma; NO escribas tú el nombre delante. Para una cita textual, la ' +
            'página: «[AR97D22F86:p. 45]». Varias fuentes seguidas, una marca detrás de otra: ' +
            '«[AR97D22F86][AR11112222]». ' +
            'No montes tú la bibliografía ni el Word: salen solos, y así no pueden discrepar ' +
            'de lo que dice el texto. Cuando el tesista quiera su documento, dale el enlace ' +
            'de "enlace_del_word".\n\n' +
            'Al hablar con el tesista, cítalas en APA normal; la clave es para el texto que ' +
            'guardes. Y NO TRADUZCAS LOS TÍTULOS: en la bibliografía va el original, en el ' +
            'idioma en que se publicó. Un título traducido no lo encuentra nadie al ' +
            'comprobarlo, y eso es lo primero que hace un jurado. ' +
            'Si ninguna sirve para lo que estabas escribiendo, dilo en vez de forzarla.',
        );
      },
    );
  }

  // ── Literatura abierta, en vivo ──────────────────────────────────────────
  //
  // POR QUÉ NO ES LA API DE SCOPUS
  // ------------------------------
  // Porque no se puede desde aquí. Elsevier ata el acceso real a la RED de una
  // institución suscrita: desde la IP de este servidor no hay suscripción que
  // valga, y lo que devolvería es metadato recortado o nada.
  //
  // OpenAlex cubre el mismo terreno sin clave ni cuota institucional, e indexa
  // Scielo, Redalyc y repositorios latinoamericanos que Scopus ni tiene. Para
  // un tesista peruano que necesita antecedentes nacionales eso no es un
  // consuelo: es mejor que Scopus.
  //
  // Va siempre disponible, con corpus configurado o sin él: no depende de la
  // biblioteca de la casa.
  server.registerTool(
    'buscar_en_la_literatura',
    {
      title: 'Buscar en la literatura publicada',
      description:
        'Busca en OpenAlex, el catálogo abierto de 327 millones de trabajos publicados. ' +
        'EN VIVO, no en una biblioteca guardada. ' +
        'ÚSALA cuando "buscar_fuentes" no encuentre nada, cuando el tesista pida ' +
        'ANTECEDENTES DE SU PAÍS, o cuando quiera fuentes en español: aquí sí valen, porque ' +
        'esta base indexa Scielo, Redalyc y repositorios latinoamericanos. ' +
        'Devuelve autor, año, revista, DOI real, cuántas veces se ha citado y si hay PDF ' +
        'gratis. NO cites de memoria ni completes datos que no vengan de aquí. ' +
        'ESTAS FUENTES NO ESTÁN REVISADAS POR ACOSTA: el catálogo es abierto y entra de todo, ' +
        'incluidos repositorios y preprints. Dilo al presentarlas, y recuerda que las de ' +
        '"buscar_fuentes" sí llevan ese criterio.',
      inputSchema: ESQUEMA_LITERATURA,
    },
    async ({ tema, idioma, pais, desdeAnio, cuantas }) => {
      const cupo = await cupoDePrueba('buscar_en_la_literatura', tema);
      if (cupo.bloqueo) return cupo.bloqueo;
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: 'buscar_en_la_literatura',
        prompt: tema,
      });

      const { fuentes, total, caida, origen, filtrosSinAplicar } =
        await referenceService.buscarEnLaLiteratura({
          tema,
          idioma,
          pais,
          desdeAnio,
          cuantas,
        });

      // La búsqueda abierta de OpenAlex se pausa a veces mientras su servidor se
      // recupera. No es culpa del tesista ni un fallo del conector, y decirlo
      // así evita que se ponga a probar cosas creyendo que hizo algo mal.
      if (caida) {
        // Si no respondió, no se le cobra.
        await licenseService.releaseLimits(cupo.reserva);
        return texto(
          'El catálogo abierto no está respondiendo ahora mismo, ni su respaldo. No es nada ' +
            'que hayas hecho tú ni te falte configurar: es su servidor.\n\n' +
            'Prueba de nuevo en un rato, o busca mientras en la biblioteca de Acosta con ' +
            '"buscar_fuentes", traduciendo el tema al inglés.',
        );
      }

      // Vinieron del respaldo: se dice, y sobre todo se dice qué filtro NO se
      // aplicó. Sin esto el asistente presentaría como «antecedentes en el Perú»
      // una lista que no se acotó por país.
      const avisoDeRespaldo = avisoDeCrossref(origen, filtrosSinAplicar);

      if (fuentes.length === 0) {
        const acotado = [idioma ? 'idioma ' + idioma : null, pais ? 'país ' + pais : null]
          .filter(Boolean)
          .join(' y ');

        return texto(
          `No hay trabajos sobre «${tema}»${acotado ? ' con ' + acotado : ''}.${N}${N}` +
            'Antes de darlo por perdido: quita el filtro de país o de idioma y vuelve a ' +
            'buscar, o prueba con sinónimos. Si de verdad no hay nada, DÍSELO AL TESISTA ' +
            'TAL CUAL: que su tema esté poco estudiado es un hallazgo que va en la ' +
            'justificación, no un problema que se tape citando de memoria.',
        );
      }

      const fichas = fuentes.map((f, i) => {
        const lineas = [`${i + 1}. ${f.cita}`];

        const señas = [];
        if (f.citas > 0) señas.push(`citado ${f.citas} veces`);
        if (f.pdfLibre) señas.push('PDF gratis');
        if (f.idioma) señas.push(`en ${f.idioma}`);
        if (señas.length > 0) lineas.push(`   [${señas.join(' · ')}]`);

        if (f.resumen) lineas.push(`   Resumen: ${f.resumen.slice(0, 400)}`);
        return lineas.join('\n');
      });

      const cuantosHay = total > fuentes.length ? ` (hay ${total} en total)` : '';

      return texto(
        avisoDeRespaldo +
          `Literatura publicada sobre «${tema}»${cuantosHay}:\n\n${fichas.join('\n\n')}\n\n` +
          'Cita EXACTAMENTE como están escritas, sin cambiar años, autores ni DOIs, y sin ' +
          'traducir los títulos: en la bibliografía va el título original. ' +
          'Y DI DE DÓNDE VIENEN: son del catálogo abierto, no de la biblioteca revisada de ' +
          'Acosta. El tesista debería comprobar dónde se publicó cada una antes de citarla.',
      );
    },
  );

  // ── Qué más leer, a partir de lo que ya tiene ────────────────────────────
  //
  // Las otras dos búsquedas parten de PALABRAS, y las palabras solo encuentran
  // lo que el tesista sabe nombrar. Quien escribe «clima organizacional» no da
  // con lo que su campo publica como «organizational climate», que es lo que su
  // jurado espera ver citado.
  //
  // Esta parte de sus propias fuentes, que ya están dentro de la conversación de
  // su campo. Y el orden de lo que devuelve hacia atrás no es por fama: es por
  // CUÁNTAS DE LAS SUYAS lo citan, que es lo que distingue al clásico de su tema
  // del clásico de otro.
  server.registerTool(
    'ampliar_desde_mis_fuentes',
    {
      title: 'Qué más leer, a partir de lo que ya tiene',
      description:
        'BOLA DE NIEVE sobre la biblioteca del tesista —su Zotero conectado, sus exports y lo ' +
        'que guardó por DOI—: devuelve (a) los trabajos ' +
        'que MÁS DE UNA de sus fuentes citan y él no tiene, y (b) los trabajos recientes que ' +
        'citan a las suyas. ' +
        'ÚSALA en antecedentes y marco teórico, y sobre todo cuando diga que NO SABE QUÉ MÁS ' +
        'BUSCAR o cuando sus búsquedas por palabras ya no den nada nuevo. ' +
        'No lleva tema: parte de su biblioteca, así que no hay nada que teclear. ' +
        'EL NÚMERO QUE IMPORTA es «lo citan N de tus fuentes»: cuanto más alto, más central ' +
        'es ese trabajo EN SU TEMA. Díselo así, no como «muy citado». ' +
        'Es un método declarable —se llama snowballing y tiene guías publicadas—, así que ' +
        'puede escribirlo en su capítulo de metodología. ' +
        'ESTAS FUENTES NO ESTÁN REVISADAS POR ACOSTA y no todas le van a servir: vienen de ' +
        'la conversación de su campo, no de su problema concreto. Preséntalas para que él ' +
        'elija, no como si ya fueran suyas.',
      inputSchema: ESQUEMA_BOLA,
    },
    async ({ desdeAnio, cuantas }) => {
      const cupo = await cupoDePrueba('ampliar_desde_mis_fuentes');
      if (cupo.bloqueo) return cupo.bloqueo;
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: 'ampliar_desde_mis_fuentes',
      });

      const { semillas, atras, adelante, caida } = await propiasService.boladeNieve(licencia.userId, {
        desdeAnio,
        cuantas,
      });

      if (caida) {
        await licenseService.releaseLimits(cupo.reserva);
        return texto(
          'El catálogo abierto no está respondiendo ahora mismo. No es nada que hayas hecho ' +
            'tú: es su servidor. Prueba en un rato.',
        );
      }

      if (atras.length === 0 && adelante.length === 0) {
        return texto(
          `Partiendo de tus ${semillas} fuentes no aparece nada nuevo.${N}${N}` +
            'Suele significar una de dos cosas, y las dos son información: o tu biblioteca ya ' +
            'cubre lo que se cita en tu tema —que es una buena noticia y se puede decir en la ' +
            'revisión—, o tus fuentes son de campos distintos y no comparten referencias. ' +
            'Si es lo segundo, sube unas cuantas más del tema exacto de tu tesis y vuelve a ' +
            'intentarlo.',
        );
      }

      const ficha = (f, senal) => {
        const lineas = [`• ${f.authors || '(Autor no consignado)'} (${f.year ?? 's. f.'}). ${f.title}`];
        if (f.source) lineas.push(`   ${f.source}`);
        if (f.doi) lineas.push(`   DOI: ${f.doi}`);
        if (senal) lineas.push(`   [${senal}]`);
        if (f.abstract) lineas.push(`   Resumen: ${f.abstract.slice(0, 300)}`);
        return lineas.join('\n');
      };

      const bloques = [];

      if (atras.length > 0) {
        bloques.push(
          'LO QUE CITAN TUS FUENTES Y TÚ NO TIENES\n' +
            atras
              .map((f) =>
                ficha(f, `lo citan ${f.tuyasQueLoCitan} de tus fuentes${f.citas ? ` · ${f.citas} citas en total` : ''}`),
              )
              .join('\n\n'),
        );
      }

      if (adelante.length > 0) {
        bloques.push(
          'LO QUE HA CITADO A TUS FUENTES DESPUÉS\n' +
            adelante.map((f) => ficha(f, f.citas ? `${f.citas} citas` : null)).join('\n\n'),
        );
      }

      return texto(
        `Partiendo de ${semillas} fuentes tuyas:${N}${N}${bloques.join(`${N}${N}`)}${N}${N}` +
          'CÓMO PRESENTARLAS: las de arriba son las que sostienen la conversación de tu tema ' +
          '—cuantas más de tus fuentes las citen, más central—; las de abajo son lo que se ha ' +
          'publicado después, y sirven para que tu marco teórico no se quede viejo. ' +
          'Ninguna está revisada por Acosta y no todas van a servirte: elige tú. ' +
          'PREGÚNTALE CUÁLES QUIERE y guárdaselas con "anadir_a_mis_fuentes" pasando sus DOI; ' +
          'a partir de ahí se citan como cualquier otra fuente suya. ' +
          'Y cita EXACTAMENTE como están escritas, sin cambiar años, autores ni DOIs.',
      );
    },
  );

  // ── Guardar en su biblioteca lo que acaba de encontrar ───────────────────
  //
  // Sin esto, la bola de nieve enseñaba fuentes y las dejaba en el aire: el
  // tesista tenía que copiar los DOI a mano en el panel, y el panel solo ofrece
  // ese campo cuando falla la lectura de un PDF. Una función que termina
  // diciendo «ahora hazlo tú en otro sitio» está a medias.
  //
  // Viaja el DOI y solo el DOI. La ficha la trae el catálogo, así que el año y
  // los autores no pueden salir de la memoria de nadie.
  server.registerTool(
    'anadir_a_mis_fuentes',
    {
      title: 'Guardar fuentes en la biblioteca del tesista',
      description:
        'Guarda en la biblioteca del tesista las fuentes cuyos DOI le pases, para que pueda ' +
        'citarlas en sus capítulos. ' +
        'ÚSALA justo después de "ampliar_desde_mis_fuentes" o de "buscar_en_la_literatura", ' +
        'cuando el tesista diga cuáles quiere: «añade la 1 y la 3», «guárdalas todas». ' +
        'PREGÚNTASELO ANTES: no guardes lo que no te ha pedido. ' +
        'PASA SOLO DOI QUE VENGAN DE UNA BÚSQUEDA, nunca uno recordado ni reconstruido: si ' +
        'no tienes el DOI exacto delante, dilo en vez de inventarlo. ' +
        'Lo repetido no se duplica y lo que el catálogo no conozca se te dirá por su nombre.',
      inputSchema: ESQUEMA_ANADIR,
    },
    async ({ dois }) => {
      await licenseService.recordUsage({
        licenseId: licencia.id,
        tool: 'anadir_a_mis_fuentes',
      });

      const parte = await propiasService.importarPorDoi({ userId: licencia.userId, dois });

      const lineas = [];
      if (parte.guardadas > 0) lineas.push(`${parte.guardadas} fuentes nuevas en su biblioteca.`);
      if (parte.repetidas > 0) lineas.push(`${parte.repetidas} ya las tenía: se refrescó la ficha.`);
      if (parte.noEncontrados.length > 0) {
        lineas.push(
          `El catálogo abierto no conoce ${parte.noEncontrados.length}: ` +
            `${parte.noEncontrados.join(', ')}. ` +
            'Comprueba que el DOI esté bien copiado; si lo está, esa fuente tendrá que entrar ' +
            'por el export de su base de datos.',
        );
      }

      lineas.push(`Ahora tiene ${parte.total} fuentes propias.`);

      return texto(
        `${lineas.join(N)}${N}${N}` +
          'Ya se pueden citar: búscalas con "buscar_fuentes" cuando redactes, y usa la clave ' +
          'AR que te devuelva. NO escribas la cita a mano.',
      );
    },
  );

  // ── Su biblioteca, sin tema: «entra a mi Zotero» ─────────────────────────
  //
  // El tesista que conectó su Zotero pregunta por él así, y todas las demás
  // búsquedas piden un tema. Sin esto, el asistente buscaba un conector de
  // Zotero, no lo encontraba y le decía que no tenía acceso, con sus quinientas
  // fuentes ya dentro. Va fuera de cualquier condición: su biblioteca no depende
  // de que haya corpus de la casa.
  server.registerTool(
    'mis_fuentes',
    {
      title: 'Su biblioteca, su Zotero y su Mendeley incluidos',
      description:
        'Enseña la biblioteca PROPIA del tesista: la colección de SU ZOTERO y la carpeta de ' +
        'SU MENDELEY que conectó desde su perfil en la web, lo que subió de Scopus, Web of ' +
        'Science o SciELO, y lo que guardó por DOI. Dice cuántas tiene, de dónde vienen y ' +
        'cuándo se actualizaron, y las lista por páginas con la clave de cada una para citarla. ' +
        'ÚSALA cuando pregunte por SU ZOTERO, SU MENDELEY, su colección o su carpeta, o por ' +
        '«mis fuentes», «mi biblioteca», «qué tengo». SÍ TIENES ACCESO a lo que trajo de ' +
        'Zotero y de Mendeley: es por aquí, no por otro conector. ' +
        (env.zoteroEnabled
          ? 'Para las de un tema concreto no pases páginas: usa "buscar_fuentes", que busca ' +
            'dentro de estas. '
          : '') +
        'Si tiene muchas, enséñale el resumen y la primera página, y pregúntale qué necesita ' +
        'antes de pedir las demás.',
      inputSchema: ESQUEMA_MIS_FUENTES,
    },
    async ({ pagina, origen }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'mis_fuentes' });

      const b = await propiasService.biblioteca(licencia.userId, { pagina, origen });
      const zotero = b.zotero;
      const mendeley = b.mendeley;
      const fecha = (valor) =>
        new Date(valor).toLocaleDateString('es-PE', {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
        });

      // Lo que explica una lista vacía o corta. Va antes que la lista porque es
      // lo primero que el tesista necesita saber si esperaba ver algo.
      const avisos = [];
      if (zotero?.trayendo) {
        avisos.push(
          'Su Zotero se está trayendo AHORA MISMO: puede que falten fuentes. Que vuelva a ' +
            'pedirlo en un par de minutos.',
        );
      }
      if (zotero && !zotero.coleccion) {
        avisos.push(
          'Tiene Zotero conectado pero NO HA ELEGIDO QUÉ TRAER: que entre en su perfil de la ' +
            'web, en «Tu Zotero», y elija una colección o toda su biblioteca. Hasta entonces no ' +
            'se importa nada de ahí.',
        );
      }
      if (zotero?.error) {
        avisos.push(
          `La última vez que se intentó traer su Zotero falló: «${zotero.error}». Díselo; ` +
            'desde «Tu Zotero» en su perfil puede volver a conectarlo o pulsar «Actualizar ahora».',
        );
      }
      if (mendeley?.trayendo) {
        avisos.push(
          'Su Mendeley se está trayendo AHORA MISMO: puede que falten fuentes. Que vuelva a ' +
            'pedirlo en un par de minutos.',
        );
      }
      if (mendeley && !mendeley.coleccion) {
        avisos.push(
          'Tiene Mendeley conectado pero NO HA ELEGIDO QUÉ TRAER: que entre en su perfil de la ' +
            'web, en «Tu Mendeley», y elija una carpeta o toda su biblioteca. Hasta entonces no ' +
            'se importa nada de ahí.',
        );
      }
      if (mendeley?.error) {
        avisos.push(
          `La última vez que se intentó traer su Mendeley falló: «${mendeley.error}». Díselo; ` +
            'desde «Tu Mendeley» en su perfil puede volver a conectarlo o pulsar «Actualizar ahora».',
        );
      }

      if (b.total === 0) {
        return texto(
          'El tesista todavía no tiene fuentes propias.' +
            N +
            N +
            (avisos.length > 0
              ? avisos.join(N)
              : 'Díselo tal cual y cuéntale cómo traerlas desde su perfil en la web: conectando ' +
                'su Zotero o su Mendeley en «Tus herramientas» —elige una colección o carpeta y ' +
                'se actualiza sola cada noche— o ' +
                'subiendo su export de Scopus, Web of Science o SciELO en «Mis fuentes».') +
            (env.zoteroEnabled
              ? `${N}${N}Mientras tanto, "buscar_fuentes" sigue buscando en la biblioteca de Acosta.`
              : ''),
        );
      }

      const resumen = [`Biblioteca propia del tesista: ${b.total} fuentes.`];
      if (b.deZotero > 0) {
        const deDonde = zotero?.coleccion ? ` —de «${zotero.coleccion}»` : '';
        const alDia = zotero?.ultima ? `, al día del ${fecha(zotero.ultima)}` : '';
        const cierre = deDonde ? '—' : '';
        resumen.push(
          `· ${b.deZotero} de su Zotero${deDonde}${alDia}${cierre}.` +
            (zotero ? '' : ' Ya no tiene Zotero conectado: se quedaron las que había traído.'),
        );
      }
      if (b.deMendeley > 0) {
        const deDonde = mendeley?.coleccion ? ` —de «${mendeley.coleccion}»` : '';
        const alDia = mendeley?.ultima ? `, al día del ${fecha(mendeley.ultima)}` : '';
        const cierre = deDonde ? '—' : '';
        resumen.push(
          `· ${b.deMendeley} de su Mendeley${deDonde}${alDia}${cierre}.` +
            (mendeley ? '' : ' Ya no tiene Mendeley conectado: se quedaron las que había traído.'),
        );
      }
      if (b.subidas > 0) {
        resumen.push(
          `· ${b.subidas} que subió él: de un export de Scopus, Web of Science o SciELO, o por DOI.`,
        );
      }

      const filtro =
        b.origen === 'zotero'
          ? ' (solo las de Zotero)'
          : b.origen === 'mendeley'
            ? ' (solo las de Mendeley)'
            : b.origen === 'subidas'
            ? ' (solo las subidas)'
            : '';

      if (b.fuentes.length === 0) {
        return texto(
          `${resumen.join(N)}${avisos.length > 0 ? N + N + avisos.join(N) : ''}${N}${N}` +
            (b.enElFiltro === 0
              ? `No hay ninguna${filtro}. Pide la lista sin "origen" para verlas todas.`
              : `La página ${b.pagina} no existe${filtro}: hay ${b.paginas}.`),
        );
      }

      // La marca de origen solo si hay de más de una procedencia: en una
      // biblioteca que es toda de Zotero, repetir «Zotero» cuarenta veces no
      // dice nada.
      const mezcladas =
        b.origen === 'todas' && [b.deZotero, b.deMendeley, b.subidas].filter((n) => n > 0).length > 1;
      const MARCAS = { ZOTERO: '   · Zotero', MENDELEY: '   · Mendeley' };
      const recortar = (valor, largo) => {
        const limpio = String(valor ?? '').trim();
        return limpio.length > largo ? `${limpio.slice(0, largo - 1)}…` : limpio;
      };

      const lista = b.fuentes.map((f, i) => {
        const autores = recortar(f.authors, 90) || '(Autor no consignado)';
        const marca = mezcladas ? (MARCAS[f.origin] ?? '   · subida') : '';
        const titulo = recortar(f.title, 180);
        return `${b.desde + i}. [${f.ref}]  ${autores} (${f.year ?? 's. f.'}). ${titulo}${marca}`;
      });

      const siguiente =
        b.pagina < b.paginas
          ? `${N}${N}Hay más: para seguir, pide "pagina": ${b.pagina + 1}.`
          : '';

      return texto(
        `${resumen.join(N)}${avisos.length > 0 ? N + N + avisos.join(N) : ''}${N}${N}` +
          `Página ${b.pagina} de ${b.paginas}${filtro}, por autor:${N}${N}` +
          `${lista.join(N)}${siguiente}${N}${N}` +
          'ESTAS LAS ELIGIÓ EL TESISTA y NO están revisadas por Acosta: no se las presentes como ' +
          'si lo estuvieran. ' +
          'CÓMO SE CITAN: con la clave entre corchetes en el texto que guardes —«…afecta al ' +
          'rendimiento [AR97D22F86].», o «[AR97D22F86:n] sostienen que…» si el autor va en la ' +
          'frase—. Al armar el Word, el servidor escribe la cita y la referencia en la norma del ' +
          'proyecto. NO escribas tú la cita ni la bibliografía, y no cambies títulos ni años. ' +
          (env.zoteroEnabled
            ? 'Para las que traten de un tema concreto, "buscar_fuentes" busca dentro de estas ' +
              'y te da el resumen de cada una. '
            : '') +
          'Si falta una que tiene en Zotero o en Mendeley, puede que no esté en la colección o ' +
          'carpeta elegida o que no se haya actualizado aún: en su perfil, «Tu Zotero» o «Tu ' +
          'Mendeley» → «Actualizar ahora».',
      );
    },
  );

  // ── R, en la conversación ────────────────────────────────────────────────
  //
  // El tesista ya no abre ninguna página ni escribe código: Claude le pregunta
  // lo que necesita y corre el análisis aquí. R va dentro de la jaula de
  // infra/r/, nunca en este proceso, y cada ejecución se guarda en el análisis
  // del proyecto, donde la leen ver_analisis y el repaso de cifras.
  server.registerTool(
    'trabajar_en_r',
    {
      title: 'Correr el análisis en R',
      description:
        'Una sesión de R de verdad para el análisis del tesista, que manejas TÚ: él no escribe ' +
        'código ni instala nada. Es la sesión de su proyecto y conserva los objetos entre llamadas.\n\n' +
        'CÓMO SE USA\n' +
        '· Sin argumentos: qué hay en la sesión —las columnas de sus datos, los objetos, los ' +
        'archivos—. Si todavía no subió sus datos, devuelve un enlace para que los suba desde su ' +
        'navegador: dáselo como enlace que se pulsa, sin escribir la dirección.\n' +
        '· codigo: ejecuta R y devuelve la consola, los gráficos como imagen y cómo se lee cada ' +
        'prueba. Ya existen `datos` (su matriz) y estas funciones: alfa_de_cronbach(items), ' +
        'puntaje(datos, columnas), normalidad(x), descriptivos(datos), frecuencias(x) y ' +
        'escribir_csv(tabla, "archivo.csv"). Si lo que subió es un exporte bibliográfico, ver ' +
        'MAPEO BIBLIOMÉTRICO.\n' +
        '· descargar: un enlace para que baje un archivo que creó el análisis.\n' +
        '· subir: un enlace para subir otro archivo cuando ya hay datos (su matriz corregida o un ' +
        'exporte bibliográfico); reemplaza lo que hay en la sesión.\n' +
        '· reiniciar: borra los objetos y vuelve a leer sus datos.\n' +
        '· informe: arma el informe en Word del análisis y da el enlace (ver INFORME EN WORD).\n\n' +
        'ANTES DE CORRER PRUEBAS, PREGÚNTALE lo que no sepas —sus variables y dimensiones, qué ' +
        'ítems forman cada una, si su hipótesis es de relación o de diferencia—, y mira antes ' +
        '"mi_proyecto" o "ver_capitulo": la metodología puede estar ya acordada. Ve por pasos ' +
        '(confiabilidad, puntajes, normalidad y la prueba que toque) y explícale cada resultado ' +
        'en una o dos frases, sin jerga.\n\n' +
        'SUS DATOS SON PERSONALES: no imprimas la matriz ni filas enteras. Si necesitas ver ' +
        'valores para encontrar un error, head() de pocas filas y solo de las columnas necesarias.\n\n' +
        'PAQUETES, además de R base (factanal, prcomp, glm…) y los recomendados (MASS, nlme, ' +
        'survival…). Sirven a cualquier carrera:\n' +
        '· Datos y gráficos: tidyverse, rio, skimr, Hmisc, mice, ggplot2, ggpubr, patchwork, ' +
        'GGally, ggthemes, viridis, ggalluvial, corrplot, sjPlot, ggeffects.\n' +
        '· Tablas para el tesista: flextable y officer (Word), kableExtra, writexl, openxlsx; ' +
        'leer: readxl, haven.\n' +
        '· Psicometría: psych, GPArotation, psy, lavaan, semTools, semPlot (diagramas de ruta), ' +
        'eRm, polycor, qgraph, MVN (normalidad multivariante), nFactors y paran (factores a ' +
        'retener), mirt y ltm (teoría de respuesta al ítem), difR (DIF), irr (acuerdo entre jueces).\n' +
        '· PLS-SEM: seminr, cSEM, plspm. El bootstrap, con cores = 1 y unos 1000 remuestreos: la ' +
        'sesión no deja paralelizar y 5000 no caben en el tiempo.\n' +
        '· Inferencia: car, rstatix, nortest, coin, multcomp, effectsize, performance, broom, ' +
        'emmeans, pwr (tamaño de muestra), vcd, ordinal, pscl, lme4, lmerTest, moments, DescTools, ' +
        'BayesFactor (factores de Bayes).\n' +
        '· Salud: epitools, epiR, pROC, survival, survminer, metafor y meta (metaanálisis).\n' +
        '· Encuestas con muestreo complejo: survey.\n' +
        '· Economía y finanzas: plm, fixest, panelr, pdynmc (panel dinámico GMM), AER, lmtest, ' +
        'sandwich, forecast, tseries, urca, zoo, xts.\n' +
        '· Diseño experimental y agronomía: agricolae (DCA, DBCA, parcelas divididas; HSD, LSD, Duncan).\n' +
        '· Biología y ambiente: vegan, ade4.\n' +
        '· Datos espaciales: sf y terra, con coordenadas o archivos que suba el tesista; sin mapas ' +
        'base de fondo, que se descargan de internet.\n' +
        '· Multivariante y machine learning: FactoMineR, factoextra, dendextend, caret, ' +
        'randomForest, glmnet, e1071.\n' +
        '· Texto (respuestas abiertas, entrevistas): tidytext, tm, SnowballC, wordcloud, quanteda ' +
        '(con quanteda.textstats y quanteda.textplots), topicmodels.\n' +
        '· Tablas listas: gtsummary («Tabla 1» y regresiones; al Word con as_flex_table), ' +
        'apaTables, janitor.\n' +
        '· Bibliometría: bibliometrix (e igraph para sus redes). Ver MAPEO BIBLIOMÉTRICO.\n' +
        'Los library() se recuerdan entre llamadas. Carga solo lo que uses: cada paquete suma ' +
        'segundos a cada llamada. NO hay brms, rstanarm ni blavaan (Stan compila cada modelo y aquí ' +
        'no hay compilador; para lo bayesiano, BayesFactor), ni leaflet, tmap o FielDHub (mapas y ' +
        'aplicaciones interactivas que no se ven en el chat ni en un Word).\n\n' +
        'MAPEO BIBLIOMÉTRICO: si pide un mapeo o análisis bibliométrico y "listar_capitulos" trae ' +
        'la herramienta o la fase de mapeo bibliométrico, ÁBRELA PRIMERO con "redactar" y sigue sus ' +
        'pasos: es el método, y sabe dónde va cada cosa en su documento. EL CAMINO NORMAL ES SU ' +
        'PERFIL, no un enlace: en acostaresearch.com/perfil, pestaña «Tus fuentes de Scopus», busca ' +
        'con la ecuación («Consulta avanzada») y pulsa «Hacer un mapeo bibliométrico con estos ' +
        'resultados»; los datos llegan solos a esta sesión. Dale esas indicaciones. Solo si YA tiene ' +
        'un archivo exportado, al mismo enlace de subida puede subir, en vez de una matriz, el exporte ' +
        'de Scopus (CSV, BibTeX o el texto plano que baja por defecto), de Web of Science (texto plano ' +
        'o BibTeX) o de PubMed. Entonces `datos` ya es la tabla de bibliometrix, una fila por ' +
        'documento, con sus etiquetas (AU, TI, SO, PY, TC, CR, DE, ID, C1…). Antes de que exporte, ' +
        'dile que marque TODOS los campos, o al menos resumen, palabras clave, afiliaciones y ' +
        'referencias: sin referencias no hay cocitación ni acoplamiento. Lo que llega desde el perfil ' +
        'trae los datos de OpenAlex, sus palabras clave y sus identificadores en las referencias, y ' +
        'eso se declara en Métodos.\n' +
        'Funciones de la casa para esto: resumen_bibliometrico(k = 10) —información principal, ' +
        'producción anual, autores, fuentes, países y lo más citado— y figura_bibliometrica(tipo), que ' +
        'guarda «figura_<tipo>.png» lista para el informe, la dibuja aquí e imprime sus cifras. Tipos: ' +
        'produccion_anual, fuentes, autores, paises, palabras, coocurrencia, mapa_tematico, cocitacion, ' +
        'coautoria, colaboracion_paises, bradford y lotka; opciones n (cuántos), campo ("DE" palabras ' +
        'de autor, "ID" las de la base, "TI" o "AB" los términos de títulos o resúmenes, que es lo que ' +
        'toca si los datos son de OpenAlex) y minfreq (mapa temático). Si los datos no los subió él, ' +
        'al mirar la sesión sale DE DÓNDE SALIERON: úsalo en el PRISMA y los Métodos. UNA figura por llamada: con miles ' +
        'de documentos, cada red se come buena parte del tiempo. Para lo demás, las funciones de ' +
        'bibliometrix tal cual (thematicEvolution, conceptualStructure, histNetwork…). NO hay ' +
        'biblioshiny: aquí no hay navegador ni red. Las figuras de bibliometrix rotulan en inglés ' +
        '(«Motor Themes»): nómbralas en español en el texto.\n' +
        'Su licencia EXIGE citarlo en lo que se publique: antes del informe, guarda la fuente con ' +
        '"anadir_a_mis_fuentes" (DOI 10.1016/j.joi.2017.08.007; Aria y Cuccurullo, 2017, Journal of ' +
        'Informetrics) y cítala con su clave en el párrafo de método.\n\n' +
        'INFORME EN WORD: cuando pida su informe o su capítulo de resultados en Word, manda solo ' +
        '«informe». El servidor pone las tablas en APA, mete las figuras de la sesión, pone las citas y ' +
        'las referencias en la norma que elija y te da el enlace.\n' +
        'El texto va en Markdown, como un capítulo: «# 4.1. Resultados descriptivos», «## 4.1.1. …» y ' +
        'párrafos separados por una línea en blanco.\n' +
        'Una TABLA es un bloque sin líneas en blanco: «**Tabla 1**», «*Título*», la tabla con «|» y su ' +
        'fila «|---|», y «*Nota.* …».\n' +
        'Una FIGURA, igual: «**Figura 1**», «*Título*», «![](figura1.png)» y «*Nota.* Procesado en R ' +
        '4.3.3.». El PNG tiene que estar en la sesión: guárdalo antes con png("figura1.png", width = ' +
        '1600, height = 1100, res = 200); …; dev.off().\n' +
        'ESTRUCTURA DE REFERENCIA —es un ejemplo: adáptala a su diseño y a sus objetivos, y no pongas ' +
        'apartados que no apliquen—: un párrafo de apertura (qué se analizó, con cuántos participantes ' +
        'y qué instrumento); resultados descriptivos, con una tabla por variable u objetivo ' +
        '(niveles, frecuencia, porcentaje), su figura si aporta y un párrafo que la interprete; ' +
        'resultados inferenciales, con los supuestos (normalidad) y la decisión que justifican, y una ' +
        'sección por hipótesis con la tabla de la prueba (estadístico, p, decisión, magnitud o tamaño ' +
        'del efecto), su figura si aporta y la interpretación contra la hipótesis; y los resultados ' +
        'complementarios, si los hubo. Tablas y figuras numeradas en orden, cada una con título y nota, ' +
        'y nombradas en el texto («la Tabla 3 muestra…»). Un estudio cualitativo, experimental o ' +
        'comparativo lleva sus propios apartados.\n' +
        'CADA CIFRA SALE DE LA CONSOLA DE ESTA SESIÓN: la respuesta te marca las que no encuentre.\n\n' +
        'LÍMITES: sin internet, sin install.packages y sin salir de su carpeta. Cada llamada ' +
        `tiene ${env.R_LIMITE_SEGUNDOS} segundos y 400 MB (900 MB si sus datos son un exporte ` +
        'bibliográfico).\n\n' +
        'Todo lo que ejecutas queda guardado en su análisis: "ver_analisis" lo lee, y las cifras ' +
        'que vayan al texto se guardan con "guardar_analisis" (resultados), como siempre.',
      inputSchema: ESQUEMA_TRABAJAR_EN_R,
    },
    async ({ codigo, reiniciar, descargar, subir, informe }) => {
      // El informe va aparte: no ejecuta R, arma un Word con lo que ya salió.
      if (informe) {
        const cupo = await cupoDePrueba('trabajar_en_r');
        if (cupo.bloqueo) return cupo.bloqueo;
        await licenseService.recordUsage({ licenseId: licencia.id, tool: 'trabajar_en_r:informe' });
        try {
          return await rService.informe({
            userId: licencia.user.id,
            productCode: licencia.productCode,
            titulo: informe.titulo,
            texto: informe.texto,
            norma: informe.norma,
          });
        } catch (error) {
          logger.error({ err: error, licenseId: licencia.id }, 'Falló el informe de R');
          return texto(
            'No se pudo armar el informe por un fallo del servidor. No es nada del texto: vuelve a ' +
              'intentarlo en un momento y, si se repite, díselo al tesista.',
          );
        }
      }

      // Solo ejecutar gasta cupo en un conector de prueba: mirar la sesión no.
      if (typeof codigo === 'string' && codigo.trim() !== '') {
        const cupo = await cupoDePrueba('trabajar_en_r');
        if (cupo.bloqueo) return cupo.bloqueo;
      }
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'trabajar_en_r' });

      try {
        const { contenido, bloqueo } = await rService.trabajar({
          userId: licencia.user.id,
          productCode: licencia.productCode,
          codigo,
          reiniciar,
          descargar,
          subir,
        });

        // El intento queda en el uso de la licencia, donde lo ve la vigilancia.
        if (bloqueo) {
          await licenseService.recordUsage({
            licenseId: licencia.id,
            tool: `trabajar_en_r:${bloqueo.regla}`.slice(0, 60),
            ok: false,
          });
        }
        return contenido;
      } catch (error) {
        logger.error({ err: error, licenseId: licencia.id }, 'Falló trabajar_en_r');
        return texto(
          'No se pudo ejecutar el análisis por un fallo del servidor. No es nada del código: ' +
            'vuelve a intentarlo en un momento y, si se repite, díselo al tesista.',
        );
      }
    },
  );

  // ── Subir el Word que escribió por su cuenta ─────────────────────────────
  //
  // Desde la conversación, con un enlace, como el formato: quien pide «humaniza
  // mi documento» no está en su perfil, y el que hay puede ser una versión vieja.
  server.registerTool(
    'subir_mi_documento',
    {
      title: 'Enlace para subir su documento',
      description:
        `Da un ENLACE para que el tesista suba su Word (.docx) al servidor: ${SU_OBRA} escrita por su ` +
        'cuenta, para citarla o humanizarla. Dice también si ya hay uno subido, cuál y de qué fecha. ' +
        'ÚSALA cuando no haya ningún documento subido, o cuando al preguntarle diga que quiere ' +
        'trabajar con uno NUEVO en vez del que está en el servidor. Dale el enlace como enlace que se ' +
        'pulsa, sin escribir la dirección, y dile que vuelva a la conversación cuando lo haya subido; ' +
        'entonces léelo con "ver_mi_documento". Subir uno nuevo reemplaza al anterior, pero conserva ' +
        'las citas y lo humanizado de los párrafos que sigan igual.',
      inputSchema: SIN_ARGUMENTOS,
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'subir_mi_documento' });
      const userId = licencia.user.id;
      const { productCode } = licencia;

      const ficha = await documentoService.fichaDe(userId, productCode);
      const { url, minutos } = subidaDocumento.enlace({ userId, productCode });
      const enlace = await darEnlace({ texto: 'Haz clic aquí para subir tu documento', url, minutos });

      const hayUno = ficha
        ? `Ahora mismo en el servidor está «${ficha.nombre}», subido el ${fechaCorta(ficha.subidoAt)}, ` +
          `con ${ficha.citados} párrafos citados y ${ficha.humanizados} humanizados. Si sube otro, ` +
          'reemplaza a ese: se conservan las citas y lo humanizado de los párrafos que sigan igual.'
        : 'Todavía no hay ningún documento subido.';

      return texto(
        `${hayUno}${N}${N}Enlace para subir su Word (.docx, hasta 40 MB):${N}${enlace}${N}${N}` +
          'Dile que vuelva aquí y te avise cuando lo haya subido; entonces léelo con "ver_mi_documento".',
      );
    },
  );

  // ── Citar el Word que escribió por su cuenta ─────────────────────────────
  //
  // Quien llega con la tesis ya escrita la sube desde su perfil. Claude la lee
  // por párrafos, busca fuentes, le enseña un resumen y guarda dónde va cada
  // cita. Las citas se escriben DENTRO de su mismo Word al descargarlo (ver
  // `project.documento`): su formato, sus tablas y sus figuras no se tocan.
  server.registerTool(
    'ver_mi_documento',
    {
      title: 'Leer el documento que subió',
      description:
        `Lee el Word que el tesista SUBIÓ desde su perfil: ${SU_OBRA} ya escrita por su cuenta, ` +
        'para ponerle las citas o para humanizarla. Devuelve los párrafos numerados (¶12) por ' +
        'tandas. ÚSALA cuando diga «cita mi documento», «ponle las referencias», «humaniza mi ' +
        'documento», «ya subí mi tesis», o cuando "mi_proyecto" diga que hay un documento subido. ' +
        'Es SU Word en el servidor: NO le pidas que te lo adjunte en el chat ni lo edites tú con ' +
        'python-docx, que le mueve el formato. ' +
        'ANTES DE CITAR O HUMANIZAR, PREGÚNTALE si trabajas con el documento que ya está en el ' +
        'servidor (dile cuál y de qué fecha) o si quiere subir uno nuevo; si es nuevo, o no hay ' +
        'ninguno, dale el enlace de "subir_mi_documento" y espera a que diga que lo subió. ' +
        'PARA HUMANIZARLO sigue la skill del humanizador y guarda cada bloque aprobado con ' +
        '"humanizar_mi_documento". ' +
        'CÓMO SE CITA, EN ORDEN: ' +
        '1) Si la norma no está elegida, PREGÚNTASELA y guárdala con "guardar_avance" ' +
        '(estiloCitas); las de notas al pie no sirven para un documento subido. ' +
        '2) Lee el documento entero, tanda a tanda. ' +
        '3) Para cada afirmación que necesite respaldo busca fuente: "mis_fuentes" y ' +
        '"buscar_fuentes" (su Zotero y la biblioteca de Acosta, de artículos indexados en Scopus) ' +
        'y "buscar_en_la_literatura" (OpenAlex). ' +
        '4) ANTES DE GUARDAR NADA, enséñale un resumen: cuántas citas pondrás y con qué fuentes, ' +
        'qué fuentes nuevas añadirías a su biblioteca —añade con "anadir_a_mis_fuentes" SOLO las ' +
        'que apruebe— y qué afirmaciones quedarían [FALTA FUENTE]. ' +
        '5) Con su visto bueno, guarda con "citar_mi_documento". ' +
        '6) Dale el enlace con "enlace_del_word". ' +
        'NUNCA inventes una fuente: lo que no tenga respaldo va [FALTA FUENTE].',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          desde: {
            type: 'integer',
            minimum: 1,
            description:
              'Número de párrafo desde el que seguir leyendo. La primera vez, nada: la respuesta ' +
              'dice desde dónde pedir la tanda siguiente.',
          },
        },
        additionalProperties: false,
      }),
    },
    async ({ desde }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'ver_mi_documento' });

      const leido = await documentoService.ver(licencia.user.id, licencia.productCode, { desde });
      if (!leido) {
        return texto(
          'El tesista no ha subido ningún documento. Llama a "subir_mi_documento" y dale el enlace ' +
            'para que suba su Word (.docx); cuando diga que lo subió, vuelve a leerlo con esta herramienta.',
        );
      }

      // La primera tanda de la conversación empieza por la pregunta: el documento
      // del servidor puede ser una versión vieja, y humanizar sobre ella es perder
      // el trabajo cuando suba la buena.
      const pregunta = desde
        ? ''
        : `ANTES DE TRABAJAR: si en esta conversación todavía no se lo preguntaste, PREGÚNTALE si ` +
          `trabajas con «${leido.nombre}», subido el ${fechaCorta(leido.subidoAt)}, o si quiere subir ` +
          'una versión nueva. Si es nueva, llama a "subir_mi_documento", dale el enlace y espera a que ' +
          `diga que lo subió antes de seguir.${N}${N}`;

      const { norma } = leido;
      const lineaDeNorma =
        norma.familia === 'notas'
          ? `Norma: ${norma.nombre}, de notas al pie, que NO se puede aplicar a un documento subido. ` +
            'Pregúntale otra y guárdala con "guardar_avance" (estiloCitas).'
          : norma.elegida
            ? `Norma: ${norma.nombre}.`
            : `Norma: sin elegir (saldría en ${norma.nombre}). PREGÚNTALE cuál le piden y guárdala con ` +
              '"guardar_avance" (estiloCitas) antes de citar.';

      const tanda =
        leido.lineas.length > 0
          ? leido.lineas.join(N)
          : `No hay párrafos desde el ¶${desde}: el documento va del ¶${leido.primero} al ¶${leido.ultimo}.`;

      return texto(
        pregunta +
        `Documento: «${leido.nombre}» · ${leido.total} párrafos con texto (¶${leido.primero} a ` +
          `¶${leido.ultimo}) · ${leido.citados} ya citados · ${leido.humanizados} humanizados.${N}` +
          `${lineaDeNorma}${N}${N}` +
          `${tanda}${N}${N}` +
          (leido.siguiente
            ? `SIGUE: pide "desde": ${leido.siguiente} para la tanda siguiente.${N}${N}`
            : `Es el final del documento.${N}${N}`) +
          'Los marcados [citado] ya tienen sus marcas guardadas; los [humanizado] salen con su ' +
          'texto nuevo, y [APARTE] es donde se partió un párrafo. Lo que va entre corchetes al ' +
          'principio de cada línea NO es del texto: no lo copies. [Título], [tabla] y ' +
          '[referencias] no se humanizan, y [no se reescribe] lleva algo (un campo de Zotero, un ' +
          'enlace, una imagen) que solo puede cambiar el tesista en su Word. ' +
          'No guardes nada hasta haberle enseñado lo que vas a guardar y tener su visto bueno.',
      );
    },
  );

  server.registerTool(
    'citar_mi_documento',
    {
      title: 'Guardar las citas del documento subido',
      description:
        'Guarda dónde va cada cita en el documento que subió el tesista. Manda cada párrafo con su ' +
        'número y su texto COPIADO TAL CUAL de "ver_mi_documento", con las marcas añadidas donde ' +
        'va cada cita: «…afecta al rendimiento [AR97D22F86].»; «[AR97D22F86:n]» detrás del autor ' +
        'si su nombre ya está en la frase («Braun y Clarke [AR97D22F86:n] proponen»); ' +
        '«[AR97D22F86:p. 45]» con página; y «[FALTA FUENTE]» donde no hay fuente. ' +
        'NO CAMBIES NI UNA PALABRA ni corrijas nada: solo se añaden marcas, y un párrafo con el ' +
        'texto cambiado se rechaza. Usa SOLO claves que te haya dado una búsqueda. ' +
        'Manda solo los párrafos que llevan marcas, hasta 40 por llamada; uno mandado sin marcas ' +
        'pierde las que tuviera. ' +
        'NO LA USES sin haberle enseñado antes el resumen y tener su visto bueno. ' +
        'El Word no se toca ahora: las citas y la lista de referencias se escriben al descargarlo, ' +
        'en la norma del proyecto, así que cambiar de norma no obliga a volver a citar.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          parrafos: {
            type: 'array',
            minItems: 1,
            maxItems: 40,
            description: 'Los párrafos con sus marcas.',
            items: {
              type: 'object',
              properties: {
                p: { type: 'integer', minimum: 1, description: 'El número del párrafo: 12 para ¶12.' },
                texto: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 8000,
                  description: 'El texto del párrafo tal cual, con las marcas añadidas.',
                },
              },
              required: ['p', 'texto'],
              additionalProperties: false,
            },
          },
        },
        required: ['parrafos'],
        additionalProperties: false,
      }),
    },
    async ({ parrafos }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'citar_mi_documento' });

      try {
        const r = await documentoService.citar(licencia.user.id, licencia.productCode, parrafos);
        if (!r) {
          return texto(
            'No hay ningún documento subido, así que no se ha guardado nada. Llama a ' +
              '"subir_mi_documento" y dale el enlace para que lo suba.',
          );
        }

        const rechazos =
          r.rechazados.length > 0
            ? `${N}${N}RECHAZADOS (${r.rechazados.length}), corrígelos y vuelve a mandarlos:${N}` +
              r.rechazados.map((x) => `¶${x.p}: ${x.motivo}`).join(N)
            : '';

        return texto(
          `Guardados ${r.guardados} párrafos.${rechazos}${N}${N}` +
            `El documento lleva ahora ${r.citas} citas en ${r.parrafos} párrafos, y ${r.faltas} ` +
            `[FALTA FUENTE]. Saldrán en ${r.norma.nombre}` +
            (r.norma.elegida ? '.' : ', que es la de por defecto: si no se la preguntaste, hazlo.') +
            `${N}${N}Cuando termines, dale su Word con "enlace_del_word". Lo marcado [FALTA FUENTE] ` +
            'sale resaltado en amarillo para que lo encuentre.',
        );
      } catch (error) {
        logger.error({ err: error, licenseId: licencia.id }, 'No se pudieron guardar las citas del documento');
        return texto(
          'NO se pudieron guardar las citas: error del servidor. Vuelve a intentarlo; si insiste, ' +
            'avísale de que no han quedado guardadas.',
        );
      }
    },
  );

  // ── Humanizar el Word que subió ──────────────────────────────────────────
  //
  // El humanizador trabajaba sobre una copia adjunta en el chat y la editaba con
  // python-docx, que al cambiar el texto de un párrafo le borra el formato. Aquí
  // guarda el texto nuevo de cada párrafo, y el servidor lo escribe dentro del
  // mismo Word al descargarlo, conservando estilo, cursivas y notas al pie (ver
  // `project.reescritura`).
  server.registerTool(
    'humanizar_mi_documento',
    {
      title: 'Guardar los párrafos humanizados del documento subido',
      description:
        'Guarda el texto humanizado de párrafos del Word que el tesista SUBIÓ, leído con ' +
        '"ver_mi_documento". Manda cada párrafo con su número y su texto NUEVO completo. ' +
        'NO LA USES sin haberle enseñado antes el bloque reescrito y tener su visto bueno, ni sin ' +
        'haberle preguntado al empezar si trabajas con el documento que está en el servidor o con uno ' +
        'nuevo (el nuevo lo sube con el enlace de "subir_mi_documento"). ' +
        'El Word subido no se sobrescribe: el servidor escribe los párrafos nuevos al descargarlo, ' +
        'con el mismo estilo de párrafo, la misma letra, y las cursivas y notas al pie de las ' +
        'palabras que siguen. Reglas que el servidor comprueba y por las que rechaza el párrafo: ' +
        'las cifras y los años no cambian; lo que va entre comillas se copia tal cual; los ' +
        'apellidos citados siguen ahí; no se añaden corchetes ni avisos; un párrafo [citado] trae ' +
        'EXACTAMENTE las mismas marcas [AR…] y [FALTA FUENTE], cada una con su afirmación, y uno sin ' +
        'citas no trae marcas. Títulos, tablas, rótulos, referencias y párrafos [no se reescribe] ' +
        'no se aceptan. Para PARTIR un párrafo largo en dos (solo si el tesista lo aprobó), pon ' +
        '[APARTE] donde va el corte. Para devolver párrafos a su texto original, pásalos en ' +
        '"deshacer". Hasta 40 párrafos por llamada. Cuando termine el bloque, dale su Word con ' +
        '"enlace_del_word".',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          parrafos: {
            type: 'array',
            maxItems: 40,
            description: 'Los párrafos humanizados.',
            items: {
              type: 'object',
              properties: {
                p: { type: 'integer', minimum: 1, description: 'El número del párrafo: 12 para ¶12.' },
                texto: {
                  type: 'string',
                  minLength: 1,
                  maxLength: 16000,
                  description: 'El texto nuevo del párrafo entero, con sus marcas de cita si las tenía.',
                },
              },
              required: ['p', 'texto'],
              additionalProperties: false,
            },
          },
          deshacer: {
            type: 'array',
            maxItems: 40,
            items: { type: 'integer', minimum: 1 },
            description: 'Números de párrafo que vuelven a su texto original.',
          },
        },
        additionalProperties: false,
      }),
    },
    async ({ parrafos, deshacer }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'humanizar_mi_documento' });

      if ((parrafos?.length ?? 0) + (deshacer?.length ?? 0) === 0) {
        return texto('No has mandado nada: pasa los párrafos en "parrafos" o sus números en "deshacer".');
      }

      try {
        const r = await documentoService.humanizar(licencia.user.id, licencia.productCode, parrafos, deshacer);
        if (!r) {
          return texto(
            'No hay ningún documento subido, así que no se ha guardado nada. Llama a ' +
              '"subir_mi_documento" y dale el enlace para que lo suba.',
          );
        }

        const rechazos =
          r.rechazados.length > 0
            ? `${N}${N}RECHAZADOS (${r.rechazados.length}), NO se guardaron. Corrígelos y vuelve a mandarlos, ` +
              `o dile al tesista por qué no se pueden:${N}` +
              r.rechazados.map((x) => `¶${x.p}: ${x.motivo}`).join(N)
            : '';
        const avisos = r.avisos.length > 0 ? `${N}${N}AVISOS:${N}${r.avisos.join(N)}` : '';

        return texto(
          `Guardados ${r.guardados} párrafos` +
            (r.deshechos > 0 ? `, ${r.deshechos} devueltos a su texto original` : '') +
            `.${rechazos}${avisos}${N}${N}` +
            `El documento lleva ahora ${r.humanizados} párrafos humanizados` +
            (r.partidos > 0 ? `, ${r.partidos} de ellos partidos en dos` : '') +
            `.${N}${N}Cuando termine el bloque, dale su Word con "enlace_del_word" para que lo revise: ` +
            'es su mismo documento con su formato. No le armes tú otro Word.',
        );
      } catch (error) {
        logger.error({ err: error, licenseId: licencia.id }, 'No se pudieron guardar los párrafos humanizados');
        return texto(
          'NO se pudieron guardar los párrafos: error del servidor. Vuelve a intentarlo; si insiste, ' +
            'avísale de que no han quedado guardados.',
        );
      }
    },
  );

  // ── El formato de su universidad ─────────────────────────────────────────
  //
  // El recuadro «Subir formato» del perfil se quitó: lo pregunta Claude y, si lo
  // hay, da un enlace para subirlo, como el de la matriz de R. El Word del
  // servidor lo aplica solo (ver `project.plantilla` y `project.plantilla-partes`).
  server.registerTool(
    'formato_de_la_universidad',
    {
      title:
        perfil.tipo === 'informe'
          ? 'El formato que pide su curso o su empresa'
          : perfil.tipo === 'articulo'
            ? 'La plantilla de la revista para el Word del artículo'
            : 'El formato de su universidad para el Word',
      description:
        perfil.tipo === 'informe'
          ? 'La plantilla de Word para el informe —la que dio su docente o su instituto, o la ' +
            'plantilla de informes de la empresa—, que el Word del servidor aplica solo: títulos, ' +
            'fuentes, márgenes, encabezado, pie de página y la portada llenada con sus datos (curso, ' +
            'docente e integrantes; o empresa, destinatario, quién lo prepara y periodo, si la ' +
            'plantilla los pide). ' +
            'PREGÚNTALE UNA VEZ, al armar el esquema o antes de darle su Word, si le dieron una ' +
            'plantilla o un formato. ÚSALA también cuando diga «tengo la plantilla del curso», ' +
            '«mi profe nos dio un formato» o «la empresa tiene su formato de informes». ' +
            'Sin argumentos dice si ya hay uno puesto y da un ENLACE para subirlo o cambiarlo: dáselo ' +
            'como enlace que se pulsa, sin escribir la dirección, y dile que vuelva cuando lo haya subido; entonces llámala otra vez para ' +
            'confirmar qué se tomó. ' +
            'OJO, no la confundas con "material_del_curso": aquí va la plantilla DE FORMATO, y allí la ' +
            'consigna, la rúbrica o el índice que se leen. ' +
            'NO le pidas que te pegue ni te adjunte el formato en el chat, no lo copies tú a mano y no ' +
            'le armes un Word con ese formato: lo aplica el servidor. Si no tiene formato, no insistas.'
          : perfil.tipo === 'articulo'
            ? 'La plantilla o el formato de Word del ARTÍCULO —la plantilla de la revista a la que lo ' +
              'envía (template, guía de autores en Word) o el formato que le pidió su universidad—, que ' +
              'el Word del servidor aplica solo: títulos, fuentes, márgenes, encabezado y pie de página. ' +
              'ÚSALA SIEMPRE que diga «quiero subir el formato de mi artículo», «tengo la plantilla de la ' +
              'revista», «la revista tiene template» o «quiero que salga con el formato de la revista»: ' +
              'la subida es por el enlace de esta herramienta, NO adjuntando el archivo en el chat. ' +
              'PREGÚNTALE UNA VEZ, al elegir revista o antes de darle su Word, si la revista tiene ' +
              'plantilla. ' +
              'Sin argumentos dice si ya hay uno puesto y da un ENLACE para subirlo o cambiarlo: dáselo ' +
              'como enlace que se pulsa, sin escribir la dirección, y dile que vuelva cuando lo haya ' +
              'subido; entonces llámala otra vez para confirmar qué se tomó. ' +
              'NO le pidas que te pegue ni te adjunte el formato en el chat, no lo copies tú a mano y no ' +
              'le armes un Word con ese formato: lo aplica el servidor. Si no tiene formato, no insistas.'
            : `El formato de tesis que exige su universidad —la plantilla o el documento de formato que ` +
            'da su facultad—, que el Word del servidor aplica solo: títulos, fuentes, márgenes, ' +
            'encabezado, pie de página y la portada llenada con sus datos. ' +
            'PREGÚNTALE UNA VEZ, al empezar a trabajar sus capítulos o antes de darle su Word, si su ' +
            'universidad o facultad le dio un formato o plantilla. ÚSALA también cuando diga «tengo ' +
            'mi formato», «mi universidad tiene plantilla» o «quiero que salga con el formato de mi ' +
            'facultad». ' +
            'Sin argumentos dice si ya hay uno puesto y da un ENLACE para subirlo o cambiarlo: dáselo ' +
            'como enlace que se pulsa, sin escribir la dirección, y dile que vuelva cuando lo haya subido; entonces llámala otra vez para ' +
            'confirmar qué se tomó. ' +
            'NO le pidas que te pegue ni te adjunte el formato en el chat, no lo copies tú a mano y no ' +
            'le armes un Word con ese formato: lo aplica el servidor. Si no tiene formato, no insistas.',
      inputSchema: fromJsonSchema({
        type: 'object',
        properties: {
          usarNuestraPortada: {
            type: 'boolean',
            description:
              'Verdadero para dejar de usar la portada del formato cuando se detectó mal: el ' +
              'resto del formato se queda.',
          },
          quitar: {
            type: 'boolean',
            description:
              'Verdadero para dejar de usar el formato: el Word vuelve al formato por defecto. ' +
              'Solo si el tesista lo pide.',
          },
        },
        additionalProperties: false,
      }),
    },
    async ({ usarNuestraPortada, quitar }) => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'formato_de_la_universidad' });

      const userId = licencia.user.id;
      const { productCode } = licencia;

      if (quitar) {
        const quitado = await projectService.quitarPlantilla(userId, productCode);
        return texto(
          quitado
            ? 'Formato quitado: su Word vuelve a salir con el formato por defecto. Si fue un error, ' +
                'llama otra vez sin argumentos y dale el enlace para volver a subirlo.'
            : 'No tenía ningún formato puesto.',
        );
      }

      if (usarNuestraPortada) {
        const quitada = await projectService.quitarPortadaDePlantilla(userId, productCode);
        return texto(
          quitada
            ? 'Listo: su Word sale con la portada de la plataforma. Los estilos, márgenes, ' +
                'encabezado y pie de su formato se quedan.'
            : 'Su formato no tenía ninguna portada en uso.',
        );
      }

      const formato = await projectService.formatoDelProyecto(userId, productCode);
      const { url, minutos } = subidaFormato.enlace({ userId, productCode });
      const deEmpresa = await projectService.esInformeDeEmpresa(userId, productCode);

      if (!formato) {
        const dioElFormato = deEmpresa
          ? 'la empresa'
          : perfil.tipo === 'informe'
            ? 'su docente o su instituto'
            : perfil.tipo === 'articulo'
              ? 'la revista o su universidad'
              : 'su facultad';
        return texto(
          `Todavía no ha subido ningún formato: su Word sale con el formato por defecto.${N}${N}` +
            `Si ${dioElFormato} le dio un formato o plantilla, dale este enlace para subirlo:${N}` +
            `${await darEnlace({ texto: 'Haz clic aquí para subir tu formato', url, minutos })}${N}${N}` +
            'Dile que suba el .docx que le dieron, sin cambiarle nada y con su ' +
            'portada si la trae, y que vuelva aquí cuando lo haya subido. Solo se guarda el ' +
            'formato: el texto que traiga el documento no se conserva.',
        );
      }

      const NOMBRES = {
        titulo: 'título',
        autor: 'nombre',
        asesor: 'asesor',
        carrera: 'carrera',
        anio: 'año',
        curso: 'curso',
        docente: 'docente',
        integrantes: 'integrantes',
        cicloSeccion: 'ciclo y sección',
        empresa: 'empresa',
        destinatario: 'destinatario',
        preparadoPor: 'quién lo prepara',
        cargo: 'cargo',
        periodo: 'periodo',
      };
      const campos = formato.camposDePortada.map((c) => NOMBRES[c] ?? c);
      const desde = new Date(formato.desde).toISOString().slice(0, 10);
      const deQuien = deEmpresa
        ? 'de la empresa'
        : perfil.tipo === 'informe'
          ? 'del curso'
          : perfil.tipo === 'articulo'
            ? 'del artículo'
            : 'de su universidad';

      return texto(
        `Formato ${deQuien} puesto${formato.nombre ? `: «${formato.nombre}»` : ''}, ` +
          `desde el ${desde}. Su Word sale con él` +
          (formato.portada
            ? `, con la portada del formato${campos.length > 0 ? ` llenada con su ${campos.join(', ')}` : ''}.`
            : ', con la portada de la plataforma.') +
          (formato.completa
            ? ''
            : ' OJO: se subió antes de que se tomaran los márgenes, el encabezado, el pie y la ' +
              'portada; pídele que lo vuelva a subir con el enlace de abajo.') +
          `${N}${N}Si quiere cambiarlo por otro, este enlace sirve:${N}` +
          await darEnlace({ texto: 'Haz clic aquí para cambiar tu formato', url, minutos }) +
          `${N}${N}Si la portada salió mal, llama con "usarNuestraPortada". Para ver cómo quedó, ` +
          'dale su Word con "enlace_del_word".',
      );
    },
  );

  // ── El material del curso (solo informe) ─────────────────────────────────
  //
  // La consigna, la rúbrica o el índice que dio el docente, subidos por un
  // enlace para que Claude los lea en esta conversación y en las siguientes.
  // Solo en el informe: tesis y artículo conservan sus herramientas de siempre.
  if (perfil.tipo === 'informe') {
    server.registerTool(
      'material_del_curso',
      {
        title: 'El material del encargo: del docente o de la empresa',
        description:
          'En un informe de curso, la consigna, la rúbrica o el índice (la estructura numerada) que ' +
          'dio el docente; en uno de empresa, los términos de referencia, el correo del pedido, la ' +
          'plantilla de informes o los documentos que entregó la empresa. Subidos para que los leas. ' +
          'Sin argumentos lista lo que ya subió y da un ENLACE para subir más: dáselo como enlace que se pulsa y dile ' +
          'que vuelva cuando lo haya subido. Acepta Word (.docx), PDF, Excel (.xlsx) y texto, hasta ' +
          'cinco archivos. ' +
          'Con "ver" (el número de la lista) devuelve su texto, por partes con "parte"; las líneas ' +
          '[Título N] e [Índice] son los títulos y el índice del documento: el esquema COPIA esa ' +
          'numeración, no la inventa. En un Excel, [Hoja] abre cada hoja y cada fila viene con sus ' +
          'celdas separadas por " | ": así llega casi siempre la rúbrica. ' +
          'ÚSALA cuando diga que tiene la consigna, la rúbrica, los términos de referencia, un índice ' +
          'o una plantilla con puntos numerados, y antes de revisar el informe con la rúbrica o con ' +
          'los términos. OFRÉCELE el enlace en cuanto le preguntes por lo que le pidieron, sin ' +
          'esperar a que él diga que tiene el archivo. ' +
          'Lo único que el enlace no lee es una foto o un PDF escaneado: eso que lo adjunte en este ' +
          'chat con el clip y lo lees tú. NO inventes nada que no esté en el material.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            ver: { type: 'integer', minimum: 1, description: 'Número del archivo en la lista, para leer su texto.' },
            parte: {
              type: 'integer',
              minimum: 1,
              description: 'Qué parte leer, si el archivo viene partido. La respuesta dice cuántas hay.',
            },
            quitar: {
              type: 'integer',
              minimum: 1,
              description: 'Número del archivo que se quita. Solo si el estudiante lo pide.',
            },
          },
          additionalProperties: false,
        }),
      },
      async ({ ver, parte, quitar }) => {
        await licenseService.recordUsage({ licenseId: licencia.id, tool: 'material_del_curso' });
        const userId = licencia.user.id;
        const { productCode } = licencia;

        if (quitar) {
          const quitado = await materialService.quitar(userId, productCode, quitar);
          return texto(
            quitado
              ? `Quitado «${quitado.nombre}». Los demás archivos siguen.`
              : 'No hay ningún archivo con ese número. Llama sin argumentos para ver la lista.',
          );
        }

        if (ver) {
          const leido = await materialService.leer(userId, productCode, ver, { parte });
          if (!leido) {
            return texto('No hay ningún archivo con ese número. Llama sin argumentos para ver la lista.');
          }
          const sigue =
            leido.parte < leido.partes
              ? `SIGUE: pide "parte": ${leido.parte + 1} para leer el resto.`
              : 'Es el final del archivo.';
          return texto(
            `«${leido.nombre}» · parte ${leido.parte} de ${leido.partes}${N}${N}${leido.texto}${N}${N}${sigue}`,
          );
        }

        const lista = await materialService.lista(userId, productCode);
        const { url, minutos } = subidaMaterial.enlace({ userId, productCode });
        const deEmpresa = await projectService.esInformeDeEmpresa(userId, productCode);
        const subido =
          lista.length > 0
            ? `Material subido:${N}${lista.map((m) => `${m.numero}. ${m.nombre}`).join(N)}${N}${N}` +
              'Léelo con "ver" y su número.'
            : 'Todavía no ha subido material.';

        const queSube = deEmpresa
          ? 'los términos de referencia, el correo del pedido o la plantilla de la empresa'
          : 'la consigna, la rúbrica o el índice';
        const rotulo = deEmpresa
          ? 'Haz clic aquí para subir el material del encargo'
          : 'Haz clic aquí para subir el material de tu curso';

        return texto(
          `${subido}${N}${N}Enlace para subir ${queSube}:${N}` +
            `${await darEnlace({ texto: rotulo, url, minutos })}${N}${N}` +
            'Word (.docx), PDF, Excel (.xlsx) o texto, hasta cinco archivos; uno con el mismo nombre ' +
            'reemplaza al anterior. Solo una foto o un PDF escaneado hay que adjuntarlos en este chat.',
        );
      },
    );
  }

  // ── El análisis cualitativo ──────────────────────────────────────────────
  //
  // Las entrevistas o grupos focales del tesista, subidos por un enlace y
  // partidos en párrafos. Claude las lee, propone los códigos y, cuando el
  // tesista los aprueba, los guarda; el servidor comprueba que cada cita esté
  // letra por letra en la transcripción. Es la base de las tablas, la red de
  // códigos, el capítulo y el .qdpx para ATLAS.ti.
  if (['tesis', 'articulo', 'informe'].includes(perfil.tipo)) {
    const lineaDeEntrevista = (e) =>
      `${e.id} · «${e.nombre}» · ${e.parrafos} párrafos · ` +
      (e.citas > 0 ? `${e.citas} citas codificadas` : 'sin codificar');

    server.registerTool(
      'analisis_cualitativo',
      {
        title: 'Análisis cualitativo: entrevistas y codificación',
        description:
          'Análisis cualitativo de entrevistas o grupos focales: subir las transcripciones, leerlas y ' +
          'guardar su codificación (libro de códigos y citas). ÚSALA cuando el estudio sea cualitativo ' +
          'o mixto y el usuario tenga transcripciones, o pida codificar, categorizar, hacer un análisis ' +
          'temático o «hacerlo como en ATLAS.ti». ' +
          'Sin argumentos lista las entrevistas subidas y da un ENLACE para subir más: dáselo como ' +
          'enlace que se pulsa y dile que vuelva cuando las haya subido (Word, PDF con texto o .txt, una ' +
          'entrevista por archivo). ' +
          '"ver" (con "entrevista", p. ej. "E1", y "desde") devuelve sus párrafos numerados ¶n, por ' +
          'tandas. ' +
          'ANTES DE CODIFICAR, lee sus objetivos y su metodología con "ver_capitulo" (si están ' +
          'guardados) para sacar de ahí las categorías y el enfoque; pregúntalos solo si no están. ' +
          'CÓMO SE CODIFICA: de UNA entrevista a la vez. Léela entera, propón al usuario los códigos ' +
          '(nombre, definición y categoría) y las citas de cada uno, y guarda con "codificar" SOLO cuando ' +
          'el usuario lo apruebe: nadie codifica a ciegas. Apunta a entre 5 y 12 códigos por entrevista y a no ' +
          'más de 25 o 30 en todo el libro: un código por matiz deja una red ilegible. Reutiliza los ' +
          'códigos que ya están en el libro antes de crear otros parecidos. Cada cita es un fragmento COPIADO TAL CUAL de un párrafo, sin ' +
          'resumirlo ni corregirlo: si el texto no está en ese párrafo, se rechaza la codificación ' +
          'entera y se dice qué cita falló. Cuando un fragmento habla de dos cosas, PONLE LOS DOS ' +
          'CÓDIGOS: si cada cita lleva uno solo no hay coocurrencia y la red sale en puntos sueltos. ' +
          '"codificar" REEMPLAZA ' +
          'lo que tenía esa entrevista: para corregir, vuelve a mandarla completa. ' +
          '"libro" devuelve el libro de códigos con cuántas citas y entrevistas tiene cada uno, y "citas" ' +
          '(con "codigo" o "entrevista") las citas mismas, para releerlas al revisar o al redactar. ' +
          '"buscar" (con "busca") encuentra una palabra en todas las transcripciones. ' +
          '"atributos" guarda los datos del participante de una entrevista (rol, sexo, años); con ellos, ' +
          '"tablas" añade una tabla comparativa por grupos, que es lo que sostiene frases como «los docentes ' +
          'insisten en X». ' +
          '"memo" anota lo que el usuario decide y por qué —por qué juntó dos códigos, qué le llama la ' +
          'atención de una entrevista—, "memos" los lee y "quitar_memo" borra uno; van también en el .qdpx. ' +
          '"renombrar" cambia el nombre de un código en todas sus citas; si el nombre nuevo ya existe, ' +
          'los junta. "quitar_codigo" y "quitar_entrevista" solo si el usuario lo pide. ' +
          'CUANDO TODO ESTÉ CODIFICADO: "tablas" devuelve la tabla de frecuencias y la de coocurrencia ' +
          'en Markdown, calculadas por el servidor: pégalas TAL CUAL en el capítulo, poniendo solo el ' +
          'número de tabla, y no escribas tú ninguna cifra. "red" dibuja con R la red de códigos y la ' +
          'deja como red-de-codigos.png. "capitulo" arma el Word de resultados con "titulo" y "texto" ' +
          '(Markdown: # títulos, las tablas, la figura como **Figura N** / *título* / ' +
          '![](red-de-codigos.png) / *Nota.* …, y las fuentes con su clave [AR…] si hay): organízalo por categorías u ' +
          'objetivos, ilustra cada código con lo que dijeron los entrevistados —entre comillas, o en ' +
          'bloque con "> " si pasa de 40 palabras— indicando de quién y de dónde (E3, ¶12). Antes de ' +
          'armarlo, el servidor busca cada cita en las transcripciones y, si alguna no está, no arma ' +
          'nada y dice cuál. "qdpx" da el proyecto para abrirlo ya codificado en ATLAS.ti, NVivo, ' +
          'MAXQDA o QualCoder (este último es gratis). ' +
          'NO inventes citas ni pongas en boca del entrevistado lo que no dijo.',
        inputSchema: fromJsonSchema({
          type: 'object',
          properties: {
            accion: {
              type: 'string',
              enum: [
                'ver',
                'codificar',
                'libro',
                'renombrar',
                'quitar_codigo',
                'quitar_entrevista',
                'citas',
                'buscar',
                'atributos',
                'memo',
                'memos',
                'quitar_memo',
                'tablas',
                'red',
                'capitulo',
                'qdpx',
              ],
              description: 'Qué hacer. Sin acción: la lista de entrevistas y el enlace para subir.',
            },
            entrevista: {
              type: 'string',
              description: 'La entrevista, por su número de la lista: "E1", "E2"…',
            },
            desde: {
              type: 'integer',
              minimum: 1,
              description: 'Con "ver": el párrafo desde el que leer. La respuesta dice por cuál seguir.',
            },
            codigos: {
              type: 'array',
              description:
                'Con "codificar": los códigos nuevos de esta entrevista, o los que cambian de definición o ' +
                'categoría. Los que ya están en el libro y no cambian no hace falta repetirlos.',
              items: {
                type: 'object',
                properties: {
                  nombre: { type: 'string', description: 'Corto y claro: «Falta de apoyo docente».' },
                  definicion: {
                    type: 'string',
                    description: 'Cuándo se aplica. Obligatoria en un código nuevo.',
                  },
                  categoria: { type: 'string', description: 'La categoría que lo agrupa, si la tiene.' },
                },
                required: ['nombre'],
                additionalProperties: false,
              },
            },
            citas: {
              type: 'array',
              description: 'Con "codificar": TODAS las citas de la entrevista, con sus códigos.',
              items: {
                type: 'object',
                properties: {
                  parrafo: { type: 'integer', minimum: 1, description: 'El número ¶ del párrafo.' },
                  texto: { type: 'string', description: 'El fragmento, copiado tal cual del párrafo.' },
                  codigos: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Los nombres de sus códigos, tal como están en el libro o en "codigos".',
                  },
                },
                required: ['parrafo', 'texto', 'codigos'],
                additionalProperties: false,
              },
            },
            codigo: {
              type: 'string',
              description: 'El nombre del código: con "quitar_codigo", y con "citas" para leer las suyas.',
            },
            busca: {
              type: 'string',
              description: 'Con "buscar": la palabra o frase que se busca en todas las transcripciones.',
            },
            atributos: {
              type: 'object',
              description:
                'Con "atributos": los datos del participante de esa entrevista, para comparar grupos después. ' +
                'Por ejemplo {"Rol": "Docente", "Sexo": "Mujer", "Años de experiencia": "Más de 10"}. Usa los ' +
                'mismos nombres de atributo en todas las entrevistas.',
              additionalProperties: { type: 'string' },
            },
            tipo: {
              type: 'string',
              enum: ['codigo', 'entrevista', 'analisis'],
              description: 'Con "memo" y "memos": sobre qué es la nota.',
            },
            sobre: {
              type: 'string',
              description: 'Con "memo" y "memos": el nombre del código o el número de la entrevista.',
            },
            nota: { type: 'string', description: 'Con "memo": lo que se anota.' },
            memo: { type: 'string', description: 'Con "quitar_memo": el número del memo, "m3".' },
            de: { type: 'string', description: 'Con "renombrar": el nombre actual.' },
            a: { type: 'string', description: 'Con "renombrar": el nombre nuevo, o el del código con que se junta.' },
            titulo: {
              type: 'string',
              description: 'Con "capitulo": el título, una línea por renglón: "CAPÍTULO IV\\nRESULTADOS".',
            },
            texto: { type: 'string', description: 'Con "capitulo": el capítulo entero, en Markdown.' },
            norma: {
              type: 'string',
              enum: normas.IDS_DE_NORMA,
              description:
                'Con "capitulo": la norma de citas. PREGÚNTASELA si su proyecto no tiene una. Sin ella sale ' +
                'la de su proyecto, o APA 7.',
            },
          },
          additionalProperties: false,
        }),
      },
      async ({
        accion,
        entrevista,
        desde,
        codigos,
        citas,
        codigo,
        de,
        a,
        titulo,
        texto: capitulo,
        norma,
        busca,
        atributos,
        tipo,
        sobre,
        nota,
        memo,
      }) => {
        await licenseService.recordUsage({ licenseId: licencia.id, tool: 'analisis_cualitativo' });
        const userId = licencia.user.id;
        const { productCode } = licencia;
        const noExiste = 'No hay ninguna entrevista con ese número. Llama sin argumentos para ver la lista.';
        const nadaCodificado =
          'Todavía no hay nada codificado: codifica las entrevistas con "codificar" antes.';
        /** Lo que el servidor ve mal en el libro, para que Claude lo arregle con el usuario. */
        const avisosDelLibro = (avisos) =>
          avisos ? `${N}${N}REVISA ESTO:${N}${avisos.map((a) => `- ${a}`).join(N)}` : '';
        const descarga = async (archivo, textoDelEnlace) => {
          const { url, minutos } = rEnlaces.enlaceDeDescarga({ userId, productCode, archivo });
          return await darEnlace({ texto: textoDelEnlace, url, minutos });
        };

        try {
          if (accion === 'ver') {
            const leida = await cualitativoService.ver(userId, productCode, entrevista, { desde });
            if (!leida) return texto(noExiste);
            const cuerpo = leida.parrafos.map((p) => `¶${p.numero} ${p.texto}`).join(N);
            const sigue = leida.siguiente
              ? `SIGUE: pide "desde": ${leida.siguiente} para leer el resto.`
              : 'Es el final de la entrevista.';
            return texto(`${leida.id} · «${leida.nombre}» · ${leida.total} párrafos${N}${N}${cuerpo}${N}${N}${sigue}`);
          }

          if (accion === 'codificar') {
            // Sin «citas» borraría la codificación de la entrevista: nunca por un olvido.
            if (!Array.isArray(citas) || citas.length === 0) {
              return texto('Con "codificar" manda "citas": todas las de la entrevista. No se guardó nada.');
            }
            const hecho = await cualitativoService.codificar(userId, productCode, entrevista, { codigos, citas });
            if (!hecho) return texto(noExiste);
            const nuevos = hecho.nuevos.length > 0 ? ` Códigos nuevos: ${hecho.nuevos.join('; ')}.` : '';
            return texto(
              `Guardada la codificación de ${hecho.entrevista.id} («${hecho.entrevista.nombre}»): ` +
                `${hecho.citas.length} citas, todas comprobadas contra la transcripción.${nuevos}${N}` +
                `El libro tiene ${hecho.resumen.codigos.length} códigos y ${hecho.resumen.citas} citas en total. ` +
                'Sigue con la próxima entrevista sin codificar, o usa "libro" para revisarlo con el usuario.',
            );
          }

          if (accion === 'libro') {
            const { entrevistas, resumen, avisos } = await cualitativoService.libro(userId, productCode);
            if (resumen.codigos.length === 0) {
              return texto('El libro de códigos está vacío: todavía no se codificó ninguna entrevista.');
            }
            const porCategoria = new Map();
            for (const c of resumen.codigos) {
              const cat = c.categoria ?? 'Sin categoría';
              if (!porCategoria.has(cat)) porCategoria.set(cat, []);
              porCategoria.get(cat).push(c);
            }
            const bloques = [...porCategoria].map(
              ([cat, lista]) =>
                `${cat}${N}` +
                lista
                  .map((c) => `- ${c.nombre} (${c.citas} citas, ${c.entrevistas} entrevistas): ${c.definicion}`)
                  .join(N),
            );
            return texto(
              `Libro de códigos: ${resumen.codigos.length} códigos, ${resumen.citas} citas.${N}${N}` +
                `${bloques.join(`${N}${N}`)}${N}${N}Entrevistas:${N}${entrevistas.map(lineaDeEntrevista).join(N)}` +
                avisosDelLibro(avisos),
            );
          }

          if (accion === 'citas') {
            const leidas = await cualitativoService.citasDe(userId, productCode, { codigo, entrevista, desde });
            if (!leidas) return texto(nadaCodificado);
            if (leidas.noExiste) return texto(`No hay ninguna ${leidas.noExiste}.`);
            if (leidas.total === 0) return texto(`No hay citas ${leidas.de}.`);
            const cuerpo = leidas.citas
              .map((c) => `${c.entrevista} ¶${c.parrafo} · ${c.codigos.join(' + ')}${N}«${c.texto}»`)
              .join(`${N}${N}`);
            const sigue = leidas.siguiente
              ? `SIGUE: pide "desde": ${leidas.siguiente} para leer el resto.`
              : 'No hay más.';
            return texto(`Citas ${leidas.de}: ${leidas.total}.${N}${N}${cuerpo}${N}${N}${sigue}`);
          }

          if (accion === 'buscar') {
            const hallado = await cualitativoService.buscar(userId, productCode, busca);
            if (!hallado) return texto('Todavía no hay entrevistas subidas.');
            if (hallado.corto) return texto('Busca al menos tres letras.');
            if (hallado.hallazgos.length === 0) {
              return texto(`«${hallado.buscado}» no aparece en ninguna transcripción.`);
            }
            return texto(
              `«${hallado.buscado}» aparece en ${hallado.hallazgos.length} párrafos:${N}${N}` +
                hallado.hallazgos.map((h) => `${h.entrevista} ¶${h.parrafo} · ${h.texto}`).join(N) +
                `${N}${N}Para codificar alguno, copia el fragmento tal cual en "codificar".`,
            );
          }

          if (accion === 'atributos') {
            const puesta = await cualitativoService.atributos(userId, productCode, entrevista, atributos);
            if (!puesta) return texto(noExiste);
            const pares = Object.entries(puesta.atributos).map(([n, v]) => `${n}: ${v}`);
            return texto(
              `${puesta.id} («${puesta.nombre}») queda con ${pares.join('; ')}.${N}` +
                'Con los mismos atributos en las demás entrevistas, "tablas" añade una tabla comparativa por grupos.',
            );
          }

          if (accion === 'memo') {
            const escrito = await cualitativoService.escribirMemo(userId, productCode, {
              tipo: tipo ?? 'analisis',
              sobre,
              texto: nota,
            });
            if (!escrito) return texto('Todavía no hay proyecto: sube las entrevistas antes.');
            return texto(
              `Memo ${escrito.memo.id} guardado. Es sobre: ${memosCualitativos.sobreQue(escrito.memo)}. ` +
                `Van ${escrito.total}. Se pueden leer con "memos" y van en el .qdpx.`,
            );
          }

          if (accion === 'memos') {
            const lista = await cualitativoService.memos(userId, productCode, { tipo, sobre });
            if (lista.length === 0) {
              return texto(
                'No hay memos todavía. Escribe uno con "memo" cuando el usuario decida algo que conviene ' +
                  'recordar: por qué juntó dos códigos, qué llama la atención de una entrevista, qué falta por revisar.',
              );
            }
            return texto(
              `Memos (${lista.length}):${N}${N}` +
                lista
                  .map((m) => `${m.id} · ${memosCualitativos.sobreQue(m)} · ${m.escritoAt.slice(0, 10)}${N}${m.texto}`)
                  .join(`${N}${N}`),
            );
          }

          if (accion === 'quitar_memo') {
            const quitado = await cualitativoService.quitarMemo(userId, productCode, memo);
            if (!quitado) return texto('Todavía no hay proyecto.');
            return texto(`Quitado el memo ${quitado.id}.`);
          }

          if (accion === 'renombrar') {
            const hecho = await cualitativoService.renombrar(userId, productCode, de, a);
            if (!hecho) return texto('Todavía no hay nada codificado.');
            return texto(
              hecho.junto
                ? `«${de}» se juntó con «${hecho.nombre}»: sus citas ahora llevan ese código.`
                : `El código ahora se llama «${hecho.nombre}», en todas sus citas.`,
            );
          }

          if (accion === 'quitar_codigo') {
            const hecho = await cualitativoService.quitarCodigo(userId, productCode, codigo);
            if (!hecho) return texto('Todavía no hay nada codificado.');
            return texto(
              `Quitado el código «${hecho.nombre}».` +
                (hecho.citasQuitadas > 0
                  ? ` ${hecho.citasQuitadas} citas se quedaron sin código y se quitaron también.`
                  : ''),
            );
          }


          if (accion === 'tablas') {
            const hechas = await cualitativoService.tablas(userId, productCode);
            if (!hechas) return texto(nadaCodificado);
            return texto(
              'Tablas calculadas por el servidor. Pégalas TAL CUAL en el capítulo: cambia solo la X por ' +
                'el número de tabla que les toque y cítalas en el texto antes de que aparezcan.' +
                `${N}${N}${hechas.frecuencias}${N}${N}` +
                (hechas.coocurrencia ??
                  'Ningún par de códigos comparte una cita, así que no hay tabla de coocurrencia: dilo así ' +
                    'en el capítulo si hace falta.') +
                (hechas.porGrupos.length > 0
                  ? `${N}${N}${hechas.porGrupos.map((t) => t.markdown).join(`${N}${N}`)}`
                  : `${N}${N}Sin atributos de los participantes no hay tabla comparativa. Si el estudio compara ` +
                    'grupos (docentes y estudiantes, hombres y mujeres), ponlos con "atributos" en cada entrevista.') +
                avisosDelLibro(hechas.avisos),
            );
          }

          if (accion === 'red') {
            const dibujada = await cualitativoService.red(userId, productCode);
            if (!dibujada) return texto(nadaCodificado);
            if (dibujada.error) {
              return texto(`R no pudo dibujar la red. No se guardó nada.${N}${dibujada.error}`);
            }
            return texto(
              `Red dibujada: ${dibujada.codigos} códigos y ${dibujada.lazos} lazos de coocurrencia` +
                (dibujada.omitidos > 0 ? ` (se dejaron fuera ${dibujada.omitidos} códigos con menos citas).` : '.') +
                `${N}Para ponerla en el capítulo, usa este bloque, con su número de figura:${N}${N}` +
                `**Figura N**${N}*Red de coocurrencia de los códigos*${N}![](${dibujada.archivo})${N}` +
                '*Nota.* El tamaño de cada código indica su número de citas; el grosor de cada línea, las ' +
                'citas que comparten dos códigos; el color, su categoría. Elaborado en R.' +
                `${N}${N}Si el usuario quiere verla ya: ${await descarga(dibujada.archivo, 'Haz clic aquí para ver la red de códigos')}` +
                avisosDelLibro(dibujada.avisos),
            );
          }

          if (accion === 'capitulo') {
            if (!String(capitulo ?? '').trim()) {
              return texto('Con "capitulo" manda el capítulo entero en "texto". No se armó nada.');
            }
            const armado = await cualitativoService.capitulo(userId, productCode, {
              titulo,
              texto: capitulo,
              norma,
            });
            if (!armado) return texto(nadaCodificado);
            if (armado.comprobadas.faltan.length > 0) {
              return texto(
                `NO SE ARMÓ EL WORD: ${armado.comprobadas.faltan.length} citas no están en ninguna ` +
                  `transcripción:${N}${armado.comprobadas.faltan.map((c) => `- «${c.slice(0, 160)}»`).join(N)}` +
                  `${N}${N}Cópialas tal cual de la entrevista (con "ver"), marca los cortes con […], o ` +
                  'quítalas. Luego vuelve a mandar el capítulo.',
              );
            }
            if (armado.faltanFiguras.length > 0) {
              return texto(
                `NO SE ARMÓ EL WORD: faltan las figuras ${armado.faltanFiguras.join(', ')}. La red de ` +
                  'códigos se genera con "red" y se llama red-de-codigos.png.',
              );
            }
            const partes = [
              `Capítulo listo: ${armado.tablas} tablas, ${armado.figuras} figuras y ` +
                `${armado.comprobadas.revisadas} citas textuales, todas encontradas en las transcripciones. ` +
                `Citas bibliográficas en ${armado.norma.nombre}.`,
              `Enlace para bajarlo:${N}${descarga(armado.archivo, 'Haz clic aquí para descargar tu capítulo en Word')}`,
            ];
            if (armado.perdidas.length > 0) {
              partes.push(
                `OJO: ${armado.perdidas.length} citas bibliográficas no corresponden a ninguna de sus ` +
                  `fuentes (${armado.perdidas.join(', ')}) y salen marcadas en el Word.`,
              );
            }
            partes.push(
              'Si quiere que forme parte de su tesis, guarda ESTE MISMO texto con "guardar_capitulo" en el ' +
                'capítulo de resultados: la red se incrusta sola en el Word de la tesis.',
            );
            return texto(partes.join(`${N}${N}`));
          }

          if (accion === 'qdpx') {
            const exportado = await cualitativoService.qdpx(userId, productCode);
            if (!exportado) return texto(nadaCodificado);
            return texto(
              `Proyecto listo: ${exportado.entrevistas} entrevistas, ${exportado.codigos} códigos y ` +
                `${exportado.citas} citas.${N}` +
                `${descarga(exportado.archivo, 'Haz clic aquí para descargar tu proyecto (.qdpx)')}${N}${N}` +
                'Dile cómo abrirlo: en ATLAS.ti, «Importar proyecto REFI-QDA»; en NVivo y MAXQDA, ' +
                '«Importar proyecto de intercambio QDA (REFI-QDA)»; en QualCoder, que es gratis, ' +
                '«Importar proyecto REFI-QDA». Encontrará sus entrevistas con los códigos puestos.',
            );
          }

          if (accion === 'quitar_entrevista') {
            const quitada = await cualitativoService.quitarEntrevista(userId, productCode, entrevista);
            if (!quitada) return texto(noExiste);
            return texto(
              `Quitada ${quitada.id} («${quitada.nombre}»)` +
                (quitada.citas > 0 ? `, con sus ${quitada.citas} citas.` : '.'),
            );
          }
        } catch (error) {
          if (error instanceof cualitativoService.SinMotor) {
            return texto(
              'El servidor de R no está disponible ahora mismo, y hace falta para la red, el Word y el ' +
                '.qdpx. No se generó nada. Díselo con normalidad y sigue con la codificación o con otra parte.',
            );
          }
          if (error instanceof CodificacionNoValida) {
            return texto(
              `No se guardó nada: ${error.errores.length === 1 ? 'hay un problema' : `hay ${error.errores.length} problemas`}.${N}` +
                `${error.errores.map((e) => `- ${e}`).join(N)}${N}${N}` +
                (accion === 'codificar'
                  ? 'Corrígelos y vuelve a mandar la entrevista completa.'
                  : 'Corrígelo y vuelve a intentarlo.'),
            );
          }
          throw error;
        }

        const lista = await cualitativoService.lista(userId, productCode);
        const { url, minutos } = subidaEntrevistas.enlace({ userId, productCode });
        const subidas =
          lista.length > 0
            ? `Entrevistas subidas:${N}${lista.map(lineaDeEntrevista).join(N)}${N}${N}Léelas con "ver".`
            : 'Todavía no ha subido ninguna entrevista.';
        return texto(
          `${subidas}${N}${N}Enlace para subir entrevistas o grupos focales:${N}` +
            `${await darEnlace({ texto: 'Haz clic aquí para subir tus entrevistas', url, minutos })}${N}${N}` +
            'Word, PDF con texto o .txt; una entrevista por archivo y hasta ' +
            `${cualitativoService.MAXIMO_ENTREVISTAS}. Una con el mismo nombre de archivo reemplaza a la anterior.`,
        );
      },
    );
  }

  // ── El Word, desde la conversación ───────────────────────────────────────
  //
  // Sin esto, quien terminaba un capítulo hablando con Claude no tenía el Word
  // a mano, y Claude acababa armándoselo por su cuenta: sin la norma del
  // proyecto, sin la bibliografía de las fichas y sin campos de Zotero.
  server.registerTool(
    'enlace_del_word',
    {
      title: 'Enlace para descargar la tesis en Word',
      description:
        'Da un enlace para descargar la tesis en Word, armada por el servidor con todo lo ' +
        'guardado: portada, índice, capítulos en orden, y las citas y las referencias ya ' +
        'escritas en la norma del proyecto —en notas al pie si la norma lo pide, y ' +
        'enlazadas a Zotero si el tesista lo conectó—. ' +
        'ÚSALA cuando pida su Word, su documento o descargar, y después de guardar un ' +
        'capítulo. NUNCA ARMES TÚ EL WORD NI ESCRIBAS TÚ LA BIBLIOGRAFÍA: el tuyo no ' +
        'llevaría la norma ni los campos de Zotero, y podría no coincidir con las fichas. ' +
        'Si el tesista SUBIÓ su propio documento, el enlace es el de ese documento con las citas ' +
        'y los párrafos humanizados puestos. ' +
        'El enlace caduca a la media hora; si ya pasó, pide otro.',
      inputSchema: fromJsonSchema({ type: 'object', properties: {}, additionalProperties: false }),
    },
    async () => {
      await licenseService.recordUsage({ licenseId: licencia.id, tool: 'enlace_del_word' });

      const resultado = await projectService.enlaceDelWord(licencia.user.id, licencia.productCode);

      // Si subió su propio documento para citar, «su Word» es ese.
      const subido = await documentoService.enlace(licencia.user.id, licencia.productCode);
      if (subido) {
        const { norma } = subido;
        return texto(
          `Enlace para descargar SU DOCUMENTO con lo humanizado, las citas y la lista de referencias:${N}` +
            await darEnlace({ texto: 'Haz clic aquí para descargar tu documento', url: subido.url, minutos: subido.minutos }) +
            `${N}${N}` +
            (norma.familia === 'notas'
              ? `OJO: la norma del proyecto es ${norma.nombre}, de notas al pie, y en un documento ` +
                'subido no se pueden poner: el enlace dará error. Pregúntale otra norma y guárdala ' +
                `con "guardar_avance" (estiloCitas) antes de dárselo.${N}${N}`
              : `Las citas salen en ${norma.nombre}` +
                (norma.elegida
                  ? `.${N}${N}`
                  : ', la de por defecto: nadie eligió otra. Si su universidad pide otra, ' +
                    `pregúntasela y guárdala con "guardar_avance" (estiloCitas).${N}${N}`)) +
            'Es SU MISMO WORD, con su formato, sus tablas y sus figuras: solo cambian los párrafos ' +
            'humanizados, y se añadieron las citas, lo marcado [falta fuente] en amarillo y la ' +
            'lista de referencias. NO le prepares tú otro documento.' +
            (resultado
              ? `${N}${N}Aparte, la tesis armada con los capítulos del método:${N}` +
                await darEnlace({ texto: 'Haz clic aquí para descargar la tesis del método', url: resultado.url })
              : ''),
        );
      }

      if (!resultado) {
        /**
         * Y se le dice POR QUÉ, o vuelve a llamar.
         *
         * Con el mensaje corto de antes, un asistente al que su skill le manda
         * entregar el Word al cerrar la Fase 1 pidió el enlace seis veces
         * seguidas: leía «no hay nada guardado», sabía que acababa de guardar
         * 400 palabras, y lo intentaba otra vez.
         */
        return texto(
          `${SU_OBRA.toUpperCase()} NO TIENE NINGÚN CAPÍTULO TODAVÍA, así que no hay Word que ` +
            'descargar, y volver a llamar a esta herramienta dará lo mismo: NO INSISTAS. ' +
            'La propuesta de tema, el cuestionario y la bitácora del trabajo de campo se ' +
            'guardan en su proyecto, pero no son capítulos del documento: el Word empieza en ' +
            'el Capítulo I. Díselo así de claro, enséñale en el chat lo que habéis trabajado, ' +
            'y NO le armes tú un documento. Cuando guardes un capítulo con "guardar_capitulo", ' +
            'el Word existe.',
        );
      }

      const { url, minutos, norma } = resultado;
      return texto(
        `Enlace para descargar la tesis en Word:${N}` +
          `${await darEnlace({ texto: 'Haz clic aquí para descargar tu Word', url, minutos })}${N}${N}` +
          `Las citas y las referencias salen en ${norma.nombre}` +
          (norma.elegida ? `.${N}${N}` : `, que es la de por defecto: nadie ha elegido otra.${N}${N}`) +
          (norma.elegida
            ? ''
            : 'Si su universidad pide otra norma, pregúntale cuál y guárdala con ' +
              '"guardar_avance" (estiloCitas) antes de que lo descargue. ') +
          'NO le prepares tú otro documento.',
      );
    },
  );

  return server;
}

module.exports = { construirServidor, NOMBRE_SERVIDOR, VERSION_SERVIDOR };
