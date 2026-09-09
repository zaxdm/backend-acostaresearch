# Bibliotecas propias — la vía cara, descartada

> **NO SE HIZO ASÍ, y conviene saber por qué antes de retomarlo.**
>
> Este documento diseñaba que cada comprador conectara su **Zotero por API**.
> Funciona, pero exige credenciales de terceros cifradas en reposo, una cola de
> sincronización, un marcador de versión por biblioteca y convivir con claves
> que el tesista puede revocar sin avisar.
>
> Lo que se implementó es otra cosa, mucho más corta: **sube su export de
> Scopus** —un archivo—. Sin credenciales, sin cola, sin claves. Vive en
> `scopus.parser.js`, `propias.service.js` y `propias.repository.js`, y está
> explicado en `fuentes-propias.md`.
>
> Lo de aquí sigue valiendo si algún día hace falta que la biblioteca del
> comprador se mantenga sola, sin que él vuelva a subir nada. Ese es el único
> caso en que compensa el coste. Y ojo: la parte del esquema ya no aplica —al
> final `zoteroKey` se hizo NULA en vez de cambiar su índice único, que resultó
> ser una migración bastante menor de la que aquí se anticipaba.

## El problema, dicho con precisión

La biblioteca de la casa cubre lo que se ha curado y nada más. Un tesista que
investiga algo que no está —y siempre habrá algo que no está— recibe «No hay
ninguna fuente sobre X» y se queda sin la mitad del producto justo en el momento
en que más lo necesita.

Conviene separar dos cosas que se confunden:

- **Cobertura**: que exista una fuente real sobre cualquier tema.
- **Curación**: que además lleve la nota que dice para qué sirve.

Dejar que el comprador conecte su biblioteca resuelve lo primero **solo para
quien ya tiene una biblioteca**, que no es la mayoría de los tesistas. Es una
mejora real, pero no es la que arregla la cobertura en general; esa es el
respaldo abierto (Crossref u OpenAlex), que es otro trabajo.

## Cómo queda la búsqueda

Tres tramos, en este orden y con la procedencia visible en la respuesta:

1. **La biblioteca del propio tesista.** Es su tema y las eligió él: mandan.
2. **El fondo de la casa**, filtrado por el `productCode` de su licencia, como hoy.
3. El respaldo abierto, si llega a existir, para el hueco que quede.

La distinción tiene que llegarle al asistente. Hoy `buscar_fuentes` ya prefiere
la nota al resumen porque «la nota la escribió Acosta»; con fuentes de tres
procedencias, la respuesta debe decir de cuál viene cada una. Si no, el
diferencial del producto —la curación— se diluye en una lista indistinguible.

## Lo que hay que cambiar

### 1. La identidad de una fuente deja de ser global

Hoy `Reference.zoteroKey` es `@unique` en toda la tabla. Dos bibliotecas
distintas pueden traer la misma clave de ítem, así que la de un comprador
pisaría la de otro, o la de la casa.

```
zoteroKey String @unique     →     @@unique([libraryId, zoteroKey])
```

`libraryId` identifica la biblioteca de origen: `users/12345`, `groups/6789`.
Para el fondo de la casa es el valor que ya calcula `env.zoteroLibrary`, así que
las filas que existen se migran con ese valor y no hay que resincronizar nada.

**Es una migración sobre datos vivos.** El orden importa: añadir la columna con
un valor por defecto, rellenarla, crear el índice compuesto, y solo entonces
retirar el único antiguo.

### 2. Cuatro operaciones dejan de valer

Todas las que hoy direccionan por `zoteroKey` a secas, en
`reference.repository.js`:

- `guardarLote` — el `ON DUPLICATE KEY UPDATE` cuelga del índice único, así que
  se arregla con el índice; hay que añadir `libraryId` a `COLUMNAS`.
- `escribirGrupos` — busca `zoteroKey: { in: claves }` sin acotar biblioteca.
- `aplicarNotas` — igual.
- `borrarPorClaves` — **el más peligroso**: un `deleteMany` por clave sin acotar
  borraría fuentes de otra biblioteca que compartan clave. Y ocurre en la fase de
  retiradas, en silencio.

### 3. Un marcador de versión por biblioteca

`ReferenceSync` es una fila única, la 1, con su `libraryVersion`. Zotero versiona
cada biblioteca por separado, así que el marcador pasa a ser uno por
`libraryId`. Sin esto, la primera sincronización de un comprador dejaría el
marcador de la casa apuntando a una versión que no es suya, y el siguiente
incremental de la casa se traería mal lo que cambió.

### 4. El cliente deja de leer del entorno

`zotero.client.js` toma la clave y la biblioteca de `env` en el ámbito del
módulo: en `cabeceras()` y en la URL que arma `pedir()`. Pasan a ser argumentos.
Es un cambio mecánico, pero toca todas las funciones del archivo.

### 5. La sincronización deja de ser una a la vez

El progreso vive en un objeto único del proceso (`trabajo`) y `sincronizar()`
rechaza con 409 si ya hay una en marcha. Hoy es correcto: solo sincroniza el
administrador. Con N compradores hace falta:

