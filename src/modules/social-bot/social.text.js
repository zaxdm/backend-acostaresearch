'use strict';
const VIDEOS = new Set(['https://www.youtube.com/watch?v=bDs9JrQCG5U', 'https://www.youtube.com/watch?v=jB9ULwMiJTo']);
function limpiarTexto(texto, appUrl) {
  let rechazado = false;
  const limpio = texto.replace(/\[\[PERSONA\]\]/g, '').replace(/https?:\/\/[^\s<>\])]+/gi, (enlace) => {
    const url = enlace.replace(/[.,;!]+$/, '');
    try {
      const destino = new URL(url);
      const app = new URL(appUrl);
      if (VIDEOS.has(url) || (destino.origin === app.origin && ['/planes', '/perfil'].includes(destino.pathname) && !destino.username && !destino.password && !destino.search)) return url;
    } catch { /* Los enlaces inválidos tampoco se envían. */ }
    rechazado = true;
    return '';
  }).trim();
  return rechazado
    ? { texto: `Puedes consultar nuestros productos y comprar en ${appUrl.replace(/\/+$/, '')}/planes. Te paso con una persona del equipo para ayudarte.`, humano: true }
    : { texto: limpio, humano: texto.includes('[[PERSONA]]') };
}
module.exports = { limpiarTexto };
