'use strict';
const VIDEOS = new Set(['https://www.youtube.com/watch?v=bDs9JrQCG5U', 'https://www.youtube.com/watch?v=jB9ULwMiJTo']);
function limpiarTexto(texto, appUrl) {
  let rechazado = false;
  // Messenger e Instagram no interpretan Markdown: los ** saldrían tal cual.
  const limpio = texto.replace(/\[\[PERSONA\]\]/g, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '').replace(/https?:\/\/[^\s<>\])]+/gi, (enlace) => {
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
// La respuesta pública bajo el comentario: corta, sin enlaces ni precios (eso va por privado).
function limpiarAviso(texto = '') {
  const limpio = texto.replace(/\[\[[A-Z]+\]\]/g, '').replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/^#{1,6}\s+/gm, '')
    .replace(/\s*\n+\s*/g, ' ').replace(/^["«]+|["»]+$/g, '').trim();
  if (!limpio || /https?:|www\.|\.com|S\/\s*\d|\d+[.,]\d{2}|\/prueba/i.test(limpio)) return '';
  if (limpio.length <= 200) return limpio;
  const corte = limpio.slice(0, 200);
  return corte.slice(0, corte.lastIndexOf(' ')).replace(/[,;:]$/, '') + '…';
}
// Si no hay respuesta de la IA (ya recibió la info antes), una frase fija que cambia de comentario en comentario.
const AVISOS = [
  (n) => `¡Te escribimos por mensaje directo${n}! 📩`,
  (n) => `¡Gracias por comentar${n}! Te dejamos la info por mensaje privado 📩`,
  (n) => `¡Listo${n}! Revisa tus mensajes, ahí te explicamos todo 🙌`,
  (n) => `¡Hola${n}! Te enviamos los detalles por interno 😊`,
  (n) => `¡Ya te escribimos por privado${n}! Cualquier duda, nos dices por ahí 📩`,
];
function avisoFijo(e = {}) {
  const nombre = e.canal === 'facebook' ? String(e.nombre || '').trim().split(/\s+/)[0] : '';
  const n = nombre ? `, ${nombre}` : '';
  let i = 0;
  for (const ch of String(e.comentarioId || e.evento || '')) i = (i * 31 + ch.charCodeAt(0)) % AVISOS.length;
  return AVISOS[i](n);
}
module.exports = { limpiarTexto, limpiarAviso, avisoFijo };
