'use strict';

/**
 * Avisa por correo a quien está a punto de quedarse sin acceso.
 *
 * Por qué es un script y no algo dentro de la aplicación: la vigilancia de
 * licencias se dispara cuando alguien usa la suya, y eso aquí no sirve. La
 * licencia que caduca sin que nadie se entere es justo la que lleva semanas sin
 * usarse. Hace falta algo que mire el calendario, no el tráfico.
 *
 * Corre una vez al día desde un temporizador de systemd, a las 8 de la mañana
 * de Lima. Nunca a la vez que el respaldo ni que una sincronización de Zotero:
 * el plan de la base de datos da cinco conexiones y no sobra ninguna.
 *
 * Uso:  npm run licencias:avisar          manda los correos
 *       npm run licencias:avisar -- --ver   enseña a quién avisaría y no manda
 */

const prisma = require('../src/lib/prisma');
const { sendMail } = require('../src/lib/mailer');
const plantillas = require('../src/lib/emailTemplates');

/**
 * Días de antelación del aviso.
 *
 * Quince días dan tiempo a organizarse sin que el correo llegue tan pronto que
 * se olvide. Se avisa una sola vez: insistir cada semana a alguien que ya lo
 * sabe es lo que hace que se marque el remitente como no deseado.
 */
const DIAS_DE_AVISO = 15;

const DIA_MS = 24 * 60 * 60 * 1000;
const soloVer = process.argv.includes('--ver');

/** El nombre que reconoce el comprador, no el código interno. */
async function nombresDeProducto() {
  const planes = await prisma.plan.findMany({
    where: { productCode: { not: null } },
    select: { productCode: true, name: true },
  });

  const porCodigo = new Map();
  for (const p of planes) if (!porCodigo.has(p.productCode)) porCodigo.set(p.productCode, p.name);
  return porCodigo;
}

async function principal() {
  const ahora = new Date();
  const limite = new Date(ahora.getTime() + DIAS_DE_AVISO * DIA_MS);

  const licencias = await prisma.license.findMany({
    where: {
      revokedAt: null,
      expiryWarnedAt: null,
      // Ya caducadas, no: a esas el aviso llega tarde y suena a burla.
      expiresAt: { gt: ahora, lte: limite },
    },
    select: {
      id: true,
      productCode: true,
      expiresAt: true,
      user: { select: { email: true, firstName: true } },
    },
    orderBy: { expiresAt: 'asc' },
  });

  if (licencias.length === 0) {
    console.log(`${ahora.toISOString().slice(0, 19)}  nadie caduca en los próximos ${DIAS_DE_AVISO} días`);
    return;
  }

  const nombres = await nombresDeProducto();
  let enviados = 0;
  let fallados = 0;
  let sinCorreo = 0;

  for (const licencia of licencias) {
    const dias = Math.max(1, Math.ceil((licencia.expiresAt - ahora) / DIA_MS));
    const planName = nombres.get(licencia.productCode) ?? 'tu acceso al método';

    if (!licencia.user?.email) {
      // Sin correo no hay aviso posible. No se marca como avisada: si algún día
      // esa cuenta recupera su correo, todavía puede recibirlo.
      sinCorreo += 1;
      continue;
    }

    if (soloVer) {
      console.log(`  avisaría a ${licencia.user.email} · ${planName} · en ${dias} días`);
      continue;
    }

    try {
      await sendMail({
        to: licencia.user.email,
        ...plantillas.licenseExpiring({
          firstName: licencia.user.firstName ?? 'Hola',
          planName,
          expiresAt: licencia.expiresAt,
          dias,
        }),
      });

      // Se marca DESPUÉS de que el correo salga. Al revés, un fallo del
      // proveedor dejaría al comprador marcado como avisado sin haberlo sido, y
      // nadie volvería a intentarlo nunca.
      await prisma.license.update({
        where: { id: licencia.id },
        data: { expiryWarnedAt: new Date() },
      });

      enviados += 1;
    } catch (error) {
      // Un correo que falla no puede llevarse por delante los que faltan.
      fallados += 1;
      console.error(`  ERROR con ${licencia.user.email}: ${error.message}`);
    }
  }

  const resumen = [
    `${enviados} avisados`,
    fallados > 0 ? `${fallados} fallaron` : null,
    sinCorreo > 0 ? `${sinCorreo} sin correo` : null,
  ]
    .filter(Boolean)
    .join(', ');

  console.log(`${ahora.toISOString().slice(0, 19)}  ${soloVer ? 'prueba: ' : ''}${resumen}`);

  // Que el temporizador lo vea como fallo si nadie recibió nada de lo que debía.
  if (!soloVer && fallados > 0 && enviados === 0) process.exitCode = 1;
}

principal()
  .catch((error) => {
    console.error('No se pudo avisar de las caducidades:', error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
