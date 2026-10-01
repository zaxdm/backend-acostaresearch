'use strict';

/**
 * El país donde estudia, y lo que cambia del método según cuál sea.
 *
 * POR QUÉ HACE FALTA
 * ------------------
 * El método nació para el pregrado peruano: matriz de consistencia, hipótesis,
 * antecedentes internacionales y nacionales, INEI, Ley 29733, asesor y jurado.
 * Un estudiante de España entrega un TFG o un TFM con otra estructura, otras
 * fuentes y otra ley de datos. Las skills no se reescriben por país: el servidor
 * le dice a Claude, en el panorama de `mi_proyecto`, qué ajustar. Así basta con
 * guardar el país una vez para que todas las conversaciones lo sepan.
 *
 * Sin país guardado no se dice nada: es el caso de casi todos, que son del Perú,
 * y el método ya está hecho para ellos.
 */

/** Los países que tienen perfil propio. El resto trabaja con el método tal cual. */
const PERFILES = {
  es: {
    nombre: 'España',
    instrucciones: [
      'PERFIL ESPAÑA. Estudia en España: su trabajo es un TFG, un TFM o una tesis doctoral, no una ' +
        'tesis de pregrado peruana. Usa las mismas herramientas y las mismas skills, con estos ajustes:',
      '- Pregúntale UNA VEZ si es TFG, TFM o tesis doctoral, y pídele la guía docente o la normativa de ' +
        'TFG/TFM de su facultad. Lo que diga esa guía manda sobre todo lo de abajo, también sobre la extensión.',
      '- Estructura: si no tiene una propia guardada, PROPÓN esta y guárdala con "estructura_de_la_tesis" ' +
        'solo cuando la confirme: 1. Introducción (de: problema-y-objetivos) · 2. Marco teórico ' +
        '(marco-teorico) · 3. Metodología (metodologia) · 4. Resultados (analisis-datos-rstudio, o ' +
        'analisis-cualitativo si es cualitativo) · 5. Discusión (discusion) · 6. Conclusiones ' +
        '(conclusiones-abstract). Numera como diga su guía, sin «CAPÍTULO I» si no lo pide.',
      '- La matriz de consistencia no se entrega en España: úsala para trabajar, pero no la pongas en el ' +
        'documento salvo que su guía la pida. Las hipótesis, solo si su diseño las necesita.',
      '- Antecedentes: no hace falta separarlos en internacionales y nacionales; es el estado de la ' +
        'cuestión. Para los de España busca con "pais": "es", y por la web en Dialnet, TESEO (tesis ' +
        'doctorales), RECOLECTA y TDX. Nada de RENATI, ALICIA ni SciELO Perú.',
      '- Datos del contexto: INE, Eurostat y los ministerios de España, no el INEI ni el MINEDU.',
      '- Ética y datos personales: Reglamento (UE) 2016/679 (RGPD) y Ley Orgánica 3/2018 (LOPDGDD), con el ' +
        'comité de ética de su universidad si recoge datos de personas. NUNCA la Ley 29733.',
      '- Palabras: tutor o tutora (no asesor), tribunal (no jurado), defensa (no sustentación), ' +
        'estudiante (no tesista), curso académico, créditos ECTS.',
      '- Norma de citas: la que diga su guía. En España se piden mucho APA 7 e ISO 690 ' +
        '(iso690-author-date-es, o iso690-full-note-es si es con notas al pie). Pregúntala, no la supongas.',
    ],
  },
};

/** Normaliza lo que llegue («ES», « es ») a las dos letras en minúscula. */
function codigoDe(pais) {
  const codigo = String(pais ?? '').trim().toLowerCase();
  return /^[a-z]{2}$/.test(codigo) ? codigo : null;
}

/** Los de siempre, para que la cabecera diga «Perú» y no «PE». */
const NOMBRES = {
  pe: 'Perú',
  mx: 'México',
  co: 'Colombia',
  cl: 'Chile',
  ec: 'Ecuador',
  bo: 'Bolivia',
  ar: 'Argentina',
};

/** El nombre para la cabecera del panorama, o el código si no se conoce. */
function nombreDe(pais) {
  const codigo = codigoDe(pais);
  if (!codigo) return null;
  return PERFILES[codigo]?.nombre ?? NOMBRES[codigo] ?? codigo.toUpperCase();
}

/** El bloque para `mi_proyecto`, o nulo si su país no cambia nada del método. */
function perfilPara(pais) {
  const perfil = PERFILES[codigoDe(pais)];
  return perfil ? perfil.instrucciones.join('\n') : null;
}

module.exports = { PERFILES, codigoDe, nombreDe, perfilPara };
