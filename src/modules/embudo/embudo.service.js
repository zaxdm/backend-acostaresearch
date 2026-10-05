'use strict';

const prisma = require('../../lib/prisma');
const logger = require('../../config/logger');

/**
 * El embudo de venta: de ver los precios a terminar una fase.
 *
 * Solo el primer paso se apunta aparte (`VisitaEmbudo`): pasa antes de que
 * haya cuenta y no dejaba rastro en ninguna parte. Todo lo demás se cuenta con
 * lo que ya guarda la base —pagos, licencias, fases—, así que el embudo sale
 * bien también hacia atrás, para los meses anteriores a este módulo (salvo las
 * visitas, que empiezan a contar el día que se despliega).
 *
 * Del segundo paso en adelante se mira una COHORTE: las licencias que nacieron
 * en el periodo, y de ellas cuántas llegaron a usar Claude y cuántas cerraron
 * una fase. Contar «quién terminó una fase este mes» mezclaría a compradores de
 * hace medio año con los de ahora y no diría nada de si la compra de hoy
 * funciona.
 *
 * Fuera siempre: los administradores (tienen licencias de todo, emitidas solas)
 * y los invitados de los enlaces de prueba (no son personas con cuenta).
 */

/** Perú: UTC−5 todo el año. */
const DESFASE_LIMA_MS = 5 * 60 * 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

/** Las páginas que se apuntan. Una lista cerrada: nadie mete basura en la tabla. */
const PAGINAS = ['planes'];

/** El día de Lima de una fecha, como medianoche UTC (lo que guarda un DATE). */
function diaDeLima(fecha = new Date()) {
  const enLima = new Date(fecha.getTime() - DESFASE_LIMA_MS);
  return new Date(Date.UTC(enLima.getUTCFullYear(), enLima.getUTCMonth(), enLima.getUTCDate()));
}

/** El periodo que se mira: los últimos `dias` días de Lima, hoy incluido. */
function periodo(dias, ahora = new Date()) {
  const hoy = diaDeLima(ahora);
  const primerDia = new Date(hoy.getTime() - (dias - 1) * DIA_MS);
  // Los DATE se comparan con días; las marcas de tiempo, con el instante en que
  // empieza ese día en Lima.
  return { primerDia, hoy, desde: new Date(primerDia.getTime() + DESFASE_LIMA_MS) };
}

/** Solo clientes de verdad: ni administradores ni invitados de prueba. */
const CLIENTE = { role: 'USER', trialLinkId: null };

/** Porcentaje entero de `parte` sobre `total`, o null si no hay total. */
function tasa(parte, total) {
  return total > 0 ? Math.round((parte / total) * 100) : null;
}

