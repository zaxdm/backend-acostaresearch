'use strict';
const { z } = require('zod');
const identidad = {
  canal: z.enum(['instagram', 'facebook', 'whatsapp']),
  cuenta: z.string().trim().min(1).max(100),
  contacto: z.string().trim().min(1).max(100),
};
const mensaje = z.object({
  ...identidad,
  evento: z.string().trim().min(1).max(150),
  texto: z.string().trim().min(1).max(4000),
  nombre: z.string().trim().max(120).default(''),
  tipo: z.enum(['privado', 'comentario']).default('privado'),
  accion: z.enum(['responder', 'prueba']).default('responder'),
}).strict();
const modo = z.object({ ...identidad, humano: z.boolean() }).strict();
const solicitaPrueba = (texto) => {
  const t = texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  if (/\b(no|nunca|tampoco|cancelar|cancela|saber|informacion|cuanto|como|funciona|dura|precio|costo)\b|\?/.test(t)) return false;
  return /^(?:(?:hola|por favor)[,!\s]*)?(?:(?:si[,!\s]*)?(?:quiero|deseo|quisiera|me gustaria|solicito|dame|enviame|mandame|activar|activa)\b.{0,60}\b(?:prueba|probar|demo)\b.{0,60}|(?:prueba gratis|probar gratis|demo gratis))[.!\s]*$/.test(t);
};
module.exports = { mensaje, modo, solicitaPrueba };
