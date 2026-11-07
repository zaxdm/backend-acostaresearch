'use strict';

/**
 * Las marcas del script de las skills (`articulo_docx.py`) pasadas a Markdown.
 *
 * Vive aparte para que la usen el Word de la Ficha (`r.service`) y el Word del
 * proyecto (`project.docx`) sin que uno tenga que requerir al otro.
 */

const N = '\n';

/**
 * La plantilla de la Ficha está escrita para `articulo_docx.py` de la skill:
 * `[TITULO]`, `# 1. Perfil`, `[SIN SANGRIA]`, `[TABLA 1] Título`, `[NOTA] …`.
 * Este armador lee Markdown, y esas marcas salían impresas tal cual (E2E del
 * 7-nov-2026). Se pasan a lo que entiende, en APA: «Tabla 1» en negrita y el
 * título en cursiva, la nota con «Nota.» en cursiva.
 */
function deLaSintaxisDelMotor(texto) {
  let titulo = null;
  const lineas = [];
  for (const linea of String(texto ?? '').split(N)) {
    const t = linea.trim();
    const tit = t.match(/^\[TITULO\]\s*(.+)$/i);
    if (tit) {
      titulo ??= tit[1].trim();
      continue;
    }
    const tabla = t.match(/^\[TABLA\s+(\d+)\]\s*(.*)$/i);
    if (tabla) {
      // Rótulo, título, tabla y nota van juntos, sin líneas en blanco: así los
      // toma `tablaApa` (número en negrita, título en cursiva, sin sangría).
      lineas.push('', `**Tabla ${tabla[1]}**`, `*${tabla[2].trim()}*`);
      continue;
    }
    const nota = t.match(/^\[NOTA\]\s*(.*)$/i);
    if (nota) {
      lineas.push(`*Nota.* ${nota[1].trim()}`);
      continue;
    }
    if (/^#\s/.test(t)) {
      // En su propio bloque: el armador solo lo toma por título si va suelto.
      lineas.push('', `#${t}`, '');
      continue;
    }
    lineas.push(linea.replace(/^(\s*)\[SIN SANGR[IÍ]A\]\s*/i, '$1'));
  }
  return { titulo, texto: lineas.join(N) };
}

module.exports = { deLaSintaxisDelMotor };
