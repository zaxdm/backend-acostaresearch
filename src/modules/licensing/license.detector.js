'use strict';

/**
 * Motor de detección de licencias compartidas.
 *
 * AVISO IMPORTANTE SOBRE LO QUE NO SE PUEDE MEDIR
 * ------------------------------------------------
 * No hay señal de ubicación ni de IP del comprador. Claude no llama a este
 * servidor desde el equipo del usuario: llama desde la infraestructura de
 * Anthropic, así que TODAS las peticiones llegan del mismo rango de direcciones
 * (160.79.104.0/21), sea quien sea quien esté preguntando y desde donde sea.
 * Contar "ubicaciones distintas por token" daría siempre uno.
 *
 * Lo que sí distingue a un token repartido entre varias personas:
 *
 *   1. VOLUMEN CONTRA SU PROPIO HISTÓRICO. Un tesista consulta a ratos durante
 *      semanas. Si un token que venía haciendo 4 llamadas al día hace 40 en un
 *      día, no es que el tesista se haya vuelto más aplicado.
 *
 *      Esta señal EXIGE que exista ese histórico. Sin él la mediana vale cero,
 *      todo se compara contra el suelo, y cualquiera que estrene su licencia y
 *      la use con ganas queda marcado. No es hipotético: de las doce primeras
 *      alertas del sistema, siete decían literalmente "su mediana diaria es 0"
 *      y todas eran de licencias con menos de tres días de vida. Un comprador
 *      recién llegado no tiene con qué compararse, y decir eso en voz alta es
 *      más útil que inventarse una sospecha.
 *
 *   2. SESIONES SOLAPADAS. Dos conversaciones distintas vivas a la vez sobre el
 *      mismo token. Una persona no sostiene dos chats en paralelo minuto a
 *      minuto; dos personas sí. Es la señal más difícil de disimular.
 *
 *   3. INCOHERENCIA EN LA MISMA VENTANA. Dos consultas en el mismo minuto sobre
 *      temas que no tienen nada que ver. Se compara por hash: no hace falta
 *      guardar lo que escribió el tesista para saber que son cosas distintas.
 *
 * La señal 1 funciona siempre. Las señales 2 y 3 dependen de que el cliente
 * mande un identificador de sesión; si no llega, el detector se queda cojo y
 * solo mira volumen. Eso está reflejado en `fiabilidad`.
 */

const NIVELES = Object.freeze({
  NORMAL: 'NORMAL',
  ALERTA: 'ALERTA',
  SOSPECHA_ALTA: 'SOSPECHA_ALTA',
});

/** Dos llamadas separadas por menos de esto se consideran solapadas. */
const SOLAPE_SEGUNDOS = 90;

/** Suelo de llamadas diarias por debajo del cual no se sospecha de nadie. */
const SUELO_DIARIO = 12;

/** Multiplicadores sobre la mediana histórica del propio comprador. */
const FACTOR_ALERTA = 3;
const FACTOR_SOSPECHA = 5;

/**
 * Días de uso previo que hacen falta para que el volumen signifique algo.
 *
 * Por debajo de esto no se emite ninguna señal de volumen, por muchas llamadas
 * que haya: no hay contra qué compararlas. Siete días es aproximadamente una
 * semana de trabajo del tesista, que ya deja ver si es de sentarse de golpe o
 * de ir a ratos.
 */
const MINIMO_DIAS_HISTORICO = 7;

/**
 * Pares de consultas incoherentes en 24 h antes de sospechar.
 *
 * Estaba en uno, y uno es ruido: un tesista que pregunta por el capítulo II y
 * acto seguido por el IV produce exactamente esa señal. Tres pares en un día ya
 * cuesta más de explicar con una sola persona.
 */
const INCOHERENTES_SOSPECHA = 3;

/** Sesiones distintas en 24 h a partir de las cuales salta cada nivel. */
const SESIONES_ALERTA = 3;
const SESIONES_SOSPECHA = 6;

/** Solapes reales antes de dar por hecho que hay más de una persona. */
const SOLAPES_SOSPECHA = 3;

const DIA_MS = 24 * 60 * 60 * 1000;

function mediana(valores) {
  if (valores.length === 0) return 0;
  const orden = [...valores].sort((a, b) => a - b);
  const medio = Math.floor(orden.length / 2);
  return orden.length % 2 === 0 ? (orden[medio - 1] + orden[medio]) / 2 : orden[medio];
}

/** Llamadas por día natural, excluyendo el día en curso. */
function historicoDiario(usos, ahora) {
  const inicioDeHoy = ahora.getTime() - DIA_MS;
  const porDia = new Map();

  for (const uso of usos) {
    const t = uso.createdAt.getTime();
    if (t >= inicioDeHoy) continue;
    const dia = Math.floor(t / DIA_MS);
    porDia.set(dia, (porDia.get(dia) ?? 0) + 1);
  }

  return [...porDia.values()];
}

/**
 * Pares de llamadas cercanas en el tiempo que vienen de sesiones distintas.
 * Se recorre en orden y se compara cada llamada con la anterior: basta con eso
 * para detectar dos conversaciones intercaladas.
 */
