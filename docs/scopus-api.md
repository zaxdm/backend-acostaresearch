# Scopus por API — conectar, buscar, importar

Cómo funciona, qué falta de Elsevier y por qué está apagado. La vía que **sí**
funciona sin depender de nadie —subir el export— está en `fuentes-propias.md`, y
**sigue intacta**: esto se añadió al lado, no en su lugar.

El enlace a la copia que se lee gratis, que se pega a estos resultados y no
depende de Elsevier para nada, está en `enlace-abierto.md`. Ahí está también
por qué NO se juntó ScienceDirect, con lo que contestó su API el 19-sep-2026.

## Lo primero, porque decide todo lo demás

**Esta función está apagada** (`SCOPUS_API_ENABLED=false`) y tiene que seguir así
hasta que exista un acuerdo por escrito con Elsevier. No es prudencia de más.

El [Acuerdo de Servicio de la API de Elsevier](https://dev.elsevier.com/api_service_agreement.html)
dice que la licencia se rige por «the agreement between Elsevier and **Your
institution, company or organization**», y prohíbe expresamente dos cosas que
este producto haría:

- «does not substantially or systematically reproduce, retain, **store locally**,
  redistribute or disseminate any Elsevier content»
- «does not **share with and/or enable a third party access** to the Elsevier
  content, or any part thereof»

Guardar fichas de Scopus en la biblioteca de cada comprador de un producto que se
vende es lo uno y lo otro. Registrar la clave en dev.elsevier.com es gratis y no
cambia nada de esto: da **acceso técnico, no permiso**.

Por eso el interruptor. Con él en `false` las rutas contestan «no disponible», la
web no enseña el botón y la tarjeta «Tus fuentes de Scopus» se comporta
exactamente como antes.

**Está en `true` en el `.env` local** para poder probarlo de punta a punta, que
es otra cosa: ahí no hay compradores. El `.env` de producción vive en el
servidor (`/opt/acostaresearch/app/.env`) y es un archivo distinto; encenderlo
allí es la decisión que depende del párrafo de arriba, y no la toma este
documento.

## Lo que falta de Elsevier, exactamente

| Qué | Para qué | Cómo se consigue | Estado |
|---|---|---|---|
| **Permiso comercial** | Que lo anterior deje de ser un problema | Acuerdo con Elsevier / `apisupport@elsevier.com` | **Pendiente. Bloquea encender nada.** |
| **API Key** | Buscar. Cabecera `X-ELS-APIKey` | dev.elsevier.com, autoservicio | **Ya está y FUNCIONA** (probada el 17-sep-2026) |
| **Institutional token** | Que Scopus mande el resumen y los autores | Lo pide la biblioteca de una institución suscrita, indicando la clave | **Pendiente, pero ya no bloquea**: ver abajo |
| **`client_id` / `client_secret`** | OAuth del propio tesista | `apisupport@elsevier.com` — el portal **no** los emite | **Pendiente** |
| **URL de autorización y de canje** | Ídem | Ídem. Elsevier **no las publica** | **Pendiente** |
| **Scopes** | Ídem | Ídem | **Pendiente** |
| **Redirect URI registrada** | Ídem | Se declara al registrar la aplicación | **Pendiente** |
| `SECRETS_KEY` | Cifrar los tokens que devuelva | `openssl rand -base64 32` | Ya está (la usa Zotero) |

### Sobre el OAuth, para que no se busque en vano

La documentación de autenticación de Elsevier dice, con estas palabras, que
ofrecen «an oauth implementation for developers wanting to integrate
ScienceDirect and/or Scopus content into client-side applications requiring
access to user level (rather than institutional) content». Y ahí se acaba: **no
hay endpoint de autorización documentado, ni de canje, ni lista de scopes, ni
forma de registrar un `client_id` desde el portal**, que solo emite API Keys. El
WADL de la Authenticate API tampoco documenta ningún endpoint OAuth.

Por eso `scopus.oauth.js` **no nombra ni una sola URL de Elsevier**: las lee del
`.env`. Adivinarlas y escribirlas en el código habría sido lo peor de las dos
opciones —parecería terminado, fallaría con un 404 en producción, y el día que
Elsevier conteste nadie sabría dónde estaba el valor bueno—.

### Sobre el resumen y los autores: comprobado, y resuelto

El 17 de septiembre de 2026 se probó la clave contra `api.elsevier.com`. Resultado:

- **La clave funciona.** Una búsqueda normal devuelve 10.149 resultados y la cuota
  semanal es de **20.000 peticiones**.
- **La vista `COMPLETE` se rechaza con 401**, porque la IP de este servidor no
  pertenece a ninguna institución suscrita. Eso significa vista `STANDARD`, y ahí
  faltan dos cosas que se ven en el Word del tesista:
  - **no hay resumen** (`dc:description`), así que Claude no encontraría la fuente
    al redactar: solo quedaría el título para buscarla;
  - **`dc:creator` es UN SOLO autor.** La bibliografía saldría «Brignole, M.» en un
    artículo con treinta firmantes, que en APA está mal y lo ve el asesor.

**Se arregla sin el insttoken: Scopus busca, el catálogo abierto completa.** Al
importar, las fichas que llegan a medias y tienen DOI se completan con
`openalex.porDoi` y `crossref.porDoi` —los mismos dos clientes, y en el mismo
orden de preferencia, que ya usa `propias.service.importarPorDoi`—. Medido sobre
el mismo artículo:

| | Solo Scopus | Ya completada |
|---|---|---|
| Autores | `Brignole, M.` | `Brignole, M.; Moya, A.; de Lange, F.; …` (20) |
| Resumen | — | «The Task Force for the diagnosis and management of syncope…» |
| Vol./núm./págs. | 39 / 21 / 1883-1948 | igual |

Por qué esto no es un apaño: a Scopus se le pide **lo que solo Scopus tiene** —su
índice, su lenguaje de ecuaciones y su recuento de citas—. Los metadatos
bibliográficos de un artículo con DOI no son secreto de nadie: están en Crossref
porque los depositó el editor, y el resumen está en OpenAlex.

Manda **Crossref** en los autores (es donde están con apellido y nombre
separados) y **OpenAlex** en el resumen. Todo lo demás —título, revista, tipo de
documento— lo manda **Scopus** y solo se rellena si falta: es lo que el tesista
vio al marcar la casilla, y cambiárselo por detrás sería guardar una ficha que no
es la que eligió. `scopus.mapper.completar()`.

Lo que **no** se arregla así: un artículo sin DOI, o uno cuyo resumen no esté en
OpenAlex. Se guarda igual y se cuenta en el parte de la importación
(`sinResumen`), como ya se hace con los exports.

Con `ELSEVIER_INSTTOKEN` puesto, nada de esto hace falta: Scopus manda la ficha
entera y no se molesta a los catálogos abiertos. Hay una prueba que lo fija.

### Comprobar la clave en cinco segundos

```
npm run scopus:probar            # la del .env
node scripts/probar-scopus.js <clave>   # una antes de ponerla
```

Distingue las tres cosas que aquí fallan de formas parecidas y se confunden:

| Elsevier contesta | Significa | Se arregla |
|---|---|---|
| `APIKEY_INVALID` | La clave está mal copiada (no tiene 32 hex) | Cópiala entera del portal |
| `AUTHENTICATION_ERROR` | Tiene la forma pero no está registrada | Comprueba en dev.elsevier.com |
| `403` | Vale, pero no hay entitlement | `ELSEVIER_INSTTOKEN` |
| `200` sin `dc:description` | Vista STANDARD | Lo completa el catálogo abierto |

## El recorrido

1. **Conectar Scopus** → `POST /api/v1/mi-scopus/conectar`
   - Con OAuth configurado: devuelve la URL de Elsevier y deja una cookie
     `scopus_oauth` (httpOnly, `lax`, solo en `/mi-scopus`) con el `state`.
   - Sin OAuth: crea la conexión en modo `APIKEY` y contesta. No se intercambia
     ninguna credencial del tesista; queda constancia de que aceptó las
     condiciones de uso y se le enciende el buscador.
2. **La vuelta** → `GET /api/v1/mi-scopus/vuelta`. Va **antes** del `authenticate`
   y sin él: quien llega es el navegador siguiendo una redirección desde otro
   dominio y su cookie de sesión puede no viajar. La identidad sale de la fila
   `scopus_oauth_states`, que se borra al usarse y caduca en dos horas, **y**
   tiene que venir con la cookie del navegador que empezó.
3. **Buscar** → `POST /api/v1/mi-scopus/buscar` con la ecuación tal cual. Se le
   pasa a Elsevier **sin reescribirla**: es el mismo lenguaje que el tesista pega
   en Scopus y que le arma la skill del método, y tocarla aquí haría que la misma
   búsqueda diera resultados distintos según dónde se pegue.
4. **Importar** → `POST /api/v1/mi-scopus/importar` con los **EID** de lo marcado.
5. **Desconectar** → `DELETE /api/v1/mi-scopus`. Se va la conexión, **no las
   fuentes**: están citadas en sus capítulos.

### La correspondencia con los nombres genéricos

`/mi-scopus` y no `/scopus` porque en esta casa el prefijo dice **de quién** es lo
que cuelga: `/referencias` es el corpus de Acosta, `/mis-fuentes` y `/mi-zotero`
son de cada comprador.

| Genérico | Aquí |
|---|---|
| `POST /api/v1/scopus/connect` | `POST /api/v1/mi-scopus/conectar` |
| `GET /api/v1/scopus/callback` | `GET /api/v1/mi-scopus/vuelta` |
| `GET /api/v1/scopus/status` | `GET /api/v1/mi-scopus/estado` |
| `POST /api/v1/scopus/search` | `POST /api/v1/mi-scopus/buscar` |
| `POST /api/v1/scopus/import` | `POST /api/v1/mi-scopus/importar` |
| `POST /api/v1/scopus/disconnect` | `DELETE /api/v1/mi-scopus` |

## Por qué al importar viajan identificadores y no fichas

El navegador manda los **EID** de lo que el tesista marcó, y el servidor **vuelve
a pedírselas a Scopus** con una consulta `EID(a) OR EID(b) …`.

Podría mandar los datos bibliográficos que ya tiene en pantalla y ahorrarse la
petición. Entonces lo que acabaría en la biblioteca sería lo que dijera una
petición del navegador y no lo que dijo Elsevier: cualquiera podría meterse
fuentes inventadas, con el título y los autores que quisiera, y citarlas en su
tesis como si fueran reales. Es el mismo criterio que la importación por DOI.

Cada EID se comprueba **dos veces** contra `^2-s2\.0-\d{5,20}$`: en el esquema de
la ruta y otra vez en `scopus.mapper.esEid` antes de armar la ecuación. Sin eso,
un texto con paréntesis o un `OR` dentro cambiaría la consulta entera.

## Cómo se guarda, y por qué `ReferenceOrigin` no cambió

Va todo por `references/propias.repository.guardarLote()` — **el mismo** que
escribe el export y el Zotero del tesista. No hay una segunda puerta a
`references`: esa tabla tiene filas de la casa (sin dueño, visibles para todos) y
filas de una persona, y la única forma de no confundirlas nunca es que solo un
archivo sepa escribirlas.

`scopus.mapper.comoFila()` produce una fila **indistinguible** de la que produce
`references/scopus.parser.aFila()`:

| Columna | Por API | Por archivo |
|---|---|---|
| `ownerUserId` | su id | su id |
| `origin` | `SCOPUS` | `SCOPUS` |
| `sourceRef` | `doi:…` → `eid:…` → `titulo:…` | igual |
| `zoteroKey` | nulo | nulo |
| `notes` | nulo | nulo |

Esa igualdad **es** la deduplicación: el artículo importado el martes desde aquí
y el mismo dentro del CSV que sube el jueves comparten `sourceRef`, así que el
`upsert` sobre `(ownerUserId, sourceRef)` refresca la ficha en vez de duplicarla.
Y el cruce por DOI que ya hacía `guardarLote` cubre el caso de la misma fuente
entrada por caminos que calculan identidades distintas. Hay una prueba que lo
fija: `tests/scopus.api.test.js`, «la misma fuente por API y por archivo es UNA
fila, no dos», que corre el parser de verdad contra el mapper.

**No se añadió `SCOPUS_API` al enum `ReferenceOrigin`.** Habría obligado a revisar
`filtroDeOrigen`, el enum del conector (`mis_fuentes`), el rótulo de la lista y la
dedup, todo para distinguir dos cosas que al tesista le da igual distinguir: la
fuente es la misma y la licencia de Elsevier también.

Lo que sí se añadió al repositorio es `cualesTiene()`, para **marcar** los
resultados que ya están en su biblioteca. Se marcan, no se esconden: quien busca
en Scopus quiere ver los mismos artículos que ve en Scopus.

## Qué no ve nadie más

Lo de siempre, sin excepción para esta vía:

- El dueño va en la fila (`ownerUserId`), no como etiqueta.
- `reference.repository.buscar()` filtra con
  `AND (r.ownerUserId IS NULL OR r.ownerUserId = ?)`. **No hizo falta tocarlo.**
- Todas las rutas trabajan sobre `req.user.id`; ninguna acepta de quién por
  parámetro.
- Se borran con la cuenta (`onDelete: Cascade`).

## Los secretos

- La API Key, el insttoken y los tokens **nunca** viajan en la URL, aunque la API
  de Elsevier lo permita: una URL acaba en el registro de acceso del proxy, en el
  historial y en cualquier informe de error. Van en cabeceras.
- Los tokens se cifran con AES-256-GCM (`shared/utils/secretos.js`) antes de tocar
  la base, con `SECRETS_KEY`.
- Al frontend no llega ningún secreto, ni enmascarado. `GET /estado` devuelve
  `disponible`, `conOauth`, `conResumenes`, `conectado`, `cuenta`, `importadas`,
  `ultimaBusqueda` y `error`. Nada más.
- No se guarda nada en `localStorage`. La única cosa que el navegador retiene es
  la cookie `scopus_oauth` con el `state`, httpOnly, media hora, acotada a
  `/api/v1/mi-scopus`.
- El registro anota el estado HTTP y el mensaje de Elsevier; nunca el cuerpo de un
  canje de tokens.

## Lo que NO se hizo, a propósito

- **Sincronización nocturna de búsquedas guardadas.** Primero conectar → buscar →
  seleccionar → importar, que es lo que se pidió. Lo demás viene después.
- **Scraping.** Nada que no esté en el WADL oficial se pide.
- **Pedirle su contraseña de Scopus.** Ni su usuario, ni una clave de API suya.
- **Tocar Zotero, la autenticación, el conector, los capítulos, el corpus de la
  casa, la importación RIS/CSV/BibTeX ni los permisos.**

## Cuotas, para cuando se encienda

La clave tiene **cuota semanal** por API (Scopus Search ronda las decenas de miles
de peticiones, y Elsevier la sube si se le pide con el caso de uso). No es como
OpenAlex, que se recupera a medianoche: aquí quien pagine sin mirar deja sin
buscador a los demás **durante días**. Por eso `scopusBuscarLimiter` cuenta treinta
cada diez minutos **por persona**, y la página es de 25 —el techo de la vista
COMPLETE—. La API rechaza además desplazamientos de 5.000 en adelante, y eso se le
dice al tesista antes de pedirlo.