const embudoService = {
  /**
   * Apunta que alguien vio una página del embudo. Una vez por visitante y día:
   * la segunda choca con la clave única y no pasa nada.
   *
   * Nunca falla hacia fuera: esto no puede estropear la página de precios.
   */
  async registrarVisita({ visitante, pagina, userId = null, origen = null }) {
    if (!PAGINAS.includes(pagina)) return;

    try {
      await prisma.visitaEmbudo.create({
        data: { visitante, pagina, dia: diaDeLima(), userId, origen },
      });
    } catch (error) {
      if (error?.code === 'P2002') return; // ya estaba apuntado hoy
      logger.warn({ err: error }, 'No se pudo apuntar la visita del embudo');
    }
  },

  /** El embudo de los últimos `dias` días, para el panel. */
  async resumen({ dias = 30, ahora = new Date() } = {}) {
    const { primerDia, hoy, desde } = periodo(dias, ahora);

    const [visitas, cuentas, empezaronPago, licencias, referidos, avisos] = await Promise.all([
      prisma.visitaEmbudo.groupBy({
        by: ['visitante'],
        where: { pagina: 'planes', dia: { gte: primerDia, lte: hoy } },
      }),
      prisma.user.count({ where: { ...CLIENTE, createdAt: { gte: desde } } }),
      // Abrir PayPal o Culqi, o mandar un Yape: quiso pagar el método, lo
      // lograra o no.
      prisma.payment.groupBy({
        by: ['userId'],
        where: {
          createdAt: { gte: desde },
          plan: { kind: 'LICENSE' },
          provider: { in: ['PAYPAL', 'CULQI', 'YAPE', 'WESTERN_UNION'] },
          user: CLIENTE,
        },
      }),
      prisma.license.findMany({
        where: { createdAt: { gte: desde }, user: CLIENTE },
        select: {
          userId: true,
          productCode: true,
          callsTotal: true,
          activationCodeId: true,
          grupoId: true,
        },
      }),
      prisma.referido.groupBy({
        by: ['estado'],
        where: { createdAt: { gte: desde } },
        _count: { _all: true },
      }),
      prisma.avisoAvance.groupBy({
        by: ['tipo'],
        where: { enviadoAt: { gte: desde } },
        _count: { _all: true },
      }),
    ]);

    // Una persona puede tener dos licencias (tesis y artículo): se cuenta a la
    // persona, que es quien entra en el embudo.
    const compradores = new Map();
    for (const licencia of licencias) {
      const previo = compradores.get(licencia.userId);
      compradores.set(licencia.userId, {
        conecto: Boolean(previo?.conecto) || licencia.callsTotal > 0,
        productos: [...(previo?.productos ?? []), licencia.productCode],
        via: previo?.via ?? (licencia.grupoId ? 'grupo' : licencia.activationCodeId ? 'codigo' : 'web'),
      });
    }

    // Quién cerró al menos una fase de lo que compró en el periodo.
    const conFase = new Set();
    if (compradores.size > 0) {
      const proyectos = await prisma.project.findMany({
        where: {
          userId: { in: [...compradores.keys()] },
          stages: { some: { estado: 'LISTO' } },
        },
        select: { userId: true, productCode: true },
      });
      for (const proyecto of proyectos) {
        if (compradores.get(proyecto.userId)?.productos.includes(proyecto.productCode)) {
          conFase.add(proyecto.userId);
        }
      }
    }

    const personas = [...compradores.values()];
    const pagaron = personas.length;
    const conectaron = personas.filter((p) => p.conecto).length;
    const porVia = { web: 0, codigo: 0, grupo: 0 };
    for (const p of personas) porVia[p.via] += 1;

    const pasos = [
      { id: 'planes', texto: 'Vieron /planes', valor: visitas.length },
      { id: 'cuenta', texto: 'Crearon su cuenta', valor: cuentas },
      { id: 'pago', texto: 'Empezaron a pagar', valor: empezaronPago.length },
      { id: 'pagaron', texto: 'Recibieron el método', valor: pagaron },
      { id: 'conectaron', texto: 'Conectaron Claude', valor: conectaron },
      { id: 'fase', texto: 'Terminaron una fase', valor: conFase.size },
    ].map((paso, i, todos) => ({
      ...paso,
      // Respecto al paso anterior. Puede pasar de 100: quien entra por un
      // código o por un grupo recibe el método sin haber pasado por el pago.
      tasa: i === 0 ? null : tasa(paso.valor, todos[i - 1].valor),
    }));

    const cuenta = (filas, clave) =>
      Object.fromEntries(filas.map((fila) => [fila[clave], fila._count._all]));

    return {
      dias,
      desde: primerDia.toISOString().slice(0, 10),
      hasta: hoy.toISOString().slice(0, 10),
      pasos,
      porVia,
      // De los que recibieron el método, qué parte llegó a usarlo y a cerrar
      // una fase: las dos cifras que dicen si lo comprado se aprovecha.
      activacion: tasa(conectaron, pagaron),
      avance: tasa(conFase.size, pagaron),
      referidos: cuenta(referidos, 'estado'),
      avisos: cuenta(avisos, 'tipo'),
    };
  },
};

module.exports = embudoService;
module.exports.diaDeLima = diaDeLima;
module.exports.periodo = periodo;
module.exports.PAGINAS = PAGINAS;
