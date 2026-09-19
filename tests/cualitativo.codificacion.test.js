'use strict';

/**
 * Las reglas de la codificación cualitativa.
 *
 * Lo que tiene que ser cierto:
 *
 *   · una cita solo se guarda si su texto está en ese párrafo, y se guarda con
 *     el texto del párrafo y su posición exacta;
 *   · los espacios y las comillas o guiones de otra forma no la hacen fallar;
 *     una palabra cambiada, sí;
 *   · si algo falla no se guarda nada, y se dicen todos los errores de una vez;
 *   · un código nuevo necesita definición, y «apoyo docente» es el mismo que
 *     «Apoyo Docente»;
 *   · codificar una entrevista reemplaza lo suyo y no toca las demás;
 *   · renombrar, juntar y quitar códigos arrastran sus citas.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('../src/modules/cualitativo/cualitativo.codificacion');
const { esqueleto } = require('../src/modules/projects/project.documento');

const E1 = {
  id: 'E1',
  parrafos: [
    'Entrevistador: ¿Cómo fue su experiencia con el asesor?',
    'Participante: El profesor nunca respondía mis correos, tuve que buscar ayuda afuera. Me dio “mucha” pena.',
  ],
};
const E2 = { id: 'E2', parrafos: ['P: Trabajo de día y estudio de noche; no me alcanza el tiempo.'] };

const APOYO = { nombre: 'Falta de apoyo docente', definicion: 'El docente no orienta.', categoria: 'Barreras' };
const AYUDA = { nombre: 'Ayuda externa', definicion: 'Busca apoyo fuera de la universidad.', categoria: 'Estrategias' };

test('localizar: devuelve el texto y la posición exacta del párrafo', () => {
  const p = E1.parrafos[1];
  const lugar = r.localizar(p, 'nunca respondía mis correos');
  assert.equal(lugar.texto, 'nunca respondía mis correos');
  assert.equal(p.slice(lugar.inicio, lugar.fin), lugar.texto);
});

test('localizar: tolera espacios y comillas de otra forma, no palabras cambiadas', () => {
  const p = E1.parrafos[1];
  const lugar = r.localizar(p, 'Me dio "mucha"   pena.');
  assert.equal(lugar.texto, 'Me dio “mucha” pena.');
  assert.equal(r.localizar(p, 'nunca contestaba mis correos'), null);
  assert.equal(r.localizar(p, ''), null);
});

test('el esqueleto es el mismo que el de citar el Word subido', () => {
  for (const texto of E1.parrafos) {
    assert.equal(r.esqueletoConPosiciones(texto).esqueleto, esqueleto(texto));
  }
});

test('codificar: guarda las citas con el texto del párrafo y los códigos nuevos', () => {
  const { codificacion, nuevos, citas } = r.codificar(null, E1, {
    codigos: [APOYO, AYUDA],
    citas: [
      { parrafo: 2, texto: 'El profesor nunca respondía mis correos', codigos: ['falta de apoyo DOCENTE'] },
      { parrafo: 2, texto: 'tuve que buscar ayuda afuera.', codigos: ['Ayuda externa', 'Falta de apoyo docente'] },
    ],
  });
  assert.deepEqual(nuevos, ['Falta de apoyo docente', 'Ayuda externa']);
  assert.equal(citas.length, 2);
  assert.deepEqual(citas[0].codigos, ['Falta de apoyo docente']);
  assert.deepEqual(citas[1].codigos, ['Ayuda externa', 'Falta de apoyo docente']);
  assert.equal(E1.parrafos[1].slice(citas[1].inicio, citas[1].fin), 'tuve que buscar ayuda afuera.');
  assert.equal(codificacion.codigos.length, 2);
  assert.equal(codificacion.citas.length, 2);
});

test('codificar: si una cita no está, no se guarda nada y se dicen todos los errores', () => {
  assert.throws(
    () =>
      r.codificar(null, E1, {
        codigos: [APOYO, { nombre: 'Sin definir' }],
        citas: [
          { parrafo: 2, texto: 'el profesor nunca contestaba', codigos: ['Falta de apoyo docente'] },
          { parrafo: 9, texto: 'algo', codigos: ['Falta de apoyo docente'] },
          { parrafo: 1, texto: '¿Cómo fue su experiencia', codigos: ['Inexistente'] },
        ],
      }),
    (e) => {
      assert.ok(e instanceof r.CodificacionNoValida);
      assert.equal(e.errores.length, 4);
      assert.match(e.errores.join('\n'), /no tiene definición/);
      assert.match(e.errores.join('\n'), /no está en el párrafo/);
      assert.match(e.errores.join('\n'), /no tiene el párrafo ¶9/);
      assert.match(e.errores.join('\n'), /«Inexistente» no existe/);
      return true;
    },
  );
});

test('codificar otra vez la misma entrevista reemplaza sus citas y no toca las demás', () => {
  let { codificacion } = r.codificar(null, E1, {
    codigos: [APOYO],
    citas: [{ parrafo: 2, texto: 'nunca respondía mis correos', codigos: ['Falta de apoyo docente'] }],
  });
  ({ codificacion } = r.codificar(codificacion, E2, {
    codigos: [{ nombre: 'Falta de tiempo', definicion: 'No le alcanza el tiempo.' }],
    citas: [{ parrafo: 1, texto: 'no me alcanza el tiempo', codigos: ['Falta de tiempo'] }],
  }));
  ({ codificacion } = r.codificar(codificacion, E1, {
    citas: [{ parrafo: 2, texto: 'Me dio “mucha” pena.', codigos: ['Falta de apoyo docente'] }],
  }));

  const deE1 = codificacion.citas.filter((c) => c.entrevista === 'E1');
  assert.equal(deE1.length, 1);
  assert.equal(deE1[0].texto, 'Me dio “mucha” pena.');
  assert.equal(codificacion.citas.filter((c) => c.entrevista === 'E2').length, 1);
  assert.equal(new Set(codificacion.citas.map((c) => c.id)).size, codificacion.citas.length, 'ids únicos');
});

test('la misma cita repetida se junta en una, con los códigos de las dos', () => {
  const { citas } = r.codificar(null, E1, {
    codigos: [APOYO, AYUDA],
    citas: [
      { parrafo: 2, texto: 'tuve que buscar ayuda afuera', codigos: ['Ayuda externa'] },
      { parrafo: 2, texto: 'tuve que  buscar ayuda afuera', codigos: ['Falta de apoyo docente'] },
    ],
  });
  assert.equal(citas.length, 1);
  assert.deepEqual(citas[0].codigos, ['Ayuda externa', 'Falta de apoyo docente']);
});

test('redefinir un código existente cambia su definición sin duplicarlo', () => {
  let { codificacion } = r.codificar(null, E1, {
    codigos: [APOYO],
    citas: [{ parrafo: 2, texto: 'nunca respondía', codigos: ['Falta de apoyo docente'] }],
  });
  ({ codificacion } = r.codificar(codificacion, E2, {
    codigos: [{ nombre: 'FALTA DE APOYO DOCENTE', definicion: 'Otra definición.' }],
    citas: [{ parrafo: 1, texto: 'estudio de noche', codigos: ['Falta de apoyo docente'] }],
  }));
  assert.equal(codificacion.codigos.length, 1);
  assert.equal(codificacion.codigos[0].definicion, 'Otra definición.');
  assert.equal(codificacion.codigos[0].nombre, 'Falta de apoyo docente');
});

test('renombrar: cambia el nombre en el libro y en las citas; con un nombre existente, junta', () => {
  let { codificacion } = r.codificar(null, E1, {
    codigos: [APOYO, AYUDA],
    citas: [
      { parrafo: 2, texto: 'nunca respondía', codigos: ['Falta de apoyo docente'] },
      { parrafo: 2, texto: 'buscar ayuda afuera', codigos: ['Ayuda externa', 'Falta de apoyo docente'] },
    ],
  });

  const renombrado = r.renombrar(codificacion, 'falta de apoyo docente', 'Abandono del asesor');
  assert.equal(renombrado.junto, false);
  assert.ok(renombrado.codificacion.citas.every((c) => !c.codigos.includes('Falta de apoyo docente')));
  assert.equal(renombrado.codificacion.citas[0].codigos[0], 'Abandono del asesor');

  const junto = r.renombrar(renombrado.codificacion, 'Ayuda externa', 'abandono del asesor');
  assert.equal(junto.junto, true);
  assert.equal(junto.codificacion.codigos.length, 1);
  assert.deepEqual(junto.codificacion.citas[1].codigos, ['Abandono del asesor']);
  codificacion = junto.codificacion;
  assert.equal(r.resumen(codificacion).codigos[0].citas, 2);
});

test('quitar un código quita las citas que se quedan sin ninguno', () => {
  const { codificacion } = r.codificar(null, E1, {
    codigos: [APOYO, AYUDA],
    citas: [
      { parrafo: 2, texto: 'nunca respondía', codigos: ['Falta de apoyo docente'] },
      { parrafo: 2, texto: 'buscar ayuda afuera', codigos: ['Ayuda externa', 'Falta de apoyo docente'] },
    ],
  });
  const hecho = r.quitarCodigo(codificacion, 'Falta de apoyo docente');
  assert.equal(hecho.citasQuitadas, 1);
  assert.equal(hecho.codificacion.citas.length, 1);
  assert.deepEqual(hecho.codificacion.citas[0].codigos, ['Ayuda externa']);
});

test('resumen: citas y entrevistas por código, y citas por entrevista', () => {
  let { codificacion } = r.codificar(null, E1, {
    codigos: [APOYO],
    citas: [
      { parrafo: 2, texto: 'nunca respondía', codigos: ['Falta de apoyo docente'] },
      { parrafo: 2, texto: 'Me dio', codigos: ['Falta de apoyo docente'] },
    ],
  });
  ({ codificacion } = r.codificar(codificacion, E2, {
    citas: [{ parrafo: 1, texto: 'no me alcanza', codigos: ['Falta de apoyo docente'] }],
  }));
  const resumen = r.resumen(codificacion);
  assert.deepEqual(resumen.codigos[0], {
    nombre: 'Falta de apoyo docente',
    definicion: 'El docente no orienta.',
    categoria: 'Barreras',
    citas: 3,
    entrevistas: 2,
  });
  assert.deepEqual(resumen.porEntrevista, { E1: 2, E2: 1 });
});
