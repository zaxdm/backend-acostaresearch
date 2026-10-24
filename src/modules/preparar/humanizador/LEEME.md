# Humanizador del servidor (v3.2, 22-oct-2026)

Lo que el servidor le da al modelo cuando un cliente sube su Word a «Humanizar» en Edición y
Traducción. **Meta: 0 % de IA en Turnitin.** Desde el 21-oct-2026 la usa el servicio
(`preparar.humanizar`, con DeepSeek v3.2 por defecto en `HUMANIZAR_MODELO`); el servicio sigue
en prueba, solo para administradores y usuarios beta.

## Por qué existe

El servicio dio **84 % de IA** con Nemotron el 20-oct-2026. Su prompt era un resumen de la skill
5.0, pensada para conversar con Claude, y pedía oraciones cortas y ritmo desigual. Los trabajos
que dieron 0 % con /turnitin (07, 08, 11, 12; ver `~/.claude/skills/turnitin/references/`)
hicieron otra cosa:

- reescribir **toda la prosa desde la idea**, cambiar el orden de la información y **fundir
  oraciones** con enlaces que dicen una relación real (medias de 30 a 40 palabras);
- **romper la plantilla** entre párrafos hermanos (antecedentes, justificaciones, hipótesis);
- **dos pasadas sobre el documento entero** para quitar las aperturas, conectores y moldes que se
  repiten entre párrafos. Es lo que sacó a Roy y a Milagros del «*%».

El ritmo no separa el 0 % del «*%» (calibrado el 18-oct): no se persigue.

## Qué hay

| Archivo | Qué es |
|---|---|
| `nucleo.md` | Reglas para todo párrafo: cómo se reescribe, qué se quita, qué no se mete, qué no se toca. |
| `rutas/*.md` | Una por capítulo: introducción y marco, metodología, resultados, discusión, conclusiones. Dicen qué plantilla delata en esa sección y cómo romperla. |
| `ejemplos/*.md` | De 2 a 4 pares «antes → después» por capítulo, de tesis reales que dieron 0 %. Nombres de instituciones cambiados. |
| `pasada-documento.md` | La instrucción de las dos pasadas sobre el documento entero. |
| `piezas/` | **v4.** 75 piezas cortas (≤ 2 500 caracteres) con las reglas de `/turnitin`, del humanizador académico, de `/asesorar` y de las skills de capítulo del servidor. Se mandan según lo que trae cada tanda (ver abajo). |

## Cómo la usa el servicio

`preparar.humanizar.humanizar()` (lo llama `preparar.service.producir`):

1. Lee el Word y asigna a cada párrafo su capítulo por los títulos.
2. Manda los párrafos de cada capítulo con `nucleo + ruta + ejemplos`, y la lista de cómo abren
   los párrafos ya hechos. Valen las mismas comprobaciones de siempre (cifras, citas, largo,
   vocabulario de IA, rayas, moldes); lo rechazado se pide otra vez y, si vuelve a fallar, hay un
   tercer intento.
3. Dos pasadas: el código busca lo repetido entre párrafos (aperturas, demostrativos, conectores,
   relleno; lo de `repeticiones.py`) y el modelo cambia solo eso. Cada cambio se comprueba
   contra el texto original del autor.

Para probar otro modelo o una versión nueva de estos textos sin tocar la web, en el servidor:

```
node scripts/humanizar-con-skill.js --doc /tmp/x.docx --modelos bedrock:deepseek.v3.2,bedrock:zai.glm-5 --salida /tmp/salida
node scripts/humanizar-con-skill.js --doc /tmp/x.docx --skill /tmp/otra-copia-de-esta-carpeta
```

Los textos se leen una vez al arrancar el servidor: un cambio aquí entra con el despliegue.

## Cómo se mejora

Cada Word que pase por Turnitin se anota abajo con el modelo, la versión y el porcentaje. Si
Turnitin marca algo, se mira qué tiene lo marcado y la regla va a `nucleo.md` o a la ruta que
corresponda, y se sube la versión. Los ejemplos se cambian por otros mejores cuando haya un
trabajo nuevo en 0 % de ese capítulo.

## Versiones

- **v1** (21-oct): núcleo, rutas, ejemplos y dos pasadas.
- **v2** (21-oct, tras Turnitin de la v1): el relleno y los tríos de adorno se borran aunque
  estén en el original; no se parte en «Dato. Esa/Eso + consecuencia»; no se quitan enfoque,
  técnica ni instrumento; no se añaden lecturas de las cifras; «et al.» con verbo en plural. El
  script cuenta además el relleno y los demostrativos juntos en la pasada, y da un tercer
  intento a lo que falla dos veces.

