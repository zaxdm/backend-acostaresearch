'use strict';

/**
 * Cómo se conversa con el tesista, sea cual sea la fase o el producto.
 *
 * Nace del 27-oct-2026. Las skills de tesis pedían preguntas con opciones para
 * tocar, pero las de artículo, revisión, informe y TSP casi nunca lo decían, así
 * que los botones salían o no según la fase. Además las opciones llegaban
 * peladas («Cuantitativo · Cualitativo · Mixto») y el tesista elegía a ciegas, y
 * al cerrar una fase nadie le ofrecía la siguiente: volvía a la web a copiar la
 * frase.
 *
 * Va en dos sitios a propósito:
 * - en las instrucciones del servidor, que algunas IA leen al conectar;
 * - pegado al primer tramo de cada fase en `redactar`, porque lo que devuelve
 *   una herramienta lo leen todas.
 *
 * Es breve a propósito: lo que se repite largo se acaba ignorando.
 */

const REGLAS_DE_CONVERSACION = [
  'CÓMO CONVERSAR CON EL TESISTA (vale para toda la fase, por encima de cualquier costumbre tuya):',
  '',
  '1. Toda pregunta con respuestas previsibles va con OPCIONES PARA TOCAR, con la herramienta de ' +
    'preguntas con opciones que tengas en esta plataforma. Si no tienes ninguna, una lista numerada ' +
    'corta («responde con el número»). Hasta 3 preguntas juntas en un mismo turno, nunca una por mensaje.',
  '2. Cada opción con un término técnico (enfoque, alcance, diseño, tipo, muestreo, instrumento, ' +
    'validez, confiabilidad, prueba estadística…) lleva en la misma opción qué es, en una línea sencilla, ' +
    'y un ejemplo con SU tema. Ejemplo: «Cuantitativo: mides con números (encuestas, registros) para ver ' +
    'si dos cosas se relacionan o si una causa la otra».',
  '3. En toda pregunta difícil, la última opción es «No sé, ayúdame a decidir». Si la elige, hazle dos ' +
    'o tres preguntas fáciles y recomiéndale una con su porqué.',
  '4. Opciones concretas, no genéricas: en vez de «completar lo que falta», di qué falta. Si una opción ' +
    'borra o rehace algo ya aprobado, dilo en la misma opción y confirma antes de hacerlo.',
  '5. Al cerrar la fase: guárdala, pregúntale con opciones si la da por terminada (si dice que sí, ' +
    '"guardar_avance" con estado LISTO) y ofrécele seguir AQUÍ MISMO con la siguiente: si acepta, llama a ' +
    '"continuar" y ábrela con "redactar". No lo mandes a la web a copiar otra frase.',
].join('\n');

/**
 * Lo que el servidor declara al conectarse. Algunas IA lo cargan antes de la
 * primera herramienta; por eso nombra «continuar» como puerta de entrada.
 */
const INSTRUCCIONES_DEL_SERVIDOR = [
  'Conector del método de Acosta | IA & Research para tesis, informes, artículos y trabajos de ' +
    'suficiencia profesional.',
  'Cuando el usuario hable de su tesis o su trabajo, de una fase o capítulo, de «el método» o de ' +
    'seguir por donde iba, llama primero a "continuar" (o a "redactar" si nombra una fase concreta) en ' +
    'vez de contestar por tu cuenta.',
  '',
  REGLAS_DE_CONVERSACION,
].join('\n');

module.exports = { REGLAS_DE_CONVERSACION, INSTRUCCIONES_DEL_SERVIDOR };
