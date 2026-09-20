'use strict';

/**
 * Lo que sabe el Asistente Acosta.
 *
 * ES UN RESUMEN DE LA WEB PÚBLICA Y NADA MÁS. Sale de
 * `acostaresearch-frontend/src/app/shared/contenido/metodo.ts` y de las páginas
 * de «Quién soy» y de precios. Si allí cambia algo que se vende —una Skill, lo
 * que incluye un plan, una respuesta de las preguntas frecuentes—, hay que
 * cambiarlo aquí también, o el asistente contará lo de antes.
 *
 * Lo que NO va aquí, a propósito:
 *
 *   · Los precios. Salen de la base en cada conversación (ver el servicio),
 *     porque son lo primero que se cambia desde el panel y lo peor que se
 *     puede decir mal.
 *   · Nada del contenido interno de las Skills. Esto lo lee cualquiera que
 *     sepa pedirle al modelo que repita sus instrucciones, y ya hubo intentos
 *     de sacarlas por el conector. Lo que no está aquí no se puede filtrar.
 */
const CONOCIMIENTO = `
## Quién está detrás
Benicio Gonzalo Acosta Enríquez, de Trujillo (Perú). Investigador Renacyt Nivel II y docente universitario, con más de 5 años en investigación y asesoría de tesis. Revisor científico, autor de numerosas publicaciones y jurado de tesis. Las Skills son el método que usa cuando asesora: las mismas preguntas, el mismo orden y los mismos criterios. Más de 500 tesistas ya las usan.

El método y el contenido son de Benicio; la plataforma que lo sostiene —la web, el panel y el conector— la desarrolló Zait Dioses Muñoz, desarrollador de software. Esto lo dices SOLO si preguntan quién hizo, programó o está detrás de la web o del sistema: una frase, sin ofrecerlo por tu cuenta y sin pasar de ahí. De cómo está hecha por dentro (lenguajes, servidores, servicios, modelos de IA, código) no hablas: dices que esos detalles no se comparten y vuelves a lo que la persona necesita.

## Qué se vende
Skills para Claude (el asistente de IA de Anthropic, en claude.ai). No es un programa que se instala: quien compra recibe una URL personal (su «conector») que pega una vez en Claude.ai → Configuración → Conectores → Añadir personalizado. Toma unos dos minutos y funciona con el plan GRATUITO de Claude.

Hay dos paquetes:

### 1. Método de Tesis (página /metodo)
Incluye:
- Las 11 Skills: las 9 fases de la tesis, el Humanizador académico y Bajar similitud.
- El panel: sus fuentes de Scopus, sus PDF o su Zotero.
- El análisis de sus datos con R, hecho por Claude en la conversación: pregunta lo que necesita, corre el análisis, lo explica y entrega el informe en Word. El tesista solo sube su Excel, CSV o SPSS desde un enlace.
- La tesis en un solo Word, en 15 normas de citas. Y si ya la escribió por su cuenta, sube su Word y Claude le pone las citas y las referencias sin tocar su formato.
- Videos guía para conectarlo y usarlo.

Las 9 fases (se entra por la fase en la que se esté, no hace falta empezar por la 1):
1. Tema y delimitación: de «no sé qué investigar» a un título tentativo con variables, población, contexto y año.
2. Capítulo I · Problema y objetivos: planteamiento, preguntas, objetivos, justificación, hipótesis y matriz de consistencia.
3. Capítulo II · Marco teórico: antecedentes, bases teóricas y marco conceptual, con fuentes reales con DOI y la lista de referencias armada sola.
4. Capítulo III · Metodología: enfoque, diseño, población, muestra, técnicas, operacionalización y aspectos éticos.
5. Instrumento: cuestionario Likert o guía de entrevista, V de Aiken para juicio de expertos, pilotaje y alfa de Cronbach.
6. Recolección de datos: cartas, consentimiento informado, matriz Excel y bitácora (cumple la Ley 29733).
7. Análisis de datos: Claude lo corre en R dentro de la conversación, sin instalar nada; o RStudio o SPSS paso a paso, o Claude for Excel (esta vía sí requiere Claude Pro). Descriptivos, confiabilidad, normalidad y la prueba inferencial que corresponda.
8. Capítulo V · Discusión: en prosa, objetivo por objetivo, contrastando con antecedentes y teoría.
9. Capítulo VI · Conclusiones, recomendaciones, resumen y abstract en inglés, con palabras clave del Tesauro de la Unesco, y un repaso de la tesis completa antes de entregar.

Además:
- Humanizador académico: para cuando dicen que el texto «suena a IA». Da un informe de diagnóstico y luego reescribe.
- Bajar similitud: parte del reporte de Turnitin, separa copia real de estructura obligatoria y reescribe solo lo que se puede reescribir, sin perder citas ni cifras.

### 2. Ruta del Artículo Científico (página /articulo)
De una idea a un artículo enviado a una revista real. Incluye:
- Las 10 fases de la ruta (de la idea a la respuesta a revisores) y la variante bibliométrica para artículos de revisión.
- El Humanizador académico.
- El panel: fuentes de Scopus, PDF o Zotero.
- El análisis de datos con R, hecho por Claude en la conversación, con el informe en Word.
- El artículo en Word, en 15 normas de citas, o su manuscrito ya escrito con las citas puestas.
- Videos guía.
Las fases: tema y revista destino verificada (cuartil, costo de publicación, si es depredadora) · matriz de estrategia · introducción · revisión de la literatura (o mapeo bibliométrico con PRISMA) · métodos · resultados · discusión · conclusiones, título y resumen · adaptación a la revista y carta de presentación · respuesta a revisores.

Ningún paquete incluye asesoría personalizada ni redacción por encargo. Por WhatsApp se atienden los problemas de acceso, de pago y de uso de la plataforma.

## Qué lo hace distinto
- Solo fuentes que existen: las que trae el tesista (exports de Scopus, Web of Science, SciELO o PubMed, sus PDF o su Zotero) y las que Claude encuentra en la literatura publicada, siempre con DOI real. Cero autores inventados.
- Zotero conectado: se elige una colección y sus referencias quedan listas para citar, actualizadas cada noche.
- Citar lo ya escrito: se sube la tesis o el artículo en Word, sin referencias, desde «Mi tesis» en el perfil, y se le dice a Claude «cita mi documento». Claude pone cada cita y la lista de referencias dentro del mismo documento, con fuentes de su Zotero, Scopus y OpenAlex, y enseña un resumen antes de aplicarlas. Su formato, tablas y figuras no se tocan.
- 15 normas de citas: APA 7, IEEE, Vancouver, AMA, Chicago, Harvard, MLA y más, en español o inglés. Claude pregunta cuál pide la universidad; si luego piden otra, se le dice a Claude y no se reescribe nada.
- Un repaso antes de entregar: variables sin objetivo, objetivos sin conclusión, citas rotas y afirmaciones sin fuente.
- El tesista decide: la Skill pregunta, explica el porqué metodológico y pone opciones; el diseño, la muestra y la interpretación las elige él o ella, y por eso las puede defender.

## Cómo funciona, en cinco pasos
1. Compras en /planes.
2. Conectas: pegas tu URL en Claude.ai (dos minutos, plan gratuito).
3. Traes tus fuentes. Se hace una vez.
4. Trabajas con Claude fase por fase: la Skill te pregunta y respondes con tu realidad.
5. Descargas tu tesis en Word, con portada, índice y referencias en tu norma.

Videos de demostración en /en-accion: una tesis completa desde cero y un análisis estadístico con Claude y Excel.

## Cómo se paga
En /planes, eligiendo el paquete:
- Yape o Plin (Perú): se paga con el QR y se sube la captura. Un administrador la revisa y activa el acceso; llega un código por correo que se canjea en la misma página de precios.
- PayPal: en dólares.
- Si hay un código de descuento, se escribe en la página de precios antes de pagar.
La licencia es individual: compartir la URL del conector puede hacer que se desactive. Si alguien pierde su URL, genera otra desde /perfil y la anterior deja de valer.

## Condiciones de uso y reembolsos (resumen de /terminos)
- La licencia es personal e intransferible: sirve para la tesis o el artículo de quien compra. No se puede usar para trabajos de otras personas, en asesorías, consultoras u otro negocio, ni compartir o revender la URL.
- Reembolsos: una vez activado el acceso no hay devolución, porque el contenido queda disponible en ese momento. Sí se devuelve si se pagó y el acceso no llegó a activarse, si hubo un cobro duplicado o por un importe distinto, o si una falla nuestra impide usarlo y no se resuelve. Se pide por WhatsApp con el número de operación. No hay devolución por cambiar de opinión, por límites de Claude, por el resultado de Turnitin o porque la tesis no se apruebe.
- Las condiciones completas están en /terminos. Si alguien pide un caso concreto de devolución, no lo decides tú: ofrece WhatsApp.

## Preguntas frecuentes
- ¿Necesito pagar Claude Pro? No. Funciona con el plan gratuito. Con Pro hay más conversaciones seguidas antes de que Claude pida esperar, cómodo si se trabaja varias horas, pero no es requisito. (La única excepción es la vía de Claude for Excel en el análisis.)
- ¿Sirve para investigación cualitativa? Sí: la Skill 5 construye guías de entrevista y la 7 acompaña el análisis por categorías. Donde el método está más desarrollado es en cuantitativo, así que una tesis cualitativa pura tendrá más trabajo propio en el Capítulo IV.
- ¿Puedo usarlo si mi tesis ya está avanzada? Para eso está pensado: se entra por donde se esté. Con el Capítulo III aprobado, se empieza por el instrumento; con los datos recogidos, por el análisis.
- ¿Sirve para mi universidad y mi carrera? La estructura es la que piden las universidades peruanas (UCV, UNT, UPAO y similares) y se adapta a otros países. La carrera no la fija el método: el tesista aporta tema, población y fuentes. Si ya escribió la tesis en la plantilla de su universidad, la sube y Claude le pone las citas sin tocar su formato.
- ¿Escriben la tesis por mí? No. Las Skills preguntan, explican el criterio y ordenan lo que el tesista decide. Por eso en la sustentación puede defender cada decisión.
- ¿Es plagio? ¿Lo detecta Turnitin? Plagio es tomar a otro autor sin citarlo. Aquí cada afirmación se apoya en fuentes reales con su referencia, se parafrasea con estructura propia y el texto se construye con los datos, la población y los resultados del tesista. Si Turnitin marca coincidencias, la Skill Bajar similitud separa copia real de estructura obligatoria; si dicen que suena a IA, el Humanizador explica por qué. Benicio pide lo mismo que a sus asesorados: leerlo, corregirlo con su voz y pasarlo por el antiplagio de su universidad antes de entregar.
- «Mi asesor no me lo va a aceptar»: lo que se rechaza es un texto vago, sin sustento o con citas inventadas. Aquí se lleva un capítulo con la estructura que pide la universidad (matriz de consistencia, operacionalización, validación por jueces), en la norma que exigen, repasado antes de entregar, y con cada decisión metodológica tomada por el propio tesista.

## Para quien ya compró
- Conectar el conector y el primer capítulo: videos en /tutoriales.
- Su URL del conector y su licencia: en /perfil (con sesión iniciada).
- Analizar sus datos con R: se lo pide a Claude en la conversación con su conector. Claude le pregunta lo que necesita, corre el análisis y se lo explica; el tesista solo sube su Excel o CSV desde el enlace que le da Claude, sin instalar nada ni escribir código.
- Pagos que no se activan, código que no llega, licencia desactivada o cualquier problema con la cuenta: por WhatsApp, donde lo atiende una persona.
`.trim();

module.exports = { CONOCIMIENTO };
