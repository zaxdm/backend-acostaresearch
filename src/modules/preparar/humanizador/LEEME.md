# Humanizador del servidor (v3, 22-oct-2026)

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

## Resultados

| Fecha | Versión | Modelo | Documento | IA en Turnitin |
|---|---|---|---|---|
| 20-oct | prompt del servicio | Nemotron Super 3 | prueba-humanizar-grande (2016 palabras) | 84 % |
| 21-oct | v1 | DeepSeek v3.2 (Bedrock) | ídem: 28/29 párrafos, 106 s | **«*%»** (menos de 20 %) |
| 21-oct | v1 | GLM-5 (Bedrock) | ídem: 28/29 párrafos, 91 s | 33 % |
| 21-oct | v1 | Kimi K2.5 (Bedrock) | ídem: 29/29 párrafos, 52 s | 38 % |
| 21-oct | v2 | **DeepSeek v3.2 (Bedrock)** | ídem (1912 palabras) | **0 %** |
| 21-oct | v2 | GLM-5 (Bedrock) | ídem (1784 palabras) | 26 % (antecedentes, bases teóricas y dos de resultados) |

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
por la web: 100 % → 96 % (1.ª pasada) → 79 % (2.ª). Con la v3: pendiente.
