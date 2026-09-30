'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const meta = require('../src/modules/whatsapp/whatsapp.meta');
const { aTextoDeWhatsapp, construirSistemaWhatsapp, MARCA_PERSONA } = require('../src/modules/whatsapp/whatsapp.prompt');
const { enHorarioHumano, pidePersona, ventanaAbierta, aMinutos } = require('../src/modules/whatsapp/whatsapp.reglas');
const { ajustesSchema } = require('../src/modules/whatsapp/whatsapp.schema');
const { _interno } = require('../src/modules/whatsapp/whatsapp.service');

/**
 * El bot de WhatsApp habla en nombre de la casa con cualquiera que tenga el
 * número. Lo que se prueba es lo que lo mantiene en su sitio sin base ni Meta:
 * que solo acepte avisos firmados por Meta, que lea bien lo que Meta manda,
 * que su texto salga en formato de WhatsApp, y que el horario y el «quiero una
 * persona» decidan lo que tienen que decidir.
 */

// ── La firma de Meta ───────────────────────────────────────────────────────

const SECRETO = 'secreto-de-la-app';
const firmar = (cuerpo, secreto = SECRETO) =>
  `sha256=${crypto.createHmac('sha256', secreto).update(cuerpo).digest('hex')}`;

test('acepta un aviso firmado con la clave secreta de la app', () => {
  const cuerpo = Buffer.from('{"object":"whatsapp_business_account"}');
  assert.equal(meta.firmaValida(cuerpo, firmar(cuerpo), SECRETO), true);
});

test('rechaza firma de otra clave, cuerpo cambiado, cabecera rota o sin clave', () => {
  const cuerpo = Buffer.from('{"a":1}');
  assert.equal(meta.firmaValida(cuerpo, firmar(cuerpo, 'otra'), SECRETO), false);
  assert.equal(meta.firmaValida(Buffer.from('{"a":2}'), firmar(cuerpo), SECRETO), false);
  assert.equal(meta.firmaValida(cuerpo, 'sha1=abc', SECRETO), false);
  assert.equal(meta.firmaValida(cuerpo, undefined, SECRETO), false);
  assert.equal(meta.firmaValida(undefined, firmar(cuerpo), SECRETO), false);
  assert.equal(meta.firmaValida(cuerpo, firmar(cuerpo), undefined), false);
});

// ── Lo que manda Meta ──────────────────────────────────────────────────────

const aviso = (mensajes, { numero = '1234', contactos } = {}) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'waba',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '51999', phone_number_id: numero },
            contacts: contactos ?? [{ wa_id: '51987654321', profile: { name: 'Ana Pérez' } }],
            messages: mensajes,
          },
        },
      ],
    },
  ],
});

test('saca número, nombre y texto de un mensaje', () => {
  const [m] = meta.extraerMensajes(
    aviso([{ from: '51987654321', id: 'wamid.1', type: 'text', text: { body: '  Hola  ' } }]),
    '1234',
  );
  assert.deepEqual(m, {
    waId: 'wamid.1',
    telefono: '51987654321',
    nombre: 'Ana Pérez',
    tipo: 'text',
    texto: 'Hola',
  });
});

test('los botones cuentan como texto; audios e imágenes llegan sin texto', () => {
  const mensajes = meta.extraerMensajes(
    aviso([
      { from: '51987654321', id: 'a', type: 'interactive', interactive: { button_reply: { title: 'Precios' } } },
      { from: '51987654321', id: 'b', type: 'button', button: { text: 'Sí' } },
      { from: '51987654321', id: 'c', type: 'audio', audio: { id: 'x' } },
    ]),
    '1234',
  );
  assert.deepEqual(
    mensajes.map((m) => [m.tipo, m.texto]),
    [
      ['interactive', 'Precios'],
      ['button', 'Sí'],
      ['audio', ''],
    ],
  );
});

test('ignora los avisos de otro número, los «entregado/leído» y lo que no es de WhatsApp', () => {
  const mensaje = [{ from: '51987654321', id: 'x', type: 'text', text: { body: 'hola' } }];
  assert.deepEqual(meta.extraerMensajes(aviso(mensaje, { numero: '9999' }), '1234'), []);
  assert.deepEqual(meta.extraerMensajes({ object: 'page', entry: [] }, '1234'), []);
  const soloEstados = aviso(undefined);
  soloEstados.entry[0].changes[0].value.statuses = [{ id: 'wamid.9', status: 'read' }];
  assert.deepEqual(meta.extraerMensajes(soloEstados, '1234'), []);
});

test('sin claves de Meta, mandar no llama a nadie: es la maqueta', async () => {
  let llamado = false;
  const resultado = await meta.enviarTexto('51987654321', 'hola', {
    fetchImpl: async () => {
      llamado = true;
    },
  });
  assert.deepEqual(resultado, { simulado: true });
  assert.equal(llamado, false);
});

test('recorta lo que no cabe en un mensaje de WhatsApp', () => {
  const largo = 'a'.repeat(meta.MAX_TEXTO + 50);
  assert.equal(meta.recortar(largo).length, meta.MAX_TEXTO);
  assert.equal(meta.recortar('corto'), 'corto');
});

