'use strict';

const prisma = require('../../lib/prisma');

/**
 * Topes de uso del conector.
 *
 * Dos decisiones que conviene tener presentes:
 *
 * 1. EL TOPE QUE IMPORTA ES EL DE GASTO. Cada llamada a `redactar` carga una
 *    skill que puede pesar 30 000 tokens, y no todas pesan igual: treinta
 *    consultas al capítulo de Metodología cuestan varias veces más que treinta
 *    a Conclusiones. Contar llamadas aproxima mal el coste; contar céntimos no.
 *    El tope de llamadas se mantiene igualmente como freno de abuso por ráfaga.
 *
 * 2. HAY TOPES QUE NO SE REINICIAN. El método se vende con acceso permanente,
 *    y sobre un producto que no caduca un tope mensual no tiene fondo: doce
 *    meses de uso cuestan doce veces el mes, y a la larga supera lo cobrado.
 *    Por eso existen los totales, que se acumulan desde el primer día y no
 *    vuelven a cero. El acceso es para siempre; el uso incluido, finito.
 *
 * 3. EL DÍA ES EL DEL COMPRADOR, NO EL DEL SERVIDOR. Los sellos se calculan en
 *    hora de Lima. Si el servidor acaba desplegado en Europa, el contador
 *    seguiría reiniciándose a medianoche peruana, que es cuando el tesista
 *    espera volver a tener cupo.
 */

const ZONA = 'America/Lima';

const formateador = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function selloDia(fecha = new Date()) {
  return formateador.format(fecha); // YYYY-MM-DD
}

function selloMes(fecha = new Date()) {
  return selloDia(fecha).slice(0, 7); // YYYY-MM
}

/** Contador vacío, para una licencia que aún no ha hecho ninguna llamada. */
function contadorVacio(dia, mes) {
  return {
    callsToday: 0,
    callsMonth: 0,
    costCentsToday: 0,
    costCentsMonth: 0,
    callsLifetime: 0,
    costCentsLifetime: 0,
    dayStamp: dia,
    monthStamp: mes,
  };
}

/**
 * Estado actual del contador, ya normalizado.
 *
 * Si el sello guardado no es el de hoy, los valores de ese periodo se leen como
 * cero sin escribir nada: el reinicio ocurre al vuelo, y no hace falta ningún
 * proceso programado que vaya poniendo contadores a cero cada medianoche.
 */
async function estado(licenseId, ahora = new Date()) {
  const dia = selloDia(ahora);
  const mes = selloMes(ahora);

  const fila = await prisma.licenseCounter.findUnique({ where: { licenseId } });
  if (!fila) return contadorVacio(dia, mes);

  const mismoDia = fila.dayStamp === dia;
  const mismoMes = fila.monthStamp === mes;

  return {
    callsToday: mismoDia ? fila.callsToday : 0,
    callsMonth: mismoMes ? fila.callsMonth : 0,
    costCentsToday: mismoDia ? fila.costCentsToday : 0,
    costCentsMonth: mismoMes ? fila.costCentsMonth : 0,
    // Los totales no dependen del sello: nunca se reinician.
    callsLifetime: fila.callsLifetime,
    costCentsLifetime: fila.costCentsLifetime,
    dayStamp: dia,
    monthStamp: mes,
  };
}

/**
 * ¿Puede esta licencia hacer una llamada más?
 *
 * Devuelve el motivo en lenguaje llano, porque va directo al tesista a través
 * de su Claude: un código de error no le sirve de nada.
 */
async function comprobar(licencia, ahora = new Date()) {
  const contador = await estado(licencia.id, ahora);

  // El total va primero: si se agotó, decírselo es más útil que hablarle del
  // cupo de hoy, porque mañana seguirá agotado.
  if (licencia.callsLimitTotal > 0 && contador.callsLifetime >= licencia.callsLimitTotal) {
    // Un invitado no compró nada: hablarle de «tu compra» le confunde, y lo
    // que le sirve saber es por dónde se sigue.
    const motivo = licencia.user?.trialLink
      ? `Has usado las ${licencia.callsLimitTotal} consultas de esta prueba. ` +
        'Si quieres seguir, tienes los planes en acostaresearch.com/planes.'
      : `Has usado las ${licencia.callsLimitTotal} consultas incluidas en tu compra. ` +
        'Tu acceso sigue activo: escríbenos para ampliarlo y sigues donde lo dejaste.';
    return { permitido: false, motivo, contador };
  }

  if (
    licencia.costCentsLimitTotal > 0 &&
    contador.costCentsLifetime >= licencia.costCentsLimitTotal
  ) {
    return {
      permitido: false,
      motivo:
        'Has agotado el uso incluido en tu compra. Tu acceso sigue activo: ' +
        'escríbenos para ampliarlo y sigues donde lo dejaste.',
      contador,
    };
  }

  if (licencia.callsPerDay > 0 && contador.callsToday >= licencia.callsPerDay) {
    return {
      permitido: false,
      motivo:
        `Has alcanzado el límite de ${licencia.callsPerDay} consultas de hoy. ` +
        'Vuelve mañana o escríbenos si necesitas más.',
      contador,
    };
  }

  if (licencia.callsPerMonth > 0 && contador.callsMonth >= licencia.callsPerMonth) {
    return {
      permitido: false,
      motivo:
        `Has alcanzado el límite de ${licencia.callsPerMonth} consultas de este mes. ` +
        'Escríbenos para ampliarlo.',
      contador,
    };
  }

  if (licencia.costCentsPerMonth > 0 && contador.costCentsMonth >= licencia.costCentsPerMonth) {
    return {
      permitido: false,
      motivo:
        'Has agotado el uso incluido en tu plan de este mes. ' +
        'Escríbenos y vemos cómo seguir.',
      contador,
    };
  }

  return { permitido: true, contador };
}

