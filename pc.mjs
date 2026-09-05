// Prueba de extremo a extremo del producto.
//
// Crea un usuario y una licencia de usar y tirar, pide capítulos al conector
// DE PRODUCCIÓN con esa licencia, comprueba la marca de agua y el aislamiento
// por grupo, y borra todo al terminar pase lo que pase.
import { createRequire } from 'node:module';
const require = createRequire('c:/Users/Usuario/Documents/acostaresearch/backend/');

const { PrismaClient } = require('@prisma/client');
const { hashToken, generateOpaqueToken } = require('./src/shared/utils/tokens');
const { identificar, limpiar } = require('./src/modules/skills/skill.watermark');

const MCP = "http://localhost:3996/mcp";
const prisma = new PrismaClient();

let ok = 0, mal = 0;
const fallos = [];
function comprobar(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ok    ${nombre}${detalle ? '  — ' + detalle : ''}`); }
  else { mal++; fallos.push(nombre + (detalle ? ' — ' + detalle : '')); console.log(`  FALLA ${nombre}${detalle ? '  — ' + detalle : ''}`); }
}

let idUsuario = null;
let idLicencia = null;

async function llamar(token, metodo, params = {}) {
  const r = await fetch(`${MCP}/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: metodo, params }),
  });
  const texto = await r.text();
  // El transporte puede responder SSE: la carga va en la línea `data:`.
  const linea = texto.split('\n').find((l) => l.startsWith('data:'));
  const crudo = linea ? linea.slice(5).trim() : texto;
  try { return { estado: r.status, json: JSON.parse(crudo) }; }
  catch { return { estado: r.status, json: null, texto }; }
}

