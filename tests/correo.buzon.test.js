'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');

const { revisarCorreos, buzonExiste, conversarSmtp, veredicto } = require('../src/shared/utils/correo');

/**
 * Un dígito cambiado en el correo —`ana1990@gmail.com` por `ana1909@gmail.com`—
 * pasa la forma, las erratas y el DNS. Lo único que sabe si la cuenta existe es
 * el servidor de correo del dominio, y eso es lo que se prueba aquí. Sin red:
 * el servidor SMTP es uno falso levantado en este mismo proceso.
 */

const MX_GMAIL = { 'gmail.com': [{ exchange: 'gmail-smtp-in.l.google.com', priority: 5 }] };

function opciones(buzones) {
  const sondeos = [];
  return {
    resolverMx: async (dominio) => MX_GMAIL[dominio] ?? [],
    cache: new Map(),
    cacheBuzon: new Map(),
    sondeos,
    sondearBuzon: async (correo) => {
      sondeos.push(correo);
      return buzones[correo] ?? null;
    },
  };
}

test('una cuenta que su servidor da por inexistente bloquea con un aviso claro', async () => {
  const o = opciones({ 'ana1909@gmail.com': false, 'ana1990@gmail.com': true });
  const [mal, bien] = await revisarCorreos(['ana1909@gmail.com', 'ana1990@gmail.com'], o);

  assert.equal(mal.buzon, false);
  assert.match(mal.problema, /Esa cuenta no existe/);
  assert.equal(bien.buzon, true);
  assert.equal(bien.problema, null);
});

test('si no se pudo comprobar, no bloquea: queda buzon null', async () => {
  const o = opciones({});
  const [r] = await revisarCorreos(['luis@gmail.com'], o);
  assert.equal(r.problema, null);
  assert.equal(r.buzon, null);
});

test('no se sondea el buzón de una errata ni de un dominio sin correo', async () => {
  const o = opciones({});
  await revisarCorreos(['kelin@gamail.com', 'zz@hou.com'], o);
  assert.deepEqual(o.sondeos, []);
});

test('las respuestas firmes se recuerdan; las dudosas se vuelven a preguntar', async () => {
  const o = opciones({ 'ana@gmail.com': true });
  await buzonExiste('ana@gmail.com', [], o);
  await buzonExiste('ana@gmail.com', [], o);
  await buzonExiste('otro@gmail.com', [], o);
  await buzonExiste('otro@gmail.com', [], o);
  assert.deepEqual(o.sondeos, ['ana@gmail.com', 'otro@gmail.com', 'otro@gmail.com']);
});

test('qué respuestas cuentan como «no existe»', () => {
  const rcpt = (codigo, texto) => veredicto({ etapa: 'destinatario', codigo, texto });

  assert.equal(rcpt(250, '250 2.1.5 OK'), true);
  // Gmail, Outlook y Yahoo cuando la cuenta no existe.
  assert.equal(
    rcpt(550, '550-5.1.1 The email account that you tried to reach does not exist.'),
    false,
  );
  assert.equal(rcpt(550, '550 5.5.0 Requested action not taken: mailbox unavailable'), false);
  assert.equal(rcpt(554, "554 delivery error: dd This user doesn't have a yahoo.com account"), false);
  // Rechazos por política: la IP del VPS en una lista, no la cuenta.
  assert.equal(rcpt(550, '550 5.7.1 Client host blocked using Spamhaus. mailbox unavailable'), null);
  assert.equal(rcpt(554, '554 Service unavailable'), null);
  // Lista gris: se reintenta luego, no dice nada del buzón.
  assert.equal(rcpt(450, '450 4.2.1 Try again later'), null);
  // Se cortó antes de llegar al destinatario.
  assert.equal(veredicto({ etapa: 'remitente', codigo: 550, texto: '550 5.1.1 no' }), null);
});

/** Servidor SMTP de juguete que contesta al RCPT TO con `respuestaRcpt`. */
function servidorFalso(respuestaRcpt) {
  const recibidos = [];
  const servidor = net.createServer((socket) => {
    socket.write('220 mx.prueba ESMTP\r\n');
    let pendiente = '';
    socket.on('data', (trozo) => {
      pendiente += trozo.toString();
      const lineas = pendiente.split('\r\n');
      pendiente = lineas.pop();
      for (const linea of lineas) {
        recibidos.push(linea);
        if (linea.startsWith('EHLO')) socket.write('250-mx.prueba\r\n250-SIZE 1000\r\n250 8BITMIME\r\n');
        else if (linea.startsWith('MAIL FROM')) socket.write('250 2.1.0 OK\r\n');
        else if (linea.startsWith('RCPT TO')) socket.write(`${respuestaRcpt}\r\n`);
        else if (linea === 'QUIT') socket.end('221 Bye\r\n');
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) =>
    servidor.listen(0, '127.0.0.1', () => resolve({ servidor, recibidos, puerto: servidor.address().port })),
  );
}

test('la conversación SMTP llega al RCPT TO, lee respuestas de varias líneas y nunca manda DATA', async () => {
  const { servidor, recibidos, puerto } = await servidorFalso(
    '550-5.1.1 The email account that you tried to reach does not exist.\r\n550 5.1.1 https://support.google.com',
  );
  try {
    const respuesta = await conversarSmtp('127.0.0.1', 'ana1909@gmail.com', {
      remitente: 'no-responder@acostaresearch.com',
      puerto,
    });
    assert.equal(respuesta.etapa, 'destinatario');
    assert.equal(respuesta.codigo, 550);
    assert.equal(veredicto(respuesta), false);
    assert.deepEqual(recibidos.slice(0, 3), [
      'EHLO acostaresearch.com',
      'MAIL FROM:<no-responder@acostaresearch.com>',
      'RCPT TO:<ana1909@gmail.com>',
    ]);
    assert.ok(!recibidos.includes('DATA'));
  } finally {
    servidor.close();
  }
});

test('un servidor que no contesta se queda en la etapa de conexión', async () => {
  // Un puerto que escucha pero nunca saluda.
  const mudo = net.createServer(() => {});
  await new Promise((r) => mudo.listen(0, '127.0.0.1', r));
  try {
    const respuesta = await conversarSmtp('127.0.0.1', 'a@b.com', {
      remitente: 'x@acostaresearch.com',
      puerto: mudo.address().port,
      tiempo: 200,
    });
    assert.equal(respuesta.etapa, 'conexion');
    assert.equal(veredicto(respuesta), null);
  } finally {
    mudo.close();
  }
});