- **v3** (22-oct, tras un documento de 5 000 palabras con la misma plantilla en cada sección que
  dio 100 % → 96 % → 79 % pasándolo una y otra vez): lo que separa el 0 % del resto es cuánto se
  parecen los párrafos ENTRE SÍ (medido en tramos de 5 palabras: los 0 % comparten el 4–8 %; el
  de 96 %, el 41 %), no cuánto copian del original (los 0 % copian el 23–25 %). Tras la primera
  reescritura, el código mide cada párrafo contra los anteriores y, si comparte más del 15 %, lo
  rehace entero viendo las frases repetidas y su gemelo (`romper-plantilla.md`, dos rondas). En
  la primera reescritura ya se avisa qué párrafos comparten plantilla en el original, y las
  pasadas quitan también las rayas y los dos puntos que traía el original.
- **v3.1** (22-oct, probada con la clave de Bedrock en local): los párrafos rehechos a la vez
  volvían a parecerse entre sí (22 de 38). Ahora a cada hermano de una plantilla le toca una
  forma de entrar distinta (`ARQUITECTURAS`, la regla de la Ruta 0 %), una lista ya dicha entera
  se nombra en vez de copiarse, hay tres rondas contra la plantilla y un tope de 45 palabras por
  oración. Con el documento de 5 000: parecido entre párrafos 41 % (v2) → 16 % → **13 %**
  (v3.1), 43 llamadas, ~0,18 USD. El Word de prueba en 0 % tenía 4 %; el largo de las oraciones
  no separa (ese tenía 50 palabras de media). El script imprime qué hizo y rechazó cada ronda.

## Resultados

| Fecha | Versión | Modelo | Documento | IA en Turnitin |
|---|---|---|---|---|
| 20-oct | prompt del servicio | Nemotron Super 3 | prueba-humanizar-grande (2016 palabras) | 84 % |
| 21-oct | v1 | DeepSeek v3.2 (Bedrock) | ídem: 28/29 párrafos, 106 s | **«*%»** (menos de 20 %) |
| 21-oct | v1 | GLM-5 (Bedrock) | ídem: 28/29 párrafos, 91 s | 33 % |
| 21-oct | v1 | Kimi K2.5 (Bedrock) | ídem: 29/29 párrafos, 52 s | 38 % |
| 21-oct | v2 | **DeepSeek v3.2 (Bedrock)** | ídem (1912 palabras) | **0 %** |
| 21-oct | v2 | GLM-5 (Bedrock) | ídem (1784 palabras) | 26 % (antecedentes, bases teóricas y dos de resultados) |
| 24-oct | v4 | DeepSeek v3.2 | tesis 16 (proyecto de revisión, 3 596 palabras; original **97 %**) | 30 % (16 párrafos marcados; cuatro conservaban el 72–84 % del original) |
| 24-oct | v4b (control de copia ≤ 50 %) | DeepSeek v3.2 | ídem | 21 % (9 párrafos, 7 de ellos la metodología en futuro) |
| 24-oct | v4c (v4b pasada otra vez entera) | DeepSeek v3.2 | ídem | «*%» (similitud 1 %) |
| 24-oct | v4d (v4b con solo los 9 marcados rehechos) | DeepSeek v3.2 | ídem | «*%» (similitud 2 %): no bajó |

Revisión a mano de la v1 (21-oct), para la v2:
- Los tres perdieron «la técnica fue la encuesta»; Kimi además «enfoque cualitativo» y
  «cuantitativo» de dos antecedentes. Falta una regla: el enfoque, el diseño, la técnica y el
  instrumento no se quitan nunca.
- Un párrafo que falla dos veces se queda en su original, que es texto de IA puro (DeepSeek ¶21,
  GLM ¶22 con «cabe destacar» y «crucial»). Para la meta de 0 % hace falta un tercer intento.
- Kimi dejó un «no solo… sino», un «Silva et al. (2023) estudió» y un cierre optimista, y en
  resultados añadió lecturas que el autor no escribió («supera a los otros dos niveles sumados»).
- GLM-5 fue el más fiel (conservó los enfoques).