/**
 * Suma una llamada al contador.
 *
 * Va en transacción porque dos llamadas simultáneas de la misma licencia
 * podrían leer el mismo valor y escribir el mismo incremento, perdiendo una.
 *
 * El coste se suma DESPUÉS de la llamada, con el consumo real. Eso significa
 * que la llamada que cruza el tope se cobra igualmente: no hay forma de saber
 * lo que va a costar una respuesta antes de pedirla. El desvío es de una
 * llamada, y se prefiere eso a cortar por una estimación.
 */
async function registrar(licenseId, { costCents = 0 } = {}, ahora = new Date()) {
  const dia = selloDia(ahora);
  const mes = selloMes(ahora);

  return prisma.$transaction(async (tx) => {
    const fila = await tx.licenseCounter.findUnique({ where: { licenseId } });

    if (!fila) {
      return tx.licenseCounter.create({
        data: {
          licenseId,
          dayStamp: dia,
          monthStamp: mes,
          callsToday: 1,
          callsMonth: 1,
          costCentsToday: costCents,
          costCentsMonth: costCents,
          callsLifetime: 1,
          costCentsLifetime: costCents,
        },
      });
    }

    const mismoDia = fila.dayStamp === dia;
    const mismoMes = fila.monthStamp === mes;

    return tx.licenseCounter.update({
      where: { licenseId },
      data: {
        dayStamp: dia,
        monthStamp: mes,
        callsToday: (mismoDia ? fila.callsToday : 0) + 1,
        callsMonth: (mismoMes ? fila.callsMonth : 0) + 1,
        costCentsToday: (mismoDia ? fila.costCentsToday : 0) + costCents,
        costCentsMonth: (mismoMes ? fila.costCentsMonth : 0) + costCents,
        // Los acumulados no miran el sello: siempre suman.
        callsLifetime: fila.callsLifetime + 1,
        costCentsLifetime: fila.costCentsLifetime + costCents,
      },
    });
  });
}

/** Resumen para el panel del comprador y el del administrador. */
async function resumen(licencia) {
  const contador = await estado(licencia.id);

  return {
    callsToday: contador.callsToday,
    callsMonth: contador.callsMonth,
    costCentsMonth: contador.costCentsMonth,
    callsLifetime: contador.callsLifetime,
    limits: {
      callsPerDay: licencia.callsPerDay,
      callsPerMonth: licencia.callsPerMonth,
      costCentsPerMonth: licencia.costCentsPerMonth,
      callsLimitTotal: licencia.callsLimitTotal,
      costCentsLimitTotal: licencia.costCentsLimitTotal,
    },
  };
}

/**
 * El cupo, dicho de forma que no se pueda leer al revés.
 *
 * Antes esto decía «Hoy llevas 0 de 500 consultas». El dato era correcto —el
 * tope es diario— pero la frase no pone la palabra «día» al lado del número, y
 * quien la resume se queda con «límite de 500 consultas» y le atribuye el
 * periodo que le parece. En software lo habitual es mensual, así que se lee
 * mensual. Pasó de verdad: el asistente le dijo al comprador que tenía «500
 * consultas al mes» teniendo 500 al día.
 *
 * Ahora el periodo va pegado al número y en la misma frase. La cantidad y su
 * unidad no se separan nunca: es la regla que evita este error entero.
 */
function describirCupo(uso) {
  const lineas = [];
  const { limits } = uso;

  if (limits.callsPerDay > 0) {
    lineas.push(
      `Puede hacer ${limits.callsPerDay} consultas CADA DÍA. ` +
        `Hoy lleva ${uso.callsToday} de esas ${limits.callsPerDay}.`,
    );
  }

  if (limits.callsPerMonth > 0) {
    lineas.push(
      `Puede hacer ${limits.callsPerMonth} consultas CADA MES. ` +
        `Este mes lleva ${uso.callsMonth} de esas ${limits.callsPerMonth}.`,
    );
  }

  // El tope de por vida no se mencionaba nunca, ni existiendo. Alguien podía
  // agotarlo sin haber visto jamás que estaba ahí.
  if (limits.callsLimitTotal > 0) {
    lineas.push(
      `Tope total de la licencia: ${limits.callsLimitTotal} consultas en toda su vida. ` +
        `Lleva ${uso.callsLifetime}.`,
    );
  }

  return lineas;
}

module.exports = { comprobar, registrar, estado, resumen, describirCupo, selloDia, selloMes };
