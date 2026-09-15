'use strict';

/**
 * El material del curso de un proyecto: guardar, listar, leer y quitar.
 *
 * Va en su propio archivo JSON del proyecto, con el texto ya extraído: leerlo no
 * vuelve a abrir ningún Word. Hasta `MAXIMO_ARCHIVOS`; uno con el mismo nombre
 * reemplaza al anterior, porque lo normal es volver a subir la consigna corregida.
 *
 * Las escrituras van de una en una por proyecto, como las del documento subido:
 * dos subidas a la vez se pisarían la lista.
 */

const projectRepository = require('./project.repository');
const almacen = require('./project.storage');
const { enSerie } = require('../../shared/utils/enSerie');
const material = require('./project.material');

const clave = (userId, productCode) => `material:${userId}:${productCode}`;

/** El proyecto, solo con licencia vigente de ese método. Lo crea si hacía falta. */
async function proyectoConLicencia(userId, productCode) {
  const conLicencia = await projectRepository.productosConLicencia(userId);
  if (!conLicencia.includes(productCode)) return null;
  return (await projectRepository.buscar(userId, productCode)) ?? projectRepository.asegurar(userId, productCode);
}

/** Guarda un archivo. Null si no tiene licencia; lanza `MaterialNoValido` si no se puede leer o no cabe. */
function guardar({ userId, productCode, buffer, nombre }) {
  return enSerie(clave(userId, productCode), async () => {
    // Primero se lee: un archivo que no sirve no tiene por qué crear el proyecto.
    const texto = material.textoDe(buffer);

    const proyecto = await proyectoConLicencia(userId, productCode);
    if (!proyecto) return null;

    const entrada = {
      nombre: material.nombreSeguro(nombre),
      subidoAt: new Date().toISOString(),
      caracteres: texto.length,
      texto,
    };

    const anteriores = (await almacen.leerMaterial(proyecto.id)) ?? [];
    const resto = anteriores.filter((m) => m.nombre !== entrada.nombre);
    if (resto.length >= material.MAXIMO_ARCHIVOS) {
      throw new material.MaterialNoValido(
        `Ya hay ${material.MAXIMO_ARCHIVOS} archivos subidos. Pídele a Claude que quite uno antes de subir otro.`,
      );
    }

    const lista = [...resto, entrada];
    await almacen.guardarMaterial(proyecto.id, lista);
    return { nombre: entrada.nombre, caracteres: entrada.caracteres, lista: material.fichas(lista) };
  });
}

/** Lo subido, sin el texto. Vacía si no hay proyecto. */
async function lista(userId, productCode) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return [];
  return material.fichas((await almacen.leerMaterial(proyecto.id)) ?? []);
}

/** El texto de un archivo, por partes. Null si no hay ninguno con ese número. */
async function leer(userId, productCode, numero, { parte = 1 } = {}) {
  const proyecto = await projectRepository.buscar(userId, productCode);
  if (!proyecto) return null;

  const todos = (await almacen.leerMaterial(proyecto.id)) ?? [];
  const elegido = todos[Number(numero) - 1];
  if (!elegido) return null;

  const partes = material.enPartes(elegido.texto);
  const cual = Math.min(Math.max(1, Number(parte) || 1), partes.length);
  return { nombre: elegido.nombre, parte: cual, partes: partes.length, texto: partes[cual - 1] };
}

/** Quita un archivo por su número. Devuelve su ficha, o null si no existía. */
function quitar(userId, productCode, numero) {
  return enSerie(clave(userId, productCode), async () => {
    const proyecto = await projectRepository.buscar(userId, productCode);
    if (!proyecto) return null;

    const todos = (await almacen.leerMaterial(proyecto.id)) ?? [];
    const indice = Number(numero) - 1;
    if (!todos[indice]) return null;

    const [quitado] = todos.splice(indice, 1);
    await almacen.guardarMaterial(proyecto.id, todos.length > 0 ? todos : null);
    return { nombre: quitado.nombre };
  });
}

module.exports = { guardar, lista, leer, quitar };
