# El enlace al texto abierto

Dónde se lee gratis cada artículo de los resultados, y por qué esto se hizo en
lugar de juntar ScienceDirect.

## De dónde salió esto

De preguntar si se podía añadir ScienceDirect a la plataforma. Se probó la
clave de Elsevier que ya tenemos contra su API, el 19 de septiembre de 2026:

| Petición | Respuesta |
|---|---|
| Scopus Search (control) | **200**, 682.847 resultados |
| ScienceDirect Search v2 (`PUT /content/search/sciencedirect`) | **401** `AUTHORIZATION_ERROR` |
| Article Retrieval por DOI | **403** `AUTHENTICATION_ERROR` |

Misma clave, mismo host, misma cabecera. Scopus entra y ScienceDirect no: hace
falta el `ELSEVIER_INSTTOKEN` de una institución suscrita, el mismo que falta
desde el 17-sep y que ya nos tiene en vista STANDARD. Sin él no funciona ni en
local, así que no era algo que se pudiera dejar montado esperando.

Y aunque llegara: sobre Scopus, ScienceDirect solo añadiría el **texto
completo**, que es justo lo que el entitlement bloquea y lo que el Acuerdo de
Servicio prohíbe guardar. Scopus ya indexa todo ScienceDirect, así que para
*encontrar* fuentes no aportaba nada. Ver `scopus-api.md`.

Lo que sí faltaba de verdad era el **dónde**: Scopus dice SI un artículo es de
acceso abierto —la etiqueta ya estaba en la tabla— pero no dónde está la copia.
El tesista veía «Acceso abierto» y seguía sin poder leerlo. Eso es lo que se
hizo, y no depende de Elsevier ni de ningún permiso.

## Cómo funciona

`references/enlaceAbierto.js` pega un `enlaceAbierto` a cada resultado que
tenga DOI, en las dos búsquedas del buscador de Scopus —la normal y la de
significado—, porque si estuviera solo en una el mismo artículo tendría dónde
leerse o no según la pestaña por la que se llegó.

Dos catálogos, en este orden:

1. **OpenAlex**, en UNA consulta para toda la página (`filter=doi:a|b|c`, con
   `select` de dos campos). Es el que ya se usa aquí para todo, tiene clave
   nuestra y cubre casi todo.
2. **Unpaywall**, y **solo por los DOI que OpenAlex no conoce**. Los dos beben
   de la misma fuente —OpenAlex ingiere Unpaywall— así que preguntar por los
   veinticinco sería gastar veinticinco peticiones sueltas contra un servicio
   gratuito para confirmar lo ya sabido. Donde sí discrepan es en lo recién
   depositado, que tarda semanas en llegar a OpenAlex y es justo el artículo de
   este año que el tesista busca. Su API abierta no tiene consulta por lotes:
   es un DOI, una petición, y por eso el tope de diez por búsqueda.

Que OpenAlex distinga «no lo conozco» de «lo conozco y no tiene copia» es lo
único que permite lo anterior: su `Map` trae `null` para lo segundo, y con
`has()` se sabe cuál es cuál. Hay una prueba que lo fija, y si alguien la
«arregla» preguntándole a Unpaywall por todos, se cae.

**Nada de esto toca la cuota de Elsevier ni pide permiso a nadie.** El enlace
apunta a la copia que el propio editor o un repositorio pusieron en abierto.
Aquí no se aloja, no se copia y no se guarda ningún PDF: se enseña a dónde ir.

## Qué se devuelve, y por qué la versión importa

```
enlaceAbierto: { url, esPdf, version, licencia, donde, catalogo, mismoQueEditorial } | null
```

Siempre `null` o un enlace, **nunca ausente**: así la vista comprueba una cosa
sola y no tiene que distinguir «no hay» de «no se preguntó».

`version` no es un adorno. Una copia abierta no siempre es EL artículo:

- `publishedVersion` — la del editor. Se cita sin más y no se avisa nada.
- `acceptedVersion` — el manuscrito aceptado: mismo texto, otra maquetación.
  La página 14 no es la página 14, así que no sirve para una cita textual. La
  vista lo dice: «Manuscrito aceptado (otra paginación)».
- `submittedVersion` — un preprint sin revisión por pares, que puede decir
  cosas que el artículo publicado ya no dice. La vista lo dice: «Preprint, sin
  revisión por pares».

Un tesista que cite el preprint creyendo que es el publicado tiene un problema
que el asesor le va a encontrar. Por eso se avisa **antes** de que haga clic.

`mismoQueEditorial` marca los casos en que la copia abierta está en la propia
página del editor y el enlace coincide con el `https://doi.org/…` que la tabla
ya enseña. El dato sigue sirviendo —dice que ahí se lee gratis— pero un segundo
botón al mismo sitio sobra, y la vista no lo pinta.

## Lo que ve el tesista

En la fila de cada resultado:

- La etiqueta. Si Scopus lo marca, «Acceso abierto» como siempre. Si no lo
  marca pero encontramos copia, **«Copia gratuita»** y no «acceso abierto»,
  porque no es lo mismo: Scopus solo marca lo abierto en la editorial, y una
  copia en un repositorio se lee igual pero el artículo no es de acceso
  abierto. Llamarlo así sería decirle algo que no es.
- El aviso de versión, si la copia no es la del editor.
- El enlace: **«Descargar PDF gratis»** cuando al otro lado está el archivo, y
  **«Leer gratis»** cuando es la página desde la que se descarga.

## Si falla, no se nota

Todo falla hacia el silencio, incluido el fallo **síncrono** de que el catálogo
no sea lo que se esperaba —de ahí el `Promise.resolve().then()` de `preguntar`,
que un `.catch()` suelto dejaría escapar—. Si ninguno de los dos contesta, los
resultados salen como salían antes y en el registro queda por qué.

La regla: un enlace de cortesía no puede tumbar una búsqueda que ya gastó una
petición de la cuota semanal de Elsevier.

## Configuración

Nada obligatorio. `UNPAYWALL_MAILTO` es el correo con el que se identifica cada
petición, que es lo único que Unpaywall pide —no hay clave ni registro—; vacío
usa `OPENALEX_MAILTO`, y si tampoco, `MAIL_FROM`.

## Lo que NO se hizo, a propósito

- **ScienceDirect.** Ver arriba. El día que llegue el insttoken se puede
  reconsiderar, y entonces el sitio donde mirar es `scopus-api.md`.
- **Guardar el enlace en `references`.** El enlace es de ahora: un repositorio
  puede quitar la copia mañana y quedaría una fila prometiendo un PDF que ya no
  está. Se pide cuando se enseña.
- **Alojar o descargar ningún PDF.** Se enseña a dónde ir, y ya.
- **Tocar la importación, la biblioteca, el conector ni la ficha que se guarda.**

## Archivos

| Archivo | Qué hace |
|---|---|
| `references/enlaceAbierto.js` | Junta los dos catálogos y pega el enlace a los resultados |
| `references/unpaywall.client.js` | Unpaywall, con su tope y su correo |
| `references/openalex.client.js` | `enlacesAbiertosPorDoi()`, la consulta por lotes |
| `scopus/scopus.service.js` | `buscar()` y `buscarSemantica()` lo llaman |
| `tests/enlace.abierto.test.js` | Las decisiones de arriba, fijadas |