Lo que marcó Turnitin en GLM-5 y Kimi (v1), y que la v2 corrige:
- Sobre todo la realidad problemática, la justificación y las bases teóricas, que en el original
  eran relleno genérico. Los dos modelos conservaron el relleno («sociedad cada vez más
  interconectada», «entorno digital que cambia constantemente») y los tríos («integral,
  articulada y sostenible», «crítico, creativo y seguro») por no perder nada.
- GLM partió cada párrafo en «Dato. Esa brecha / Eso repercute / Ese uso + consecuencia»: el
  mismo molde en cinco párrafos seguidos, que el contador no veía porque no miraba «esa/ese».
- DeepSeek, el único bajo el 20 %, fue el que más fundió (oración media de 37,6 palabras).

Documento de 5 000 palabras con plantilla repetida (`documentacion/pruebas/20000/`), v2 + DeepSeek
por la web: 100 % → 96 % (1.ª pasada) → 79 % (2.ª). Con la v3.1 (`20000/v3d/`): pendiente de Turnitin.

## v3.2 (22-oct-2026): enunciados, sujeto y escritura de las cifras

Un Word de revisión sistemática salió con el objetivo general reformulado, la lista «(a)–(d)» fundida,
una finalidad perdida y un «el equipo» inventado, sin que ninguna comprobación lo viera. Reglas nuevas
en `nucleo.md` (sección «ENUNCIADOS DEL ESTUDIO», «SUJETO Y VOZ», tiempo verbal, cifras tal como se
escribieron) y en las dos instrucciones de segunda ronda, y rechazos nuevos en
`motor.comprobarHumanizado`. Falta pasar por Turnitin el Word nuevo para ver que el porcentaje de IA
no cambió.

## v4 (24-oct-2026): las demás skills, en piezas

Se sumaron las reglas de redacción de `/turnitin` (SKILL, casos de IA, muestra del 0 %, `repeticiones.py`),
del humanizador académico (catálogo de patrones, voz del método, auditoría de la salida), de `/asesorar` y de
las skills de capítulo del servidor (`skills/tesis`, `informe`, `articulo`, `tsp`, `revision`). Como pasan de
140 KB, no se mandan enteras: cada una es un archivo corto en `piezas/` y el código (`preparar.piezas`) elige
las que le tocan a cada tanda.

| Carpeta | Piezas | Cuándo entran |
|---|---|---|
| `piezas/turnitin/` | 10 | 4 siempre (`general`, `registro-que-dio-0`, `errores-al-reordenar`, y la del humanizador `00-siempre…`); `segunda-pasada` va con las pasadas; el resto, según lo que trae el párrafo (antecedente, definición, método, nota, molde). |
| `piezas/humanizador/` | 20 | Según el párrafo: cita que abre oración, hipótesis, resultados con porcentajes, recomendaciones, párrafo largo, cualitativo, jurídico… |
| `piezas/asesorar/` | 2 | Antecedentes (no seguir el resumen) y terminología fija. De `/asesorar` solo entra la redacción: nada de precios, clientes ni cotización. |
| `piezas/capitulos/` | 42 | Primera línea `CUANDO: titulo~/…/ o texto~/…/`: por el título de la sección o por lo que dice el párrafo. Las de informe, TSP, artículo y revisión solo entran si el documento es de ese tipo (`tipoDeTrabajo`). |

Reglas de la selección (`elegir`): las «siempre» (≈5 KB) van en toda tanda; las demás, hasta 12 000
caracteres, primero las de capítulo, luego las concretas y al final las generales (`fidelidad-de-alcance`,
`voz-del-metodo`, `terminologia-fija`, `pares-del-0`). El texto va entre la ruta y el formato. El script
imprime qué piezas usó y de qué tipo de trabajo tomó el documento.

Las condiciones de las piezas que no son de capítulo están en `CONDICIONES` de `preparar.piezas.js`; las de
capítulo, en la primera línea de cada archivo. Un archivo sin condición no se carga y la prueba lo avisa.

**Qué se decidió cuando una skill decía otra cosa** (el detalle, con fuente y frase, en
`piezas/CONTRADICCIONES-*.md`): manda `nucleo.md`, porque es lo que dio 0 %.

- Ritmo y largo: no se persigue el ritmo desigual ni las oraciones cortas; se funde, con tope de 45 palabras.
- Aperturas y conectores de manual («Respecto a», «En cuanto a», «Asimismo», «Por otro lado»): se quitan, aunque
  las plantillas de capítulo los traigan.
