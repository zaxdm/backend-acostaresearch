# Fuentes propias — el export de Scopus que sube el comprador

Cómo funciona y dónde tocar. La vía descartada —conectar Zotero por API— está en
`bibliotecas-propias.md`, con el motivo.

## Por qué un archivo y no la API de Scopus

La API de Elsevier exige que **la institución** esté suscrita y un token atado a
ella, y su acceso gratuito es explícitamente para uso **no comercial**. Este
producto se vende. Esa puerta no está cerrada por precio sino por licencia, y no
hay ingeniería que la rodee.

Pero no hace falta: el tesista sí tiene Scopus, por su universidad. El método ya
le arma la ecuación de búsqueda para que la pegue allí, y la web ya prometía que
«el marco teórico se redacta únicamente con los artículos que **tú subes** de
Scopus, SciELO o Google Académico». Lo único que faltaba era por dónde subirlos.

## El recorrido

1. La skill le da la ecuación de búsqueda.
2. La pega en Scopus, Web of Science o SciELO con el acceso de su universidad.
3. Exporta. CSV, RIS o BibTeX: los tres se leen.
4. Sube el archivo en su perfil, «Método de tesis → Tus fuentes de Scopus».
5. Desde ese momento `buscar_fuentes` lee de su biblioteca **y** de la de la casa.

## Cómo se guarda

Todo va a la misma tabla `references`, con tres columnas nuevas:

| Columna | Fondo de la casa | Lo que sube un comprador |
|---|---|---|
| `ownerUserId` | nulo | su id |
| `origin` | `ZOTERO` | `SCOPUS` |
| `sourceRef` | nulo | `doi:…`, `eid:…` o `titulo:…` |
| `zoteroKey` | la clave del ítem | **nulo** |
| `notes` | la nota de Acosta | **nulo** |

`zoteroKey` pasó a admitir nulos y ahí acabó la migración: MySQL permite tantos
nulos como quiera en un índice único, así que la columna sigue siendo única para
las filas que la tienen y no estorba a las que no. No hizo falta tocar el índice
ni resincronizar la biblioteca.

La identidad de una fuente importada es el par (`ownerUserId`, `sourceRef`), con
índice único. Volver a subir el mismo export refresca las fichas en vez de
duplicarlas, que es lo que pasa de verdad: el tesista amplía su búsqueda en
Scopus y vuelve a exportar todo, no solo lo nuevo.

## El filtro que no puede fallar

En `reference.repository.buscar`. El fondo de la casa lleva `ownerUserId` nulo y
lo ve todo el mundo; lo que sube un comprador solo lo ve él:

```sql
AND (r.ownerUserId IS NULL OR r.ownerUserId = ?)
```

Sin dueño, la consulta se acota sola a la casa (`IS NULL`), no se abre. Es la
diferencia entre olvidarse el parámetro y filtrar de menos.

Va en los **dos** caminos de búsqueda: el del índice de texto completo y el de
reserva por `LIKE`. Filtrar bien en el rápido y mal en el lento es el fallo que
solo aparece cuando el índice no encuentra nada, o sea, casi nunca, o sea, tarde.

El orden es `ORDER BY (r.ownerUserId IS NULL)` primero: las suyas por delante,
porque es su tema y las eligió él.

## Lo que ve el asistente

Cada ficha dice de dónde viene: `[de tu biblioteca]` o
`[biblioteca de Acosta · curada]`. No es un adorno. Las de la casa llevan la nota
que explica para qué sirve cada fuente; las importadas traen el resumen que
escribió la revista para vender su artículo. Presentarlas como si fueran lo mismo
diluye justo aquello por lo que se pagó.

Y cuando no hay resultados, el conector le dice que puede subir su propio export.
Es la única vía de descubrimiento de esta función que llega en el momento en que
importa: cuando acaba de comprobar que su tema no está.

## El lector de archivos

`scopus.parser.js`. Tres formatos, reconocidos **por su contenido y no por la
extensión**, porque la extensión miente a menudo: un RIS guardado como `.txt` y
un CSV renombrado a `.xls` son lo más común que llega.

**El CSV no se parte por comas.** Es la trampa que hunde estos importadores y no
avisa: falla en silencio y guarda basura. Los resúmenes de Scopus llevan comas,
comillas y saltos de línea dentro del campo, entrecomillados según el RFC 4180.
Un `split(',')` corta el resumen, desplaza todas las columnas de esa fila y
guarda el año en el DOI sin quejarse. Por eso hay una máquina de estados de
verdad, con sus pruebas en `tests/scopus.parser.test.js`.

Las columnas se buscan **por nombre**, no por posición: el orden depende de lo
que el usuario marcara al exportar, y cada base las titula distinto.

## Los topes, y por qué están donde están

- **8 MB por archivo** (`IMPORT_MAX_BYTES`). La API entera está capada a 100 KB
  en `app.js`, lo correcto para JSON y ridículo para un export; se abre en esta
  ruta y solo en esta, igual que se abrió para el comprobante de Yape.
- **5000 fuentes por comprador** (`TOPE_POR_USUARIO`). Se comprueba contra lo que
  YA tiene, no contra el archivo: quien sube tres exports de doscientas se acerca
  al techo igual que quien sube uno de seiscientas.

## Decisiones que parecen menores y no lo son

**No hay paso de confirmación antes de guardar.** Una importación solo suma: no
pisa el fondo de la casa, no borra lo que ya tenía y repetir el archivo refresca
en vez de duplicar. Pedirle que confirme cientos de fichas que no puede revisar
de una en una sería un trámite, no una salvaguarda. El deshacer es «Borrar
todas», y ese sí pregunta.

**Sí hay un parte de lo que pasó.** Cuántas nuevas, cuántas ya tenía, cuántas se
descartaron. Un import mudo deja al comprador sin saber si funcionó, y es cuando
sube el mismo archivo tres veces.

**El material no se mezcla.** Ese export lo descargó él con la suscripción de su
universidad. Cargarlo a su propia biblioteca es una cosa; fundirlo con el corpus
de la casa y servírselo a otros compradores es otra. Por eso el dueño va en la
fila —no como etiqueta—, la clave foránea borra en cascada con la cuenta, y
`contar()` para el panel del administrador solo cuenta las de la casa.

**`borrarPorClaves` está acotado a `ownerUserId: null`.** Hoy lo importado lleva
`zoteroKey` nulo y no podría coincidir, pero esa función corre en la fase de
retiradas de cada sincronización y borra sin preguntar. El día que una fuente
importada tenga clave por lo que sea, la diferencia entre las dos versiones es
que una se lleva por delante la biblioteca de un tesista.
