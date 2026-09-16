'use strict';

/**
 * El Word de tesis y de artículo, congelado.
 *
 * Se guarda el `document.xml` que sale de `armar` con portada, capítulos, una
 * tabla APA y una figura marcada. Añadir la portada de los informes toca esta
 * función, y la portada, los títulos y el cuerpo de tesis y artículo tienen que
 * salir idénticos. Ver `instantaneas/instantanea.js`.
 */

const test = require('node:test');
const AdmZip = require('adm-zip');

const { comparar } = require('./instantaneas/instantanea');
const { armar } = require('../src/modules/projects/project.docx');

const CAPITULO_CON_TABLA = `## 1.1 Realidad problemática

El problema es la deserción universitaria en el primer año.

**Tabla 1**
*Estudiantes por ciclo*
| Ciclo | Frecuencia | Porcentaje |
|---|---|---|
| I | 43 | 86,0 % |
| II | 7 | 14,0 % |
*Nota.* Datos de la oficina de registro.

**Figura 1**
*Evolución de la matrícula*
[Insertar aquí la Figura 1: matricula.png]
*Nota.* Elaboración propia.`;

async function documentoDe(datos) {
  const zip = new AdmZip(await armar(datos));
  return zip.readAsText('word/document.xml');
}

test('el Word de una tesis no cambia', async () => {
  comparar(
    'word.tesis',
    await documentoDe({
      tema: 'Deserción universitaria en el primer año',
      carrera: 'Psicología',
      universidad: 'Universidad Nacional Mayor de San Marcos',
      nombre: 'Juan Pérez Quispe',
      asesor: 'Dra. Ana Ruiz',
      capitulos: [
        { titulo: '2 · Capítulo I · Problema y objetivos', texto: CAPITULO_CON_TABLA },
        { titulo: '3 · Capítulo II · Marco teórico', texto: '## 2.1 Antecedentes\n\nGarcía (2024) encontró que…' },
      ],
    }),
  );
});

test('el Word de un informe de curso no cambia', async () => {
  comparar(
    'word.informe-curso',
    await documentoDe({
      tema: 'La informalidad laboral en los mercados de Lima',
      carrera: 'Administración de Empresas',
      universidad: 'Tecsup',
      nombre: 'Ana Ruiz',
      portadaInforme: {
        institucion: 'Tecsup',
        programa: 'Administración de Empresas',
        curso: 'Economía General',
        tema: 'La informalidad laboral en los mercados de Lima',
        tipo: 'Informe académico de curso',
        docente: 'Mg. Rosa Díaz',
        integrantes: [{ nombre: 'Ana Ruiz', codigo: 'U2023001' }, { nombre: 'Luis Soto' }],
        nombre: 'Ana Ruiz',
        cicloSeccion: 'IV ciclo, sección B',
        ciudad: 'Lima',
        fechaEntrega: '2026-09-30',
      },
      capitulos: [
        { titulo: 'Resumen', texto: 'El informe revisa la informalidad laboral.' },
        { titulo: 'Fase 2 — Desarrollo', texto: CAPITULO_CON_TABLA },
      ],
    }),
  );
});

test('el Word de un artículo no cambia', async () => {
  comparar(
    'word.articulo',
    await documentoDe({
      tema: 'Adopción de pagos digitales en mypes',
      carrera: null,
      universidad: null,
      nombre: 'María López',
      capitulos: [
        { titulo: 'Fase 2 — Introducción', texto: 'Las mypes concentran el empleo.' },
        { titulo: 'Fase 5 — Resultados', texto: CAPITULO_CON_TABLA },
      ],
    }),
  );
});
