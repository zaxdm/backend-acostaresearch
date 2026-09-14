'use strict';

/**
 * Lo que la herramienta `trabajar_en_r` le cuenta a Claude, con un motor de
 * mentira y el proyecto sustituido por uno en memoria.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const rutaRepo = require.resolve('../src/modules/projects/project.repository');
const rutaProyectos = require.resolve('../src/modules/projects/project.service');

const guardados = [];
const falso = (ruta, exports) => {
  require.cache[ruta] = { id: ruta, filename: ruta, loaded: true, exports };
};
falso(rutaRepo, {
  asegurar: async () => ({ id: 'proyecto-1' }),
  buscar: async () => ({ id: 'proyecto-1' }),
});
falso(rutaProyectos, {
  recibirAnalisis: async (datos) => {
    guardados.push(datos);
    return { capitulo: 'analisis-datos-rstudio', escritos: ['script', 'salida'] };
  },
});

const rService = require('../src/modules/r/r.service');
const { MotorNoDisponible } = require('../src/modules/r/r.motor');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const USO = { userId: 'u1', productCode: 'METODO_9_SKILLS' };

function motorFalso({ hayDatos = true, resultado = 'ok', lanzar, archivos = [] } = {}) {
  const motor = {
    ordenes: [],
    async listo() {
      return true;
    },
    async ejecutar(sesion, codigo) {
      if (lanzar) throw lanzar;
      motor.ordenes.push({ sesion, codigo });
      return {
        resultado,
        salida: `> ${codigo}\n\tPearson's product-moment correlation\n\nt = 3.2, p-value = 0.003`,
        estado: {
          objetos: [{ nombre: 'datos', clase: 'data.frame', detalle: '120 x 2' }],
          columnas: [
            { nombre: 'edad', clase: 'integer', perdidos: 0, resumen: '18 45' },
            { nombre: 'sexo', clase: 'character', perdidos: 3, resumen: '2' },
          ],
        },
        graficos: [{ nombre: 'graficos/grafico-01.png', bytes: PNG }],
        totalGraficos: 1,
        archivos,
        guion: `# guion\n${codigo}\n`,
        consola: `> ${codigo}\n`,
      };
    },
    async reiniciar() {
      return null;
    },
    async estado() {
      return { hayDatos, objetos: [], columnas: [], archivos };
    },
    async leerArchivo(_sesion, nombre) {
      return archivos.some((a) => a.nombre === nombre) ? Buffer.from('a;b') : null;
    },
  };
  return motor;
}

const textoDe = (contenido) => contenido.content.find((c) => c.type === 'text').text;

test('sin motor, se dice que no está disponible y no se ejecuta nada', async () => {
  rService.usarMotor(null);
  const { contenido } = await rService.trabajar({ ...USO, codigo: 'x <- 1' });
  assert.match(textoDe(contenido), /no está disponible/);
});

test('el código que sale de la tesis no llega al motor, y se dice por qué', async () => {
  const motor = motorFalso();
  rService.usarMotor(motor);

  const { contenido, bloqueo } = await rService.trabajar({ ...USO, codigo: 'Sys.getenv()' });

  assert.equal(bloqueo.regla, 'entorno');
  assert.equal(motor.ordenes.length, 0);
  assert.match(textoDe(contenido), /NO SE EJECUTÓ/);
});

test('sin datos, la respuesta trae el enlace para subirlos', async () => {
  rService.usarMotor(motorFalso({ hayDatos: false }));
  const { contenido } = await rService.trabajar(USO);
  assert.match(textoDe(contenido), /TODAVÍA NO HAY DATOS/);
  assert.match(textoDe(contenido), /\/subir-datos\//);
});

test('una ejecución trae consola, estructura, cómo se lee, gráficos y queda guardada', async () => {
  guardados.length = 0;
  rService.usarMotor(motorFalso());

  const codigo = 'cor.test(datos$a, datos$b)';
  const { contenido } = await rService.trabajar({ ...USO, codigo });
  const texto = textoDe(contenido);

  assert.match(texto, /CONSOLA:/);
  assert.match(texto, /120 filas × 2 columnas/);
  assert.match(texto, /sexo — texto, 2 valores distintos, 3 perdidos/);
  assert.match(texto, /CÓMO SE LEE/);
  assert.match(texto, /relación significativa/);
  assert.equal(contenido.content.filter((c) => c.type === 'image').length, 1);

  assert.equal(guardados.length, 1);
  assert.match(guardados[0].script, /cor\.test/);
  assert.match(texto, /ver_analisis/);
});

test('un error de R se le dice a Claude para que lo corrija', async () => {
  rService.usarMotor(motorFalso({ resultado: 'error' }));
  const { contenido } = await rService.trabajar({ ...USO, codigo: 'x <- y' });
  assert.match(textoDe(contenido), /R SE PARÓ EN UN ERROR/);
  assert.doesNotMatch(textoDe(contenido), /CÓMO SE LEE/);
});

test('si la jaula no arranca, no se inventa un resultado', async () => {
  rService.usarMotor(motorFalso({ lanzar: new MotorNoDisponible('Access denied') }));
  const { contenido } = await rService.trabajar({ ...USO, codigo: 'x <- 1' });
  assert.match(textoDe(contenido), /no está disponible/);
});

test('descargar da un enlace si el archivo existe, y la lista si no', async () => {
  rService.usarMotor(motorFalso({ archivos: [{ nombre: 'resultados.csv', bytes: 3 }] }));

  const bien = textoDe((await rService.trabajar({ ...USO, descargar: 'resultados.csv' })).contenido);
  assert.match(bien, /\/r\/descarga\//);

  const mal = textoDe((await rService.trabajar({ ...USO, descargar: 'otro.csv' })).contenido);
  assert.match(mal, /No hay ningún archivo «otro\.csv»/);
  assert.match(mal, /resultados\.csv/);
});

test('el estado describe la estructura, nunca valores', () => {
  const texto = rService.describirEstado({
    objetos: [
      { nombre: 'datos', clase: 'data.frame', detalle: '60 x 1' },
      { nombre: 'modelo', clase: 'lm', detalle: 'lista 12' },
    ],
    columnas: [{ nombre: 'p1', clase: 'numeric', perdidos: 0, resumen: '1 5' }],
    archivos: [],
  });
  assert.match(texto, /60 filas × 1 columnas/);
  assert.match(texto, /p1 — número, de 1 a 5/);
  assert.match(texto, /modelo \(lm, lista 12\)/);
});

test('la consola larga se recorta por el medio y conserva el final', () => {
  const larga = Array.from({ length: 1000 }, (_, i) => `línea ${i}`).join('\n');
  const recortada = rService.recortarConsola(larga);
  assert.match(recortada, /línea 0/);
  assert.match(recortada, /línea 999/);
  assert.match(recortada, /líneas omitidas/);
});
