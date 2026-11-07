'use strict';

const prisma = require('../../lib/prisma');
const vinculos = require('./acostaia.vinculos');

/**
 * Lo que AcostaIA enseña fuera del chat: «Mis fuentes» y «Mis documentos».
 *
 * Son los MISMOS datos que ve Claude por el conector (`mis_fuentes`,
 * `mi_proyecto`, `enlace_del_word`): se leen con las mismas funciones, del
 * titular espejo del usuario de AcostaIA. Así la pantalla y la conversación no
 * pueden contar cosas distintas.
 *
 * Los servicios de proyectos se piden dentro de cada función y no arriba: tiran
 * de medio backend, y esta ruta se carga al arrancar.
 */

/** El titular espejo de ese usuario de AcostaIA, o null si aún no abrió ningún chat. */
async function titularDe(acostaiaId) {
  return prisma.user.findUnique({ where: { acostaiaId }, select: { id: true } });
}

/**
 * De qué cuenta se leen los datos de ese producto: la del comprador si vinculó
 * su compra (7-nov-2026, ver `acostaia.vinculos`), si no la del titular espejo.
 * Así la pantalla enseña la misma tesis que trabaja el chat.
 */
async function cuentaDelProducto(acostaiaId, productCode) {
  const vinculo = (await vinculos.vigentes(acostaiaId)).find((v) => v.productCode === productCode);
  if (vinculo) return { id: vinculo.userId };
  return titularDe(acostaiaId);
}

/** Para lo que no es de un producto (sus fuentes): la del último vínculo, o la espejo. */
async function cuentaPrincipal(acostaiaId) {
  const [vinculo] = await vinculos.vigentes(acostaiaId);
  if (vinculo) return { id: vinculo.userId };
  return titularDe(acostaiaId);
}

/** Los productos de los que tiene licencia activa: solo esos se enseñan. */
async function productosActivos(userId) {
  const licencias = await prisma.license.findMany({
    where: { userId, status: 'ACTIVE' },
    select: { productCode: true },
  });
  return new Set(licencias.map((l) => l.productCode));
}