- estado por biblioteca, no uno global;
- una cola con concurrencia limitada, porque cada pasada son cientos de
  peticiones y el proceso es uno;
- y decidir qué pasa al reiniciar. Que el `trabajo` en memoria se pierda es hoy
  una decisión deliberada y sigue valiendo; lo que hay que resolver es si las
  pasadas encoladas también se pierden. Probablemente sí, y se vuelven a pedir.

La biblioteca de un tesista son cientos de ítems, no 24.000, así que cada pasada
es corta. El riesgo no es el tamaño: es la simultaneidad.

### 6. Credenciales de terceros, cifradas

Modelo nuevo, una fila por comprador: `libraryId`, la clave de API, cuándo se
conectó, cuándo se sincronizó por última vez y con qué resultado.

**La clave se guarda cifrada, no hasheada.** Es la diferencia con todo lo demás
que guarda este backend: un token de licencia se hashea porque solo hay que
compararlo, pero esta clave hay que **usarla** contra la API de Zotero, así que
tiene que poder recuperarse. Hoy no existe ningún ayudante de cifrado simétrico
en el proyecto —`shared/utils/tokens.js` solo firma, hashea y compara—, así que
hay que añadirlo: AES-256-GCM con una clave de entorno propia, **no derivada de
los secretos de JWT**. Rotar el secreto de JWT no puede dejar ilegibles las
credenciales de los compradores.

Y no vuelve nunca por la API. Al panel se le enseña que está conectada y a qué
biblioteca; la clave, jamás.

### 7. La herramienta deja de depender del entorno

En `mcp.tools.js`, `buscar_fuentes` se registra solo si `env.zoteroEnabled`. Con
bibliotecas propias, un comprador puede tener fuentes aunque la casa no tenga
corpus configurado. La condición pasa a mirar también si esa licencia tiene
biblioteca conectada.

### 8. Dónde lo conecta el comprador

En su perfil, junto al conector: es la misma clase de tarea, pegar unas
credenciales una vez y olvidarse. Necesita tres datos suyos: el tipo de
biblioteca (personal o de grupo), el identificador numérico y la clave.

## Los riesgos que hay que decidir antes, no después

**La clave tiene que ser de solo lectura y no hay forma de comprobarlo.** La API
de Zotero no dice qué permisos tiene una clave hasta que se intenta escribir con
ella. Si el tesista pega una con permiso de escritura, este servidor tendría
acceso de escritura a su biblioteca. No se va a usar —el cliente solo hace GET—
pero **tenerlo sin quererlo es un riesgo que se asume, no que se evita**. Hay que
decirlo en la pantalla y en la guía, con el paso exacto de no marcar la casilla.

**Material ajeno en tu tabla.** Hoy la regla es que el corpus no se publica: «al
comprador le llegan las fuentes por el conector, filtradas por la licencia que
pagó». Sincronizar bibliotecas ajenas mete en la misma tabla datos que no son
tuyos. Hace falta, como mínimo:

- que la búsqueda de un comprador **no pueda alcanzar** la biblioteca de otro. Es
  un filtro más en la consulta, y es el filtro que no puede fallar;
- que el panel del administrador no las liste junto a las de la casa;
- que se borren con la cuenta;
- y una línea en la política de privacidad que lo diga.

**Una clave que caduca o se revoca.** El tesista puede borrar su clave en Zotero
cuando quiera. La sincronización empezará a dar 403, y eso hay que avisárselo, no
reintentarlo en silencio para siempre.

**Fricción.** Ir a `zotero.org/settings/keys`, crear una clave sin permiso de
escritura y copiar el userID es del tamaño de instalar el conector. Ya hay guía
en PDF para eso, así que el sitio donde explicarlo ya existe.

## Lo que NO hay que hacer

**No reutilizar la clave de la casa para leer bibliotecas ajenas.** Aunque la del
tesista fuera pública, leerla con la clave de la casa mete el tráfico de todos
los compradores bajo una sola cuenta, y Zotero limita por cuenta: uno con una
biblioteca grande dejaría sin sincronizar a los demás. Con la clave de cada uno,
cada quien gasta su propio cupo.

**No sincronizar en la primera llamada del conector.** Es tentador —«si no tiene
fuentes, tráelas ahora»— y convierte una consulta de tres segundos en una de
varios minutos, dentro de una petición que Claude va a cortar por tiempo. La
sincronización se pide desde el panel y va por su cola.

## Orden sugerido

1. Migración del esquema y las cuatro operaciones por clave. Sin esto no se puede
   probar nada, y es lo único que toca datos que ya existen.
2. Cliente con credenciales por argumento, y marcador por biblioteca.
3. Modelo de credenciales y el cifrado.
4. Cola de sincronización.
5. La pantalla del comprador y la guía.
6. Los tres tramos en `buscar_fuentes`, con la procedencia visible.

Los pasos 1 y 2 no cambian ningún comportamiento visible: al terminarlos, todo
sigue funcionando igual que hoy con una sola biblioteca. Es el punto donde
conviene parar y comprobar antes de seguir.