// ── Lo que dice el bot ─────────────────────────────────────────────────────

test('convierte el formato de la web al de WhatsApp', () => {
  const { texto, pidePersona: pide } = aTextoDeWhatsapp(
    '## Precio\nEl **Método** está en [Precios](/planes) y [WhatsApp](whatsapp).\n\n\n[Guía](https://x.com/a)',
    'https://acostaresearch.com/',
  );
  assert.equal(
    texto,
    'Precio\nEl *Método* está en Precios: https://acostaresearch.com/planes y por aquí mismo.\n\nGuía: https://x.com/a',
  );
  assert.equal(pide, false);
});

test('la marca de pasar a una persona se quita y se devuelve aparte', () => {
  const { texto, pidePersona: pide } = aTextoDeWhatsapp(`Una persona te escribirá.\n${MARCA_PERSONA}`, 'https://x');
  assert.equal(texto, 'Una persona te escribirá.');
  assert.equal(pide, true);
});

test('las instrucciones llevan precios, enlaces completos y lo que añade el equipo', () => {
  const sistema = construirSistemaWhatsapp({
    planes: [{ name: 'Método de Tesis', priceCents: 19900, currency: 'PEN', durationDays: 360 }],
    appUrl: 'https://acostaresearch.com',
    instrucciones: 'Esta semana hay taller gratuito el viernes.',
    nombre: 'Ana',
    primeraVez: true,
  });
  assert.match(sistema, /Método de Tesis: S\/ 199/);
  assert.match(sistema, /https:\/\/acostaresearch\.com\/planes/);
  assert.match(sistema, /taller gratuito el viernes/);
  assert.match(sistema, /primer mensaje/);
  assert.ok(sistema.includes(MARCA_PERSONA));
});

test('la historia junta turnos seguidos y empieza por el cliente', () => {
  const turnos = _interno.comoConversacion([
    { autor: 'BOT', texto: 'Bienvenida' },
    { autor: 'CLIENTE', texto: 'hola' },
    { autor: 'CLIENTE', texto: 'precios?' },
    { autor: 'BOT', texto: 'S/ 199' },
    { autor: 'ADMIN', texto: 'Soy Benicio' },
  ]);
  assert.deepEqual(turnos, [
    { rol: 'usuario', texto: 'hola\nprecios?' },
    { rol: 'asistente', texto: 'S/ 199\nSoy Benicio' },
  ]);
});

// ── Horario, persona y ventana de 24 horas ─────────────────────────────────

// Miércoles 30-sep-2026 a las 10:00 y a las 20:00 en Lima (UTC−5).
const MIERCOLES_10 = new Date('2026-09-30T15:00:00Z');
const MIERCOLES_20 = new Date('2026-10-01T01:00:00Z');
const DOMINGO_10 = new Date('2026-10-04T15:00:00Z');
const HORARIO = { usarHorario: true, horaInicio: '09:00', horaFin: '18:00', diasLaborables: '1,2,3,4,5' };

test('en horario atiende una persona; fuera, el fin de semana o sin horario, el bot', () => {
  assert.equal(enHorarioHumano(HORARIO, MIERCOLES_10), true);
  assert.equal(enHorarioHumano(HORARIO, MIERCOLES_20), false);
  assert.equal(enHorarioHumano(HORARIO, DOMINGO_10), false);
  assert.equal(enHorarioHumano({ ...HORARIO, usarHorario: false }, MIERCOLES_10), false);
});

test('un horario que cruza la medianoche también vale', () => {
  const noche = { ...HORARIO, horaInicio: '19:00', horaFin: '02:00' };
  assert.equal(enHorarioHumano(noche, MIERCOLES_20), true);
  assert.equal(enHorarioHumano(noche, MIERCOLES_10), false);
  assert.equal(aMinutos('24:00'), null);
});

test('reconoce que pide una persona sin importar mayúsculas ni tildes', () => {
  const frases = 'hablar con una persona, atención humana, operador';
  assert.equal(pidePersona('Quiero HABLAR con una PERSONA por favor', frases), true);
  assert.equal(pidePersona('necesito atencion humana', frases), true);
  assert.equal(pidePersona('mi asesor de tesis no me responde', frases), false);
  assert.equal(pidePersona('hola', ''), false);
});

test('la ventana de 24 horas se cierra al día del último mensaje del cliente', () => {
  const ahora = Date.parse('2026-09-30T12:00:00Z');
  assert.equal(ventanaAbierta('2026-09-29T13:00:00Z', ahora), true);
  assert.equal(ventanaAbierta('2026-09-29T11:00:00Z', ahora), false);
  assert.equal(ventanaAbierta(null, ahora), false);
});

test('los días laborables se guardan ordenados y sin repetir', () => {
  const { diasLaborables } = ajustesSchema.parse({ diasLaborables: [5, 1, 3, 1] });
  assert.equal(diasLaborables, '1,3,5');
  assert.throws(() => ajustesSchema.parse({ horaInicio: '25:00' }));
});