const acostaiaDatos = {
  /** Su biblioteca propia (Zotero, Mendeley, Scopus, por DOI…), por páginas. */
  async fuentes({ acostaiaId, pagina = 1, origen = 'todas' }) {
    const titular = await cuentaPrincipal(acostaiaId);
    if (!titular) return { total: 0, pagina: 1, paginas: 1, fuentes: [] };

    const propiasService = require('../references/propias.service');
    const b = await propiasService.biblioteca(titular.id, { pagina, origen });
    return {
      total: b.total,
      deZotero: b.deZotero,
      deMendeley: b.deMendeley,
      subidas: b.subidas,
      zotero: b.zotero,
      mendeley: b.mendeley,
      origen: b.origen,
      pagina: b.pagina,
      paginas: b.paginas,
      enElFiltro: b.enElFiltro,
      fuentes: b.fuentes.map((f) => ({
        clave: f.ref,
        titulo: f.title,
        autores: f.authors,
        anio: f.year,
        origen: f.origin,
      })),
    };
  },

  /**
   * Sus trabajos (uno por producto con licencia activa): tema, en qué fase va
   * cada capítulo, si ya hay Word y si subió su propio documento.
   */
  async documentos({ acostaiaId }) {
    const titular = await titularDe(acostaiaId);
    const vinculados = await vinculos.vigentes(acostaiaId);
    if (!titular && !vinculados.length) return [];

    const projectRepository = require('../projects/project.repository');
    const skillService = require('../skills/skill.service');
    const projectService = require('../projects/project.service');
    const documentoService = require('../projects/documento.service');

    // De qué cuenta sale cada producto: los vinculados, de la del comprador;
    // el resto, de la espejo.
    const cuentas = [];
    const deComprador = new Set(vinculados.map((v) => v.productCode));
    if (titular) {
      const activos = await productosActivos(titular.id);
      for (const codigo of deComprador) activos.delete(codigo);
      cuentas.push({ userId: titular.id, productos: activos });
    }
    for (const v of vinculados) cuentas.push({ userId: v.userId, productos: new Set([v.productCode]) });

    // Uno por producto: el activo (el que se trabaja en el chat).
    const porProducto = new Map();
    for (const cuenta of cuentas) {
      const proyectos = await projectRepository.listarDeUsuario(cuenta.userId);
      for (const p of proyectos) {
        if (!cuenta.productos.has(p.productCode)) continue;
        const otro = porProducto.get(p.productCode);
        if (!otro || p.activadaAt > otro.activadaAt) porProducto.set(p.productCode, { ...p, userId: cuenta.userId });
      }
    }

    const salida = [];
    for (const proyecto of porProducto.values()) {
      const catalogo = await skillService.listCatalog(proyecto.productCode);
      const etapas = new Map(proyecto.stages.map((e) => [e.skillCode, e]));
      const fases = catalogo.map((s) => {
        const e = etapas.get(s.code);
        return {
          codigo: s.code,
          nombre: s.displayName,
          estado: e?.estado ?? 'PENDIENTE',
          palabras: e?.palabras ?? 0,
        };
      });

      const [word, subido] = await Promise.all([
        projectService.enlaceDelWord(proyecto.userId, proyecto.productCode).catch(() => null),
        documentoService.enlace(proyecto.userId, proyecto.productCode).catch(() => null),
      ]);

      salida.push({
        productCode: proyecto.productCode,
        nombre: proyecto.nombre,
        tema: proyecto.tema,
        universidad: proyecto.universidad,
        actualizado: proyecto.updatedAt,
        fases,
        palabras: fases.reduce((s, f) => s + f.palabras, 0),
        hayWord: Boolean(word),
        haySubido: Boolean(subido),
      });
    }
    return salida.sort((a, b) => b.actualizado - a.actualizado);
  },

  /**
   * Un enlace recién firmado para descargar (caduca a la media hora): el Word
   * armado con sus capítulos (`word`) o el documento que subió (`documento`).
   * Null si no hay nada que descargar.
   */
  /**
   * El permiso para subir su avance desde AcostaIA (de su PC, de Google Drive o
   * de OneDrive): el MISMO token del enlace de `subir_mi_documento`, que vale
   * media hora. El servidor de AcostaIA manda el archivo a
   * `POST /proyectos/documento-enlace/:token`, la subida de siempre (citas,
   * formato de su Word y capítulos a sus fases). Null si no tiene ese producto.
   */
  async subida({ acostaiaId, productCode }) {
    const titular = await cuentaDelProducto(acostaiaId, productCode);
    if (!titular) return null;
    if (!(await productosActivos(titular.id)).has(productCode)) return null;
    const subidaDocumento = require('../projects/project.subida-documento');
    const { url, minutos } = subidaDocumento.enlace({ userId: titular.id, productCode });
    return { token: url.split('/').pop(), minutos };
  },

  /**
   * El permiso para subir su base de datos (Excel, CSV o SPSS) a la sesión de
   * análisis desde AcostaIA (7-nov-2026): el MISMO token del enlace de subida
   * de `trabajar_en_r` (media hora). El servidor de AcostaIA manda el archivo a
   * `POST /r/subir/:token`, la subida de siempre. Null si no tiene ese producto.
   */
  async datosR({ acostaiaId, productCode }) {
    const titular = await cuentaDelProducto(acostaiaId, productCode);
    if (!titular) return null;
    if (!(await productosActivos(titular.id)).has(productCode)) return null;
    const { enlaceDeSubida } = require('../r/r.enlaces');
    const { url, minutos } = enlaceDeSubida({ userId: titular.id, productCode });
    return { token: url.split('/').pop(), minutos };
  },

  async enlace({ acostaiaId, productCode, que }) {
    const titular = await cuentaDelProducto(acostaiaId, productCode);
    if (!titular) return null;
    if (!(await productosActivos(titular.id)).has(productCode)) return null;

    if (que === 'documento') {
      const documentoService = require('../projects/documento.service');
      const subido = await documentoService.enlace(titular.id, productCode);
      return subido ? { url: subido.url, minutos: subido.minutos } : null;
    }
    const projectService = require('../projects/project.service');
    const word = await projectService.enlaceDelWord(titular.id, productCode);
    return word ? { url: word.url, minutos: word.minutos } : null;
  },
};

module.exports = acostaiaDatos;
