/**
 * Vigía externo: avisa al móvil si la API o la web dejan de responder.
 *
 * Vive en Cloudflare y no en el VPS a propósito: si el servidor entero se cae
 * (Hetzner, el disco, el proceso), nada de lo que corre dentro puede avisar.
 * El vigilante de la base del backend (`lib/vigiaBase`) cubre la base; este,
 * todo lo demás.
 *
 * Cada 5 minutos pide cada dirección, con un segundo intento a los 10 s para
 * no despertar a nadie por un parpadeo de red. El estado de cada una se guarda
 * en KV para avisar tres cosas, y solo esas:
 *
 *  · que se cayó (prioridad máxima);
 *  · que sigue caída, una vez cada 30 minutos;
 *  · que volvió, y cuánto estuvo fuera.
 *
 * Secreto: NTFY_TOPIC (el mismo tópico que usa el backend). Opcional: NTFY_URL.
 */

const OBJETIVOS = [
  { clave: 'api', nombre: 'La API', url: 'https://api.acostaresearch.com/api/v1/health' },
  { clave: 'web', nombre: 'La web', url: 'https://acostaresearch.com/' },
];

const TIEMPO_LIMITE_MS = 10_000;
const REINTENTO_MS = 10_000;
const REPETIR_AVISO_MS = 30 * 60 * 1000;

async function responde(url) {
  try {
    const r = await fetch(url, {
      signal: AbortSignal.timeout(TIEMPO_LIMITE_MS),
      headers: { 'User-Agent': 'acosta-vigia-externo' },
      cf: { cacheTtl: 0 },
    });
    return r.ok ? null : `respondió ${r.status}`;
  } catch (error) {
    return error?.name === 'TimeoutError' ? 'no respondió en 10 s' : 'no se pudo conectar';
  }
}

async function comprobar(url) {
  const primero = await responde(url);
  if (!primero) return null;
  await new Promise((r) => setTimeout(r, REINTENTO_MS));
  return responde(url);
}

async function avisar(env, { titulo, mensaje, prioridad, etiquetas }) {
  if (!env.NTFY_TOPIC) return;
  await fetch(env.NTFY_URL || 'https://ntfy.sh', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title: titulo, message: mensaje, priority: prioridad, tags: etiquetas }),
  }).catch(() => undefined);
}

const minutos = (ms) => Math.max(1, Math.round(ms / 60000));

async function vigilar(objetivo, env, ahora) {
  const fallo = await comprobar(objetivo.url);
  const guardado = await env.ESTADO.get(objetivo.clave, 'json');

  if (fallo && !guardado) {
    await env.ESTADO.put(objetivo.clave, JSON.stringify({ desde: ahora, aviso: ahora }));
    await avisar(env, {
      titulo: `${objetivo.nombre} está caída`,
      mensaje: `${objetivo.url} ${fallo}. Mira el servidor: ssh acosta, journalctl -u acostaresearch -n 50`,
      prioridad: 5,
      etiquetas: ['rotating_light'],
    });
  } else if (fallo && ahora - guardado.aviso >= REPETIR_AVISO_MS) {
    await env.ESTADO.put(objetivo.clave, JSON.stringify({ ...guardado, aviso: ahora }));
    await avisar(env, {
      titulo: `${objetivo.nombre} sigue caída`,
      mensaje: `Lleva ${minutos(ahora - guardado.desde)} min sin responder (${fallo}).`,
      prioridad: 5,
      etiquetas: ['rotating_light'],
    });
  } else if (!fallo && guardado) {
    await env.ESTADO.delete(objetivo.clave);
    await avisar(env, {
      titulo: `${objetivo.nombre} volvió`,
      mensaje: `Estuvo ${minutos(ahora - guardado.desde)} min sin responder.`,
      prioridad: 3,
      etiquetas: ['white_check_mark'],
    });
  }
}

export default {
  async scheduled(_evento, env, ctx) {
    const ahora = Date.now();
    ctx.waitUntil(Promise.all(OBJETIVOS.map((o) => vigilar(o, env, ahora))));
  },

  // Para comprobar a mano que el Worker está vivo; no expone nada.
  async fetch() {
    return new Response('vigía externo de Acosta Research: activo\n', { headers: { 'Content-Type': 'text/plain' } });
  },
};