function contarSolapes(usos) {
  let solapes = 0;
  let incoherentes = 0;

  for (let i = 1; i < usos.length; i += 1) {
    const anterior = usos[i - 1];
    const actual = usos[i];
    const separacion = (actual.createdAt.getTime() - anterior.createdAt.getTime()) / 1000;

    if (separacion > SOLAPE_SEGUNDOS) continue;

    if (anterior.sessionId && actual.sessionId && anterior.sessionId !== actual.sessionId) {
      solapes += 1;
    }

    // Mismo minuto, temas distintos: difícil de explicar con una sola persona.
    if (
      separacion <= 60 &&
      anterior.promptHash &&
      actual.promptHash &&
      anterior.promptHash !== actual.promptHash &&
      anterior.sessionId !== actual.sessionId
    ) {
      incoherentes += 1;
    }
  }

  return { solapes, incoherentes };
}

/**
 * Analiza el uso reciente de una licencia y devuelve un nivel, las señales que
 * lo justifican y las métricas crudas para poder revisarlo a mano.
 *
 * Devuelve un diagnóstico; NO revoca nada. La decisión de revocar es del
 * servicio, que además avisa: castigar a un cliente legítimo por una alerta
 * automática sale más caro que dejar correr una sospecha unos días.
 */
function analizar(usos, { ahora = new Date() } = {}) {
  // Se ordena aquí y no se da por supuesto: comparar llamadas consecutivas sin
  // orden cronológico da separaciones negativas y cuenta como solapadas cosas
  // que ocurrieron con horas de diferencia.
  const ventana24 = usos
    .filter((u) => ahora.getTime() - u.createdAt.getTime() <= DIA_MS)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const llamadas24 = ventana24.length;

  const diario = historicoDiario(usos, ahora);
  const medianaDiaria = mediana(diario);

  const sesiones24 = new Set(ventana24.map((u) => u.sessionId).filter(Boolean));
  const { solapes, incoherentes } = contarSolapes(ventana24);

  const umbralAlerta = Math.max(SUELO_DIARIO, medianaDiaria * FACTOR_ALERTA);
  const umbralSospecha = Math.max(SUELO_DIARIO * 2, medianaDiaria * FACTOR_SOSPECHA);

  const senales = [];

  // Sin días suficientes detrás, la mediana no describe a nadie y el volumen
  // solo mide entusiasmo. Se calla la señal entera en vez de rebajarla: media
  // sospecha sobre un cliente que acaba de pagar no vale nada y ofende.
  const hayConQueComparar = diario.length >= MINIMO_DIAS_HISTORICO && medianaDiaria > 0;

  if (hayConQueComparar) {
    if (llamadas24 >= umbralSospecha) {
      senales.push({
        codigo: 'VOLUMEN_DISPARADO',
        detalle: `${llamadas24} llamadas en 24 h; su mediana diaria es ${medianaDiaria}.`,
        peso: 'alto',
      });
    } else if (llamadas24 >= umbralAlerta) {
      senales.push({
        codigo: 'VOLUMEN_ALTO',
        detalle: `${llamadas24} llamadas en 24 h; su mediana diaria es ${medianaDiaria}.`,
        peso: 'medio',
      });
    }
  }

  if (sesiones24.size >= SESIONES_SOSPECHA) {
    senales.push({
      codigo: 'MUCHAS_SESIONES',
      detalle: `${sesiones24.size} conversaciones distintas en 24 h.`,
      peso: 'alto',
    });
  } else if (sesiones24.size >= SESIONES_ALERTA) {
    senales.push({
      codigo: 'VARIAS_SESIONES',
      detalle: `${sesiones24.size} conversaciones distintas en 24 h.`,
      peso: 'medio',
    });
  }

  if (solapes >= SOLAPES_SOSPECHA) {
    senales.push({
      codigo: 'SESIONES_SOLAPADAS',
      detalle: `${solapes} llamadas de sesiones distintas separadas por menos de ${SOLAPE_SEGUNDOS} s.`,
      peso: 'alto',
    });
  }

  if (incoherentes >= INCOHERENTES_SOSPECHA) {
    senales.push({
      codigo: 'CONSULTAS_INCOHERENTES',
      detalle: `${incoherentes} pares de consultas en el mismo minuto sobre temas distintos.`,
      peso: 'alto',
    });
  }

  const altas = senales.filter((s) => s.peso === 'alto').length;
  let nivel = NIVELES.NORMAL;
  if (altas >= 2) nivel = NIVELES.SOSPECHA_ALTA;
  else if (senales.length > 0) nivel = NIVELES.ALERTA;

  return {
    nivel,
    senales,
    // Hacen falta las dos familias de señal para fiarse: el volumen sin
    // histórico no dice nada, y sin identificador de sesión solo queda el
    // volumen, que por sí solo se confunde con un tesista en semana de entrega.
    fiabilidad: sesiones24.size > 0 && hayConQueComparar ? 'normal' : 'limitada',
    metricas: {
      llamadas24,
      medianaDiaria,
      diasConHistorico: diario.length,
      // Se expone para que el panel pueda explicar por qué no hay señal de
      // volumen, en lugar de dejar pensar que el comprador es intachable.
      hayConQueComparar,
      sesionesDistintas24: sesiones24.size,
      solapes,
      incoherentes,
      umbralAlerta,
      umbralSospecha,
    },
  };
}

module.exports = { analizar, NIVELES, SOLAPE_SEGUNDOS };
