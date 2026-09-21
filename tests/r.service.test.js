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
    // Como project.service: un exporte bibliográfico va a la skill del mapeo.
    return {
      capitulo: datos.bibliografico ? 'mapeo-bibliometrico' : 'analisis-datos-rstudio',
      escritos: ['script', 'salida'],
    };
  },
});

const rService = require('../src/modules/r/r.service');
const { MotorNoDisponible } = require('../src/modules/r/r.motor');

const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const USO = { userId: 'u1', productCode: 'METODO_9_SKILLS' };

function motorFalso({ hayDatos = true, resultado = 'ok', lanzar, archivos = [], bibliografica = false } = {}) {
  const motor = {
    ordenes: [],
    async listo() {
      return true;
    },
    async esBibliografica() {
      return bibliografica;
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

test('con datos ya subidos, el enlace solo sale si se pide con subir, y avisa de que reemplaza', async () => {
  rService.usarMotor(motorFalso({ hayDatos: true }));

  const sinPedir = textoDe((await rService.trabajar(USO)).contenido);
  assert.doesNotMatch(sinPedir, /\/subir-datos\//);

  const pedido = textoDe((await rService.trabajar({ ...USO, subir: true })).contenido);
  assert.match(pedido, /\/subir-datos\//);
  assert.match(pedido, /REEMPLAZA los datos de la sesión/);
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

test('con un exporte bibliográfico, lo ejecutado va al análisis del mapeo y no al de resultados', async () => {
  guardados.length = 0;
  rService.usarMotor(motorFalso({ bibliografica: true }));

  const { contenido } = await rService.trabajar({ ...USO, codigo: 'figura_bibliometrica("produccion_anual")' });
  const texto = textoDe(contenido);

  assert.equal(guardados.length, 1);
  assert.equal(guardados[0].bibliografico, true);
  assert.match(texto, /capitulo "mapeo-bibliometrico"/);
  assert.match(texto, /resultados de su tesis, si lo tenía, sigue intacto/);
});

test('con una matriz, lo ejecutado sigue yendo al análisis de resultados', async () => {
  guardados.length = 0;
  rService.usarMotor(motorFalso());
  await rService.trabajar({ ...USO, codigo: 'x <- 1' });
  assert.equal(guardados[0].bibliografico, false);
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

// ── El informe en Word ─────────────────────────────────────────────────────

/** Un PNG mínimo que pasa la comprobación de cabecera. */
const PNG_INFORME = (() => {
  const b = Buffer.alloc(64);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(800, 16);
  b.writeUInt32BE(600, 20);
  return b;
})();

function motorDeInforme({ figuras = {}, consola = '' } = {}) {
  const guardados = new Map();
  return {
    guardados,
    async listo() {
      return true;
    },
    async leerArchivo(_sesion, nombre) {
      return figuras[nombre] ?? null;
    },
    async estado() {
      return { hayDatos: true, objetos: [], columnas: [], archivos: Object.keys(figuras).map((nombre) => ({ nombre, bytes: 64 })) };
    },
    async guardarArchivo(_sesion, nombre, bytes) {
      guardados.set(nombre, bytes);
    },
    async consola() {
      return consola;
    },
  };
}

const INFORME = `# 4.1. Resultados descriptivos

**Tabla 1**
*Nivel de la variable*
| Nivel | f | % |
|---|---|---|
| Alto | 43 | 86,0 % |
*Nota.* n = 50.

**Figura 1**
*Distribución*
![](figura1.png)
*Nota.* Procesado en R 4.3.3.

El coeficiente fue rho = 0,221 con p = 0,123.`;

test('el informe se arma, se guarda en la sesión y se da el enlace', async () => {
  const motor = motorDeInforme({
    figuras: { 'figura1.png': PNG_INFORME },
    consola: 'Alto 43 86.0\nrho 0.221 p-value = 0.123\n',
  });
  rService.usarMotor(motor);

  const respuesta = await rService.informe({ ...USO, titulo: 'CAPÍTULO IV\nRESULTADOS', texto: INFORME, norma: 'apa' });
  const texto = textoDe(respuesta);

  assert.match(texto, /Informe listo: 1 tablas, 1 figuras/);
  assert.match(texto, /APA 7/);
  assert.match(texto, /\/r\/descarga\//);
  assert.ok(motor.guardados.get('informe-de-resultados.docx')?.length > 1000, 'el Word se guarda en la sesión');
  assert.doesNotMatch(texto, /REVISA ESTAS CIFRAS/, 'todas las cifras están en la consola');
});

test('si falta una figura no se arma nada, y se dice cuál y cómo guardarla', async () => {
  const motor = motorDeInforme({ figuras: {} });
  rService.usarMotor(motor);

  const texto = textoDe(await rService.informe({ ...USO, texto: INFORME }));
  assert.match(texto, /NO SE ARMÓ EL INFORME/);
  assert.match(texto, /figura1\.png/);
  assert.match(texto, /png\("figura1\.png"/);
  assert.equal(motor.guardados.size, 0);
});

test('una cifra que no salió de R se marca', async () => {
  rService.usarMotor(motorDeInforme({ figuras: { 'figura1.png': PNG_INFORME }, consola: 'Alto 43 86.0\n' }));

  const texto = textoDe(await rService.informe({ ...USO, texto: INFORME }));
  assert.match(texto, /REVISA ESTAS CIFRAS/);
  assert.match(texto, /0,221/);
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
