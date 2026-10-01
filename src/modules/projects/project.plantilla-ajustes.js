'use strict';

/**
 * Ajustes del formato dichos en el chat.
 *
 * El tesista escribe «Times 12, doble espacio, márgenes de 2,54 y títulos APA»,
 * o sube la guía de su facultad en PDF, y Claude lo pasa a estos datos. Aquí se
 * escriben en la hoja de estilos guardada —la de su plantilla, o la nuestra si
 * no subió ninguna— y en los márgenes de la página. Claude interpreta; el Word
 * lo arma el servidor, igual en Claude, ChatGPT o Grok, sin que nadie arme un
 * .docx a mano en la conversación.
 *
 * Lo que no se pide no se toca: un ajuste de la letra deja como estaban los
 * márgenes, la portada, el encabezado y el pie de su plantilla.
 *
 * El texto de la tesis va en «Cuerpo de tesis» (ver `project.plantilla`), así
 * que el interlineado, la sangría y la alineación se ponen ahí y no en
 * «Normal»: de «Normal» heredan la portada, el encabezado y el pie, y con doble
 * espacio la portada se salía de su hoja.
 */

const {
  conPropiedades,
  conFormatoDeTitulo,
  cambiarEstilo,
  tituloNuevo,
  interiorDeEstilo,
  rFontsDe,
  APA,
  NIVELES,
  ORDEN_PPR,
  ORDEN_RPR,
  ESTILO_CUERPO,
} = require('./project.plantilla');

class AjusteNoValido extends Error {}

/** Un centímetro en twips, la medida de Word: 1440 por pulgada. */
const twips = (cm) => Math.round((cm / 2.54) * 1440);

/** Los márgenes de nuestro formato, los que valen mientras no se diga otro. */
const MARGEN_POR_DEFECTO = { top: 1701, right: 1417, bottom: 1701, left: 1701 };

const PAPEL = {
  A4: { width: 11906, height: 16838 },
  carta: { width: 12240, height: 15840 },
};

const ALINEACION = { justificado: 'both', izquierda: 'left', centrado: 'center', derecha: 'right' };

/** Lo que se le cuenta al tesista de cada medida, con coma decimal. */
const numero = (n) => String(n).replace('.', ',');

const enRango = (valor, minimo, maximo, que) => {
  const n = Number(valor);
  if (!Number.isFinite(n) || n < minimo || n > maximo) {
    throw new AjusteNoValido(`${que} tiene que estar entre ${numero(minimo)} y ${numero(maximo)}.`);
  }
  return n;
};

/** Un nombre de letra creíble: «Times New Roman», «Arial», «Calibri». Nada de XML. */
function fuenteValida(fuente) {
  const limpia = String(fuente ?? '').trim();
  if (!/^[\p{L}\d][\p{L}\d .-]{0,39}$/u.test(limpia)) {
    throw new AjusteNoValido('El nombre de la letra no es válido. Escríbelo como en Word: «Times New Roman».');
  }
  return limpia;
}

/** Cambia o pone una propiedad de los valores por defecto del documento. */
function conLetraPorDefecto(estilos, rFonts) {
  const xml = String(estilos);
  if (/<w:rPrDefault>\s*<w:rPr>[\s\S]*?<\/w:rPr>/.test(xml)) {
    return xml.replace(/<w:rPrDefault>\s*<w:rPr>([\s\S]*?)<\/w:rPr>/, (_, dentro) => {
      const sin = dentro.replace(/<w:rFonts\b[^>]*\/>/, '');
      return `<w:rPrDefault><w:rPr>${rFonts}${sin}</w:rPr>`;
    });
  }
  return xml;
}

/** El estilo del cuerpo, si la hoja no lo trae: sobre «Normal», con la sangría de APA. */
const CUERPO_NUEVO =
  `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${ESTILO_CUERPO}"><w:name w:val="Cuerpo de tesis"/>` +
  '<w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:ind w:firstLine="720"/></w:pPr></w:style>';

/**
 * Aplica los ajustes a la hoja de estilos y a la página.
 *
 * Devuelve la hoja, la página (o la misma si no se tocó) y la lista de lo que
 * se hizo, en frases que Claude le puede decir tal cual al tesista. Lanza
 * `AjusteNoValido` con un mensaje para el tesista si una medida no tiene
 * sentido; entonces no se cambia nada.
 */