- Lo que el primer reporte dejó limpio no se reescribe (Ruta 0 %): **no se aplica**, porque el servicio no tiene
  reporte. Se reescribe todo, como hasta ahora; es la diferencia más probable con los 0 % hechos a mano.
- Enunciados (problema, objetivos, hipótesis): se copian con su forma; no se reformulan, porque el servicio no
  puede pedir la aprobación del asesor.
- Sinónimos: el término técnico se repite, no se rota.
- Voz: se mantiene la del original (impersonal o primera persona, según la guía del TSP o del informe).
- Notas de tabla y párrafos de 15 a 24 palabras: pieza propia; los de menos de 15 se siguen devolviendo iguales.
- `voz-del-metodo`, `cualitativo` y `juridico` vienen marcadas por la skill de origen como hipótesis (sin caso
  real que las confirme); van con rango bajo y solo si caben.

Probado en Turnitin con la tesis 16 (ver «Resultados»): 97 % → 30 % → 21 % → «*%». **No llegó a 0 %.** Lo que se
aprendió:

- Un párrafo que conserva más de la mitad de las secuencias de cuatro palabras del original lo marca Turnitin
  aunque ninguna oración sea idéntica: `motor.comprobarHumanizado` lo rechaza desde la v4b (`COPIA_MAXIMA`).
- Pasar el documento entero otra vez (v4c) lo llevó a «*%»; reescribir solo lo marcado (v4d, Ruta 0 % de /turnitin)
  no cambió nada más. Con «*%» Turnitin ya no resalta: por eso hay que guardar el primer reporte con marcas.
- La metodología de un proyecto, en futuro («se organizará», «se examinará»), fue lo último que siguió marcado.
- El modelo inventó dos veces un sujeto («volvemos a conservar», «los técnicos dejarán documentados»): el primero
  ya se rechaza (`SUJETO_INVENTADO` lleva los verbos en primera persona del plural); el segundo no, porque no hay
  lista que lo cubra.
- `scripts/humanizar-con-skill.js --marcado <json>` reescribe solo los párrafos del reporte de IA.
- Pieza nueva `piezas/turnitin/metodologia-en-futuro.md` (entra con dos o más oraciones «se + futuro»):
  varía el sujeto, mete la razón en la oración de la decisión y no cuenta el procedimiento en fila. Sin
  probar aún en Turnitin.
- Diagnóstico del «*%» de la v4e partiendo el Word sin cambiar nada: introducción y antecedentes
  internacionales 0 %, antecedentes nacionales y marco 0 %, **metodología 36 % con resaltado** (población,
  criterios, instrumentos y procedimiento: series de cinco o seis elementos en una oración, «si…, se +
  futuro» repetido, trámite genérico). Con la pieza ampliada (listas de tres como mucho, atar cada oración
  al caso, una sola condición por párrafo) y el servicio rehaciendo solo esos 4 párrafos: **0 %**.

## Con reporte: lo marcado se rehace, no se maquilla (24-oct-2026)

Edheliza (57 %) con su reporte por la web dio «*%». Comparado con la versión a mano que dio 0 % sobre los
mismos 31 párrafos marcados: las dos rehicieron casi todas las oraciones marcadas, pero el servicio las
maquilló (copia del original 34 % frente a 26 %; «La realidad mostró entonces una escuela que…» casi igual) y
las fundió (118 oraciones frente a 146; media 33,6 frente a 27,1). Con reporte (`estricto`):

- `motor.comprobarMarcado` rechaza en lo marcado: copia > 35 % de las secuencias de cuatro palabras, menos
  oraciones que el original, una oración de más de 50 palabras (si el original no la tenía). Calibrado: a mano
  fallan 10 de 31, el servicio v1 19.
- `MARCADO` va AL FINAL del prompt y manda sobre lo que el núcleo dice de fundir (delante, el modelo fundía
  igual: la v2 dio 106 oraciones).
- El reintento lleva el motivo del rechazo (`fallo_anterior`), y lo que falla por algo leve no se entrega en la
  segunda vuelta (`promoverLeves: false`): va a un tercer intento, y solo si tampoco sale se queda la mejor
  versión.

Resultado en local (v3): 138 oraciones, media 30,2, 10 de 31 sin cumplir. Dos párrafos marcados se quedaron
en el original porque el modelo cambiaba una cifra en los tres intentos. Falta Turnitin.
