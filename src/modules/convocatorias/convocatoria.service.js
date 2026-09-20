'use strict';

const crypto = require('node:crypto');

const env = require('../../config/env');
const prisma = require('../../lib/prisma');
const { NotFoundError } = require('../../shared/errors/AppError');

/**
 * La puerta: un enlace que se reparte a mano y dos interruptores.
 *
 * POR QUÉ ESTÁ AQUÍ Y NO EN CADA MÓDULO
 * -------------------------------------
 * Los dos lados del servicio necesitan exactamente lo mismo: una página que
 * está desplegada y funcionando pero que no encuentra quien no fue invitado, y
 * que se abre al público con un clic en vez de con un despliegue. Duplicar esa
 * mecánica en dos módulos sería duplicar también el día que haya que cambiarla,
 * y entonces uno de los dos se quedaría atrás.
 *
 * `abierta` dice si admite envíos; `publica`, si se llega sin el enlace. El
 * `tipo` dice a qué formulario abre y a qué URL se reparte.
 */

/** El mismo alfabeto que los enlaces de prueba: sin letras que se confundan. */
const ALFABETO = 'abcdefghjkmnpqrstuvwxyz23456789';
const LARGO_SLUG = 12;

function generarSlug() {
  let slug = '';
  for (let i = 0; i < LARGO_SLUG; i += 1) {
    slug += ALFABETO[crypto.randomInt(0, ALFABETO.length)];
  }
  return slug;
}

/** A qué página lleva cada tipo. */
const RUTA = { ASESORES: 'asesores', REVISION: 'revision' };

function urlDe(tipo, slug) {
  return `${env.APP_URL.replace(/\/+$/, '')}/${RUTA[tipo] ?? RUTA.ASESORES}/${slug}`;
}

const convocatoriaSelect = {
  id: true,
  tipo: true,
  slug: true,
  nombre: true,
  intro: true,
  abierta: true,
  publica: true,
  createdAt: true,
};

/** Lo que se le enseña a quien abre el enlace. */
const salidaPublica = (convocatoria) => ({
  slug: convocatoria.slug,
  nombre: convocatoria.nombre,
  intro: convocatoria.intro,
  abierta: convocatoria.abierta,
});

/**
 * La convocatoria de un enlace.
 *
 * Cerrada se devuelve igual, con `abierta` en falso: quien llega tarde con un
 * enlace que le pasó un colega merece leer «ya no recibimos» y no un 404, que
 * parece una web rota. Un slug del otro tipo sí es un 404: el enlace de los
 * asesores no puede abrir el formulario de los tesistas.
 */
async function ver(tipo, slug) {
  const convocatoria = await prisma.convocatoria.findUnique({
    where: { slug },
    select: convocatoriaSelect,
  });
  if (!convocatoria || convocatoria.tipo !== tipo) {
    throw new NotFoundError('Ese enlace no existe o ya no está disponible.');
  }
  return salidaPublica(convocatoria);
}

/**
 * La abierta al público, si la hay.
 *
 * Es lo que contesta la página sin slug. Mientras ninguna esté marcada como
 * pública devuelve nulo y la web se comporta como si no existiera, que es lo
 * que se quiere mientras el piloto esté cerrado.
 */
async function publica(tipo) {
  const convocatoria = await prisma.convocatoria.findFirst({
    where: { tipo, publica: true, abierta: true },
    orderBy: { createdAt: 'desc' },
    select: convocatoriaSelect,
  });
  return convocatoria ? salidaPublica(convocatoria) : null;
}

/**
 * La que hay detrás de un enlace, para quien va a escribir por él.
 *
 * Devuelve el id y si admite envíos; que el enlace no valga o esté cerrado lo
 * decide quien llama, porque el mensaje cambia según el formulario.
 */
async function paraEnviar(tipo, slug) {
  const convocatoria = await prisma.convocatoria.findUnique({
    where: { slug },
    select: { id: true, tipo: true, abierta: true },
  });
  if (!convocatoria || convocatoria.tipo !== tipo) return null;
  return convocatoria;
}

/** Una convocatoria nueva. Nace abierta y NO pública: el enlace es la llave. */
async function crear(tipo, { nombre, intro }, adminId) {
  const convocatoria = await prisma.convocatoria.create({
    data: {
      tipo,
      slug: generarSlug(),
      nombre,
      intro: intro ?? '',
      createdById: adminId ?? null,
    },
    select: convocatoriaSelect,
  });
  return { ...convocatoria, url: urlDe(convocatoria.tipo, convocatoria.slug) };
}

/** Cerrarla, abrirla o hacerla pública. Lo que no venga, no se toca. */
async function cambiar(id, cambios) {
  const existe = await prisma.convocatoria.findUnique({ where: { id }, select: { id: true } });
  if (!existe) throw new NotFoundError('Esa convocatoria no existe.');

  const convocatoria = await prisma.convocatoria.update({
    where: { id },
    data: cambios,
    select: convocatoriaSelect,
  });
  return { ...convocatoria, url: urlDe(convocatoria.tipo, convocatoria.slug) };
}

/** Las de un tipo, la más nueva primero, ya con su enlace montado. */
async function listar(tipo) {
  const filas = await prisma.convocatoria.findMany({
    where: { tipo },
    orderBy: { createdAt: 'desc' },
    select: convocatoriaSelect,
  });
  return filas.map((fila) => ({ ...fila, url: urlDe(fila.tipo, fila.slug) }));
}

module.exports = { ver, publica, paraEnviar, crear, cambiar, listar, urlDe, generarSlug };
