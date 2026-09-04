# Conector MCP — cómo funciona y cómo se amplía

Guía corta para trabajar sobre el conector sin romper las protecciones.

## Qué es

Un servidor MCP que el comprador añade a su Claude como conector personalizado,
pegando una URL con su token dentro:

```
https://<tu-dominio>/mcp/<token>
```

Claude llama a ese endpoint **desde la infraestructura de Anthropic**, no desde
el equipo del comprador. Dos consecuencias que condicionan todo:

1. El servidor tiene que ser alcanzable por internet y servirse por **HTTPS**.
   `localhost` no vale ni para probar con Claude.
2. **La IP no identifica a nadie.** Todas las llamadas llegan del rango
   `160.79.104.0/21`. Cualquier control basado en «ubicaciones distintas» daría
   siempre uno. Por eso la detección de licencias compartidas mira volumen,
   sesiones solapadas e incoherencia entre consultas, y no IPs.

## Recorrido de una llamada

```
POST /mcp/<token>
  ↓  mcp.router.js       valida la licencia (existe, activa, no caducada, cuenta viva)
  ↓  mcp.tools.js        construye el servidor MCP con esa licencia dentro
  ↓  license.guard.js    ¿es un intento de sacar las instrucciones? → se rechaza
  ↓  license.limits.js   ¿le queda cupo del día, del mes y de gasto? → si no, se corta
  ↓  la herramienta      hace el trabajo y devuelve SOLO el resultado
  ↓  license.service     registra el uso, suma el coste y despierta la vigilancia
```

El servidor MCP se crea **por petición** y muere con ella, con la licencia
cerrada dentro de las herramientas. No hay estado compartido entre compradores.

## Reglas al añadir una herramienta nueva

**1. Nunca devuelvas el método, solo el resultado.**
Si una herramienta devolviera las instrucciones, aterrizarían en el chat del
comprador y ahí las puede leer. El contenido operativo vive en el servidor y en
la Skills API de Anthropic; por el conector sale el capítulo redactado, nunca
cómo se redacta.

**2. Todo lo que escribas en la herramienta es público.**
`tools/list` devuelve el nombre, el título, la descripción y el esquema de cada
herramienta. Claude los muestra al usuario y los tiene en contexto, así que
puede repetirlos si se los piden. Describe **qué hace y qué necesita**, jamás
cómo lo hace.

**3. Esquemas en JSON Schema, no en Zod.**
El SDK de MCP solo convierte esquemas de Zod 4.2 en adelante, y este backend
valida con Zod 3. Usa `fromJsonSchema({...})` como en `mcp.tools.js`. Si te
olvidas, `tools/call` funcionará pero `tools/list` fallará, y Claude verá un
conector sin herramientas.

**4. Pasa por el mismo embudo.**
Una herramienta que llama al modelo tiene que:

```js
// 1. filtrar la intención
const intencion = analizarIntencion(mensaje);
if (intencion.sospechoso) { /* registrar EXTRACTION_ATTEMPT y rechazar */ }

// 2. comprobar el cupo ANTES de gastar tokens
const cupo = await licenseService.checkLimits(licencia);
if (!cupo.permitido) { /* registrar BLOCKED_LIMIT y avisar */ }

// 3. registrar el uso con su coste real
await licenseService.recordUsage({
  licenseId: licencia.id,
  tool: 'mi_herramienta',
  prompt: mensaje,
  sessionId: sesion,
  costCents,            // lo que costó de verdad
  cuentaParaElTope: true, // solo las que llaman al modelo
});
```

Las herramientas baratas (catálogo, estado) se registran igualmente —la
detección necesita ver todas las llamadas— pero con `cuentaParaElTope: false`,
que es el valor por defecto.

## Añadir una skill al catálogo

1. Deja el bundle `.skill` en la carpeta `skills/`.
2. Añádela al array `METODO` de `prisma/seed-skills.js` con su nombre visible y
   un resumen escrito para el comprador.
3. `npm run db:seed-skills`.
4. Súbela a la Skills API y guarda su identificador con
   `skillService.registerUpload(code, { anthropicSkillId, anthropicVersionId })`.

Hasta el paso 4 aparece en el catálogo como «aún no disponible», y `redactar` lo
dice en vez de fallar.

## Topes

Viven en el plan (`mcpCallsPerDay`, `mcpCallsPerMonth`, `mcpCostCentsPerMonth`) y
se **copian a la licencia al emitirla**: cambiar el plan mañana no altera lo que
compró alguien hoy.

El que protege el margen es el de **gasto**, no el de llamadas: cada consulta
carga una skill que puede pesar 30 000 tokens, y no todas pesan igual.

Los contadores se reinician solos comparando el sello de día y mes en hora de
Lima. No hay ningún proceso programado que mantener.

## Licencias compartidas

`license.detector.js` puntúa el uso; `license.watch.js` decide.

La regla tiene red a propósito: a la primera sospecha alta se **avisa** al
comprador por correo y queda anotada; solo si vuelve a saltar pasadas 12 horas se
revoca. Cortarle el acceso a un tesista en semana de sustentación por una
heurística cuesta más que dejar correr una reventa dos días, y el aviso resuelve
solo la mayoría de los casos.

Si el comprador pierde su URL o sospecha que se la copiaron, la regenera desde su
panel: la anterior deja de funcionar al instante.

## Lo que esto no resuelve

- **La extracción por acumulación.** Nadie va a pedir el prompt: va a pedir
  veinte capítulos y reconstruir el método desde las salidas. Contra eso solo
  está el tope de consultas.
- **El filtro ve texto lavado.** El mensaje que llega lo escribe el Claude del
  comprador, no el comprador. Sirve para dejar constancia de intentos burdos, no
  como defensa.
- **Compartir con moderación desde la misma red** se parece mucho a un uso
  normal. La señal que lo delata es el volumen frente al histórico del propio
  comprador, y por eso el histórico se guarda.