try {
  console.log('\n══ PREPARAR ═══════════════════════════════════════════════');
  const usuario = await prisma.user.create({
    data: {
      email: `prueba-sistema-${Date.now()}@ejemplo-borrar.test`,
      firstName: 'Prueba', lastName: 'Sistema',
      role: 'USER', status: 'ACTIVE', emailVerifiedAt: new Date(),
      passwordHash: 'x'.repeat(60),
    },
  });
  idUsuario = usuario.id;

  const plan = await prisma.plan.findFirst({ where: { kind: 'LICENSE', productCode: 'METODO_9_SKILLS' } });
  const token = generateOpaqueToken(32);
  const licencia = await prisma.license.create({
    data: {
      userId: usuario.id, productCode: 'METODO_9_SKILLS',
      tokenHash: hashToken(token), tokenHint: token.slice(0, 8),
      expiresAt: new Date(Date.now() + 90 * 864e5),
      callsPerDay: plan.mcpCallsPerDay, delivery: plan.mcpDelivery,
    },
  });
  idLicencia = licencia.id;
  console.log(`  usuario y licencia de prueba creados (caducan en 90 días)`);

  console.log('\n══ 1. HANDSHAKE ═══════════════════════════════════════════');
  const init = await llamar(token, 'initialize', {
    protocolVersion: '2025-06-18', capabilities: {},
    clientInfo: { name: 'prueba-sistema', version: '1.0' },
  });
  comprobar('initialize', init.json?.result?.serverInfo != null, init.json?.result?.serverInfo?.name ?? JSON.stringify(init.json)?.slice(0, 80));

  const herramientas = await llamar(token, 'tools/list');
  const nombres = (herramientas.json?.result?.tools ?? []).map((t) => t.name);
  comprobar('tools/list', nombres.length > 0, nombres.join(', '));

  console.log('\n══ 2. LISTAR CAPÍTULOS ════════════════════════════════════');
  const lista = await llamar(token, 'tools/call', { name: 'listar_capitulos', arguments: {} });
  const textoLista = lista.json?.result?.content?.[0]?.text ?? '';
  comprobar('responde', textoLista.length > 0, `${textoLista.length} caracteres`);
  const claves = [...textoLista.matchAll(/clave:\s*([a-z0-9-]+)/g)].map((m) => m[1]);
  comprobar('lista los 9 capítulos', claves.length === 9, `${claves.length}: ${claves.slice(0, 3).join(', ')}…`);
  comprobar('sin «pendiente de publicar»', !/pendiente de publicar/i.test(textoLista));

  console.log('\n══ 3. ENTREGAR UN CAPÍTULO ════════════════════════════════');
  const entrega = await llamar(token, 'tools/call', {
    name: 'redactar', arguments: { capitulo: claves[0] ?? 'tema-y-delimitacion', paso: 1 },
  });
  const contenido = entrega.json?.result?.content?.[0]?.text ?? '';
  comprobar('entrega contenido', contenido.length > 500, `${contenido.length} caracteres`);
  comprobar('lleva la cabecera de licencia', /Material con licencia de/i.test(contenido));
  comprobar('dice el paso y el total', /paso 1 de \d+/i.test(contenido), (contenido.match(/paso 1 de \d+/i) ?? [''])[0]);

  const marca = identificar(contenido, [licencia.id, '00000000-0000-0000-0000-000000000000']);
  comprobar('lleva marca de agua', marca.encontrada, `${marca.bits ?? 0} bits`);
  comprobar('la marca señala a ESTA licencia',
    marca.candidatas?.length === 1 && marca.candidatas[0] === licencia.id,
    `${marca.candidatas?.length ?? 0} candidata(s)`);
  comprobar('la marca es invisible', limpiar(contenido).length < contenido.length,
    `${contenido.length - limpiar(contenido).length} caracteres ocultos`);

  console.log('\n══ 4. AISLAMIENTO POR GRUPO ═══════════════════════════════');
  await prisma.license.update({ where: { id: licencia.id }, data: { productCode: 'GRUPO_QUE_NO_EXISTE' } });
  const ajena = await llamar(token, 'tools/call', { name: 'redactar', arguments: { capitulo: claves[0], paso: 1 } });
  const textoAjeno = ajena.json?.result?.content?.[0]?.text ?? '';
  comprobar('otra licencia NO recibe este capítulo',
    !/Material con licencia de/i.test(textoAjeno), textoAjeno.slice(0, 60).replace(/\n/g, ' '));
  const listaAjena = await llamar(token, 'tools/call', { name: 'listar_capitulos', arguments: {} });
  const textoListaAjena = listaAjena.json?.result?.content?.[0]?.text ?? '';
  comprobar('ni los ve en la lista',
    [...textoListaAjena.matchAll(/clave:\s*([a-z0-9-]+)/g)].length === 0,
    textoListaAjena.slice(0, 70).replace(/\n/g, ' '));
  await prisma.license.update({ where: { id: licencia.id }, data: { productCode: 'METODO_9_SKILLS' } });

  console.log('\n══ 5. LICENCIA CADUCADA Y REVOCADA ════════════════════════');
  await prisma.license.update({ where: { id: licencia.id }, data: { expiresAt: new Date(Date.now() - 864e5) } });
  const caducada = await llamar(token, 'tools/call', { name: 'listar_capitulos', arguments: {} });
  const txtCad = JSON.stringify(caducada.json ?? caducada.texto);
  comprobar('una licencia caducada no entra', /caduc|expir|-32001|licencia/i.test(txtCad), txtCad.slice(0, 80));

  await prisma.license.update({ where: { id: licencia.id }, data: { expiresAt: new Date(Date.now() + 864e5), status: 'REVOKED', revokedAt: new Date() } });
  const revocada = await llamar(token, 'tools/call', { name: 'listar_capitulos', arguments: {} });
  const txtRev = JSON.stringify(revocada.json ?? revocada.texto);
  comprobar('una licencia revocada no entra', /revoc|desactiv|-32001|licencia/i.test(txtRev), txtRev.slice(0, 80));

  console.log('\n══ 6. CONTADORES ══════════════════════════════════════════');
  const final = await prisma.license.findUnique({ where: { id: licencia.id }, select: { callsTotal: true, lastUsedAt: true } });
  comprobar('se contabilizaron las llamadas', final.callsTotal > 0, `${final.callsTotal} llamadas`);
  comprobar('se anotó la última fecha de uso', final.lastUsedAt != null, String(final.lastUsedAt).slice(0, 24));
} catch (e) {
  mal++; fallos.push('EXCEPCIÓN: ' + e.message);
  console.log('\n  EXCEPCIÓN:', e.message);
} finally {
  console.log('\n══ LIMPIEZA ═══════════════════════════════════════════════');
  if (idLicencia) {
    await prisma.licenseUsage.deleteMany({ where: { licenseId: idLicencia } }).catch(() => {});
    await prisma.mcpSession.deleteMany({ where: { licenseId: idLicencia } }).catch(() => {});
    await prisma.licenseCounter.deleteMany({ where: { licenseId: idLicencia } }).catch(() => {});
    await prisma.license.delete({ where: { id: idLicencia } }).catch((e) => console.log('  (licencia)', e.message.slice(0, 60)));
  }
  if (idUsuario) await prisma.user.delete({ where: { id: idUsuario } }).catch((e) => console.log('  (usuario)', e.message.slice(0, 60)));
  const quedan = await prisma.user.count({ where: { email: { contains: 'ejemplo-borrar.test' } } });
  console.log(`  usuarios de prueba que quedan: ${quedan}`);
  await prisma.$disconnect();

  console.log('\n═══════════════════════════════════════════════════════════');
  console.log(`  ${ok} bien · ${mal} mal`);
  if (fallos.length) { console.log('\n  FALLOS:'); for (const f of fallos) console.log('   · ' + f); }
  console.log('');
}