function aplicar(estilos, pagina, ajustes = {}) {
  const a = ajustes ?? {};
  const hecho = [];
  let xml = String(estilos);

  // Primero se valida todo: un ajuste a medias deja un formato que nadie pidió.
  const fuente = a.fuente !== undefined ? fuenteValida(a.fuente) : null;
  const tamano = a.tamano !== undefined ? enRango(a.tamano, 8, 16, 'El tamaño de letra') : null;
  const interlineado = a.interlineado !== undefined ? enRango(a.interlineado, 1, 3, 'El interlineado') : null;
  const sangria = a.sangria !== undefined ? enRango(a.sangria, 0, 3, 'La sangría') : null;
  const espacio =
    a.espacioEntreParrafos !== undefined ? enRango(a.espacioEntreParrafos, 0, 24, 'El espacio entre párrafos') : null;
  const alineacion = a.alineacion !== undefined ? ALINEACION[a.alineacion] : null;
  if (a.alineacion !== undefined && !alineacion) {
    throw new AjusteNoValido('La alineación del texto puede ser «justificado» o «izquierda».');
  }
  const margenes = {};
  for (const [lado, clave] of [['superior', 'top'], ['inferior', 'bottom'], ['izquierdo', 'left'], ['derecho', 'right']]) {
    if (a.margenes?.[lado] !== undefined) margenes[clave] = enRango(a.margenes[lado], 1, 6, `El margen ${lado}`);
  }
  if (a.papel !== undefined && !PAPEL[a.papel]) throw new AjusteNoValido('El papel puede ser «A4» o «carta».');
  const titulos = (a.titulos ?? []).map((t) => {
    const nivel = Number(t?.nivel);
    if (!NIVELES.includes(nivel)) throw new AjusteNoValido('Los niveles de título van del 1 al 4.');
    if (t.alineacion !== undefined && !ALINEACION[t.alineacion]) {
      throw new AjusteNoValido('Un título puede ir «centrado», a la «izquierda» o a la «derecha».');
    }
    return {
      nivel,
      ...t,
      tamano: t.tamano !== undefined ? enRango(t.tamano, 8, 28, 'El tamaño de un título') : undefined,
    };
  });

  // ── El texto ──
  const tocaCuerpo = [tamano, interlineado, sangria, espacio, alineacion, fuente].some((v) => v !== null);
  if (tocaCuerpo) xml = cambiarEstilo(xml, ESTILO_CUERPO, (e) => e, CUERPO_NUEVO);

  if (fuente) {
    const rFonts = rFontsDe(fuente);
    const conLetra = (estilo) => conPropiedades(estilo, 'rPr', { rFonts }, ORDEN_RPR);
    xml = conLetraPorDefecto(xml, rFonts);
    xml = cambiarEstilo(xml, 'Normal', conLetra);
    xml = cambiarEstilo(xml, ESTILO_CUERPO, conLetra);
    // Los títulos, con la misma letra salvo que se pida otra para ellos.
    for (const nivel of NIVELES) xml = cambiarEstilo(xml, `Heading${nivel}`, conLetra);
    xml = cambiarEstilo(xml, 'TOCHeading', conLetra);
    hecho.push(`letra ${fuente} en el texto y los títulos`);
  }

  const pPr = {};
  if (interlineado !== null || espacio !== null) {
    const antes = (interiorDeEstilo(xml, ESTILO_CUERPO).match(/<w:spacing\b([^>]*)\/>/) || [, ''])[1];
    const atributos = new Map([...antes.matchAll(/w:(\w+)="([^"]*)"/g)].map(([, n, v]) => [n, v]));
    if (interlineado !== null) {
      atributos.set('line', String(Math.round(240 * interlineado)));
      atributos.set('lineRule', 'auto');
      hecho.push(`interlineado ${numero(interlineado)}`);
    }
    if (espacio !== null) {
      atributos.set('before', '0');
      atributos.set('after', String(Math.round(espacio * 20)));
      hecho.push(espacio === 0 ? 'sin espacio entre párrafos' : `${numero(espacio)} pt entre párrafos`);
    }
    pPr.spacing = `<w:spacing ${[...atributos].map(([n, v]) => `w:${n}="${v}"`).join(' ')}/>`;
  }
  if (sangria !== null) {
    // Solo la primera línea: la sangría izquierda que traiga su estilo se queda.
    const antes = (interiorDeEstilo(xml, ESTILO_CUERPO).match(/<w:ind\b([^>]*)\/>/) || [, ''])[1]
      .replace(/\s*w:(firstLine|hanging)="[^"]*"/g, '')
      .trim();
    pPr.ind = `<w:ind ${antes ? `${antes} ` : ''}w:firstLine="${twips(sangria)}"/>`;
    hecho.push(sangria === 0 ? 'sin sangría de primera línea' : `sangría de ${numero(sangria)} cm`);
  }
  if (alineacion) {
    pPr.jc = `<w:jc w:val="${alineacion}"/>`;
    hecho.push(`texto ${a.alineacion === 'justificado' ? 'justificado' : `a la ${a.alineacion}`}`);
  }
  if (Object.keys(pPr).length > 0) {
    xml = cambiarEstilo(xml, ESTILO_CUERPO, (e) => conPropiedades(e, 'pPr', pPr, ORDEN_PPR));
  }
  if (tamano !== null) {
    const sz = String(Math.round(tamano * 2));
    xml = cambiarEstilo(xml, ESTILO_CUERPO, (e) =>
      conPropiedades(e, 'rPr', { sz: `<w:sz w:val="${sz}"/>`, szCs: `<w:szCs w:val="${sz}"/>` }, ORDEN_RPR),
    );
    hecho.push(`texto en ${numero(tamano)} puntos`);
  }

  // ── Los títulos ──
  if (a.titulosApa7) {
    const sz = tamano !== null ? String(Math.round(tamano * 2)) : tamanoDelCuerpo(xml);
    for (const nivel of NIVELES) {
      xml = cambiarEstilo(
        xml,
        `Heading${nivel}`,
        (e) =>
          conFormatoDeTitulo(e, { ...APA[nivel], color: '000000', tamano: sz, mayusculas: 'no', sinSangria: true }),
        tituloNuevo(nivel),
      );
    }
    hecho.push('títulos en APA 7 (nivel 1 centrado en negrita, 2 a la izquierda en negrita, 3 en negrita y cursiva), en negro y del tamaño del texto');
  } else if (a.titulosEnNegro) {
    for (const nivel of NIVELES) {
      xml = cambiarEstilo(xml, `Heading${nivel}`, (e) => conFormatoDeTitulo(e, { color: '000000' }), tituloNuevo(nivel));
    }
    hecho.push('títulos en negro');
  }
  for (const t of titulos) {
    const formato = {
      ...(t.alineacion ? { alineacion: ALINEACION[t.alineacion] } : {}),
      ...(t.negrita !== undefined ? { negrita: t.negrita ? 'si' : 'no' } : {}),
      ...(t.cursiva !== undefined ? { cursiva: t.cursiva ? 'si' : 'no' } : {}),
      ...(t.mayusculas !== undefined ? { mayusculas: t.mayusculas ? 'si' : 'no' } : {}),
      ...(t.tamano !== undefined ? { tamano: String(Math.round(t.tamano * 2)) } : {}),
      ...(t.fuente !== undefined ? { fuente: fuenteValida(t.fuente) } : {}),
      sinSangria: true,
    };
    xml = cambiarEstilo(xml, `Heading${t.nivel}`, (e) => conFormatoDeTitulo(e, formato), tituloNuevo(t.nivel));
    hecho.push(`título de nivel ${t.nivel} ${describirTitulo(t)}`);
  }

  // ── La página ──
  let nuevaPagina = pagina;
  if (Object.keys(margenes).length > 0 || a.papel) {
    nuevaPagina = { ...(pagina ?? {}) };
    if (Object.keys(margenes).length > 0) {
      nuevaPagina.margen = { ...MARGEN_POR_DEFECTO, ...(pagina?.margen ?? {}) };
      for (const [clave, cm] of Object.entries(margenes)) nuevaPagina.margen[clave] = twips(cm);
      const NOMBRE = { top: 'superior', bottom: 'inferior', left: 'izquierdo', right: 'derecho' };
      hecho.push(
        `margen ${Object.entries(margenes).map(([c, cm]) => `${NOMBRE[c]} de ${numero(cm)} cm`).join(', ')}`,
      );
    }
    if (a.papel) {
      nuevaPagina.tamano = { ...PAPEL[a.papel] };
      hecho.push(`papel ${a.papel}`);
    }
  }

  if (hecho.length === 0) throw new AjusteNoValido('No llegó ningún ajuste que aplicar.');
  return { estilos: xml, pagina: nuevaPagina, hecho };
}

function tamanoDelCuerpo(xml) {
  for (const id of [ESTILO_CUERPO, 'Normal']) {
    const sz = (interiorDeEstilo(xml, id).match(/<w:sz w:val="(\d+)"/) || [])[1];
    if (sz) return sz;
  }
  return (String(xml).match(/<w:rPrDefault>[\s\S]*?<w:sz w:val="(\d+)"/) || [])[1] ?? '24';
}

function describirTitulo(t) {
  const partes = [];
  if (t.alineacion) partes.push(t.alineacion === 'centrado' ? 'centrado' : `a la ${t.alineacion}`);
  if (t.negrita !== undefined) partes.push(t.negrita ? 'en negrita' : 'sin negrita');
  if (t.cursiva !== undefined) partes.push(t.cursiva ? 'en cursiva' : 'sin cursiva');
  if (t.mayusculas !== undefined) partes.push(t.mayusculas ? 'en mayúsculas' : 'sin mayúsculas');
  if (t.tamano !== undefined) partes.push(`de ${numero(t.tamano)} puntos`);
  if (t.fuente !== undefined) partes.push(`en ${t.fuente}`);
  return partes.join(', ');
}

module.exports = { aplicar, AjusteNoValido, twips };
