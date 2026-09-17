'use strict';

/**
 * ¿Qué nos da Elsevier de verdad con la clave que hay puesta?
 *
 * POR QUÉ EXISTE ESTE SCRIPT
 * --------------------------
 * Porque las tres cosas que pueden fallar aquí fallan de formas parecidas y se
 * confunden entre sí, y cada una se arregla de una manera distinta:
 *
 *   1. La clave está mal copiada. Elsevier contesta `APIKEY_INVALID` («esto ni
 *      siquiera tiene forma de clave»), que NO es lo mismo que
 *      `AUTHENTICATION_ERROR` («tiene la forma pero no la conozco»). Los dos
 *      llegan como 401 y por eso se confunden.
 *   2. La clave es buena pero desde esta IP no hay suscripción, así que lo que
 *      vuelve es la vista STANDARD: SIN RESUMEN. Eso no da error ninguno — da
 *      fichas a medias, que es peor, porque parece que funciona.
 *   3. Elsevier no deja ver nada (403) porque el entitlement no alcanza.
 *
 * Esto las separa y lo dice en una frase. Es de lectura: una búsqueda de una
 * sola ficha, sin escribir nada en la base ni en la biblioteca de nadie.
 *
 * Uso:  node scripts/probar-scopus.js
 *       node scripts/probar-scopus.js <clave>   ← para probar una antes de
 *                                                 ponerla en el .env
 */

require('dotenv').config({ path: require('node:path').resolve(__dirname, '..', '.env') });

const BASE = 'https://api.elsevier.com/content/search/scopus';

/** Una búsqueda cualquiera que seguro tiene resultados. */
const ECUACION = 'TITLE-ABS-KEY("mobile applications" AND education)';

const clave = process.argv[2] || process.env.ELSEVIER_API_KEY || '';
const insttoken = process.env.ELSEVIER_INSTTOKEN || '';

/** Los cuatro últimos, para saber cuál se probó sin escribirla entera. */
const pista = (texto) => (texto.length >= 4 ? `…${texto.slice(-4)}` : '(vacía)');

async function pedir(vista) {
  const url = new URL(BASE);
  url.searchParams.set('query', ECUACION);
  url.searchParams.set('count', '1');
  url.searchParams.set('view', vista);

  const cabeceras = { Accept: 'application/json', 'X-ELS-APIKey': clave };
  if (insttoken) cabeceras['X-ELS-Insttoken'] = insttoken;

  const respuesta = await fetch(url, { headers: cabeceras });
  const cuerpo = await respuesta.json().catch(() => null);

  return { estado: respuesta.status, cuerpo, cabeceras: respuesta.headers };
}

function explicarFallo(estado, cuerpo) {
  const codigo = cuerpo?.['error-response']?.['error-code'];
  const texto = cuerpo?.['service-error']?.status?.statusText;

  if (codigo === 'APIKEY_INVALID') {
    return (
      'LA CLAVE ESTÁ MAL COPIADA. Elsevier dice que esto ni siquiera tiene forma de clave.\n' +
      `   Una clave de Elsevier son 32 caracteres hexadecimales; la que se probó tiene ${clave.length}.\n` +
      '   Ve a dev.elsevier.com → My API Key, ábrela para verla entera y cópiala completa.'
    );
  }

  if (estado === 401) {
    return (
      `LA CLAVE NO LA RECONOCE ELSEVIER («${texto ?? 'Invalid API Key'}»).\n` +
      '   Tiene la forma correcta, pero no está registrada o la revocaron.\n' +
      '   Compruébala en dev.elsevier.com → My API Key.'
    );
  }

  if (estado === 403) {
    return (
      'LA CLAVE VALE PERO NO HAY ENTITLEMENT.\n' +
      '   Elsevier ata el acceso a la suscripción de una institución, y la IP de este\n' +
      '   servidor no pertenece a ninguna. Hace falta ELSEVIER_INSTTOKEN, que lo pide la\n' +
      '   biblioteca de una institución suscrita indicando esta clave.'
    );
  }

  if (estado === 429) {
    return 'CUOTA AGOTADA. La clave tiene cuota semanal; espera o pide ampliación a apisupport@elsevier.com.';
  }

  return `Elsevier contestó ${estado}. Cuerpo: ${JSON.stringify(cuerpo).slice(0, 300)}`;
}

async function principal() {
  if (!clave) {
    console.log('No hay clave que probar. Pon ELSEVIER_API_KEY en el .env, o pásala como argumento:');
    console.log('   node scripts/probar-scopus.js <clave>');
    process.exitCode = 1;
    return;
  }

  console.log(`Probando la clave ${pista(clave)} (${clave.length} caracteres)`);
  console.log(`Token institucional: ${insttoken ? `sí, ${pista(insttoken)}` : 'NO'}\n`);

  // STANDARD primero: es lo que se obtiene sin suscripción, así que si esto
  // falla el problema es la clave y no el entitlement.
  const basica = await pedir('STANDARD');

  if (basica.estado !== 200) {
    console.log('✗ ' + explicarFallo(basica.estado, basica.cuerpo));
    process.exitCode = 1;
    return;
  }

  const resultados = basica.cuerpo?.['search-results'];
  const total = resultados?.['opensearch:totalResults'] ?? '?';
  console.log(`✓ La clave FUNCIONA. Esa búsqueda da ${total} resultados en Scopus.`);
  console.log(`   Cuota semanal restante: ${basica.cabeceras.get('x-ratelimit-remaining') ?? '(no lo dice)'}\n`);

  // Y ahora lo que de verdad decide si esto sirve: si las fichas traen resumen.
  const completa = await pedir('COMPLETE');
  const ficha = completa.cuerpo?.['search-results']?.entry?.[0];
  const conResumen = Boolean(String(ficha?.['dc:description'] ?? '').trim());

  if (completa.estado === 200 && conResumen) {
    console.log('✓ Y llegan CON RESUMEN (vista COMPLETE). Es lo que hace falta:');
    console.log('   pon SCOPUS_API_ENABLED=true y la función queda encendida.');
    console.log('   Antes de eso, el permiso de Elsevier: ver docs/scopus-api.md.');
    return;
  }

  console.log('⚠ Scopus manda la ficha REDUCIDA: sin resumen y con un solo autor.');
  console.log(
    completa.estado === 200
      ? '   Acepta la petición pero devuelve STANDARD: título, revista, año, DOI y páginas.'
      : `   La vista COMPLETE se rechaza (${completa.estado}): sin suscripción detrás de esta IP.`,
  );
  console.log('\n   NO ES UN PROBLEMA PARA IMPORTAR. Al traerse una fuente, lo que falta se');
  console.log('   completa con OpenAlex y Crossref por su DOI —el resumen y el reparto');
  console.log('   entero de autores—, que es lo que ya hace la importación por DOI.');
  console.log('   Solo se quedan a medias las que no tienen DOI, o las que OpenAlex no');
  console.log('   conoce; el parte de la importación las cuenta.');
  console.log('\n   Para que no hiciera falta: ELSEVIER_INSTTOKEN. Lo pide la biblioteca de');
  console.log('   una institución suscrita a Elsevier, indicando esta clave.');
}

principal().catch((error) => {
  console.error('No se pudo preguntar a Elsevier:', error.message);
  process.exitCode = 1;
});
