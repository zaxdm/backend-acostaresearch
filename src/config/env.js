'use strict';

const path = require('node:path');
const dotenv = require('dotenv');
const { z } = require('zod');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const booleanish = z
  .enum(['true', 'false'])
  .transform((value) => value === 'true');

/** Trata la cadena vacía como "no configurado", que es lo que significa en un .env. */
const vacioComoAusente = (esquema) =>
  z
    .union([esquema, z.literal('')])
    .optional()
    .transform((valor) => valor || undefined);

/** `pk_test_…` con `sk_test_…`, o `pk_live_…` con `sk_live_…`. */
function llavesCulqiValidas(publica, secreta) {
  const entorno = (llave, prefijo) => new RegExp(`^${prefijo}_(test|live)_\\S+$`).exec(llave ?? '')?.[1];
  const dePublica = entorno(publica, 'pk');
  return Boolean(dePublica) && dePublica === entorno(secreta, 'sk');
}

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  API_PREFIX: z.string().startsWith('/').default('/api/v1'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  DATABASE_URL: z.string().min(1, 'DATABASE_URL es obligatorio'),

  CORS_ORIGIN: z.string().default('http://localhost:4200'),
  // Lo manda el Worker de la web junto a la IP real del visitante (ver
  // `shared/utils/ipCliente`). Sin él, la web entera cuenta con la IP de Cloudflare.
  PROXY_SECRET: vacioComoAusente(z.string().min(32, 'PROXY_SECRET debe tener al menos 32 caracteres')),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET debe tener al menos 32 caracteres'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET debe tener al menos 32 caracteres'),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  JWT_ISSUER: z.string().default('acostaresearch-api'),
  JWT_AUDIENCE: z.string().default('acostaresearch-web'),

  COOKIE_DOMAIN: z.string().optional(),
  COOKIE_SECURE: booleanish.default('false'),

  EMAIL_VERIFICATION_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  APP_URL: z.string().url().default('http://localhost:4200'),

  // SMTP. Sin host o sin contraseña, los correos se escriben en el log en vez
  // de enviarse: un valor en blanco desactiva el envío, no rompe el arranque.
  SMTP_HOST: vacioComoAusente(z.string()),
  SMTP_PORT: z.coerce.number().int().positive().default(587),
  SMTP_SECURE: booleanish.default('false'),
  SMTP_USER: vacioComoAusente(z.string()),
  SMTP_PASS: vacioComoAusente(z.string()),
  // Remitente. Tiene que estar dado de alta y validado como «sender» en Brevo,
  // y conviene que sea del dominio propio: un @gmail.com de remitente no puede
  // pasar la alineación de DMARC —Brevo firma con SU dominio, no con el de
  // Google— y acaba en spam aunque el correo salga sin errores.
  MAIL_FROM: z.string().default('no-responder@acostaresearch.com'),
  // Enlace de contacto que aparece en el pie de los correos. Vacío = no se
  // muestra: es preferible callar a ofrecer una vía que no atiende nadie.
  SUPPORT_WHATSAPP_URL: vacioComoAusente(z.string().url()),
  // A dónde responde el tesista. Vacío = responde al remitente.
  // Sirve para poner un buzón que sí se lee sin sacrificar la entrega.
  MAIL_REPLY_TO: vacioComoAusente(z.string().email()),

  // ── Reescritor académico (Claude) ───────────────────────────────────────
  ANTHROPIC_API_KEY: vacioComoAusente(z.string()),
  // El modelo por defecto es el más capaz: la calidad del texto ES el producto.
  REWRITE_MODEL: z.string().default('claude-opus-5'),
  // Primer freno de coste si hace falta: 'medium' suele mantener la calidad.
  REWRITE_EFFORT: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
  // Techo por envío: evita respuestas truncadas y facturas sorpresa.
  REWRITE_MAX_WORDS_PER_REQUEST: z.coerce.number().int().positive().default(3000),
  // Plan que se regala al crear la cuenta. Vacío = sin prueba gratuita.
  TRIAL_PLAN_CODE: z.string().default('PRUEBA'),

  // Modo simulado del conector: responde sin llamar a Anthropic, con cifras de
  // consumo verosímiles. Sirve para probar la conversación, el cupo y el coste
  // sin gastar. NUNCA en producción: el arranque lo impide.
  SKILLS_SIMULADAS: booleanish.default('false'),

  // ── Asistente Acosta (Gemini) ───────────────────────────────────────────
  // El chat de la web. Clave en https://aistudio.google.com/apikey, EN UN
  // PROYECTO CON FACTURACIÓN: en el nivel gratuito Google puede usar lo que
  // escriben los visitantes para mejorar sus modelos, y eso contradice lo que
  // les decimos. Vacía = el panel no aparece en la web.
  GEMINI_API_KEY: vacioComoAusente(z.string()),
  // Flash-Lite y no Flash ni Pro: responde preguntas de una ficha, y la espera se
  // nota más que la diferencia de calidad. Medido el 13 de septiembre de 2026 con
  // el mismo prompt: 2 s con respuestas más ceñidas, frente a 25 s de Flash.
  //
  // Desde el 21-sep-2026, 3.1 y no 3.5: medidos ese día con la instrucción del
  // copiloto y siete temas, 3.5 falló en cuatro (tiempo agotado o «high
  // demand») y tardó de 13 a 20 s en los otros; 3.1 contestó seis de siete en
  // uno a cuatro segundos. 3.5 queda de último recurso.
  GEMINI_MODEL: z.string().default('gemini-3.1-flash-lite'),
  // Al que se pasa si el principal falla, tarda o está saturado. Mejor de otra
  // generación: cuando uno se satura, los de su misma familia suelen ir igual.
  // Vacío = sin respaldo.
  GEMINI_MODEL_RESPALDO: vacioComoAusente(z.string()).default('gemini-3.5-flash-lite'),
  GEMINI_THINKING: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
  // Groq: un tercer modelo de OTRA empresa para cuando Gemini se satura. El
  // 21-sep-2026 los dos Gemini tardaban de 15 a 40 s a la vez; medido ese día
  // con la instrucción del copiloto, gpt-oss-120b en Groq contestaba en 0,4 s
  // con los mismos conceptos. Qwen, en cambio, se inventó sinónimos. Sin clave
  // = sin tercer modelo.
  GROQ_API_KEY: vacioComoAusente(z.string()),
  GROQ_MODEL: z.string().default('openai/gpt-oss-120b'),
  // NVIDIA NIM: un cuarto corredor, de otra empresa más. Clave gratuita en
  // https://build.nvidia.com (programa de desarrolladores), 40 peticiones por
  // minuto y 10.000 al día, que es el tier gratuito más ancho de los que no
  // prohíben el uso comercial. Habla el dialecto de OpenAI, como Groq. Sin
  // clave = no entra en la carrera.
  NVIDIA_API_KEY: vacioComoAusente(z.string()),
  // glm-5.3 y NO gpt-oss-120b, aunque sea el que usa Groq: NVIDIA lo retiró el
  // 3-sep-2026 y devuelve 410 Gone. Probados los dos el 23-sep-2026 contra el
  // endpoint real con la clave de la casa: glm-5.3 contestó en 6 s con un
  // prompt de mil tokens (una de cada tres vueltas, 16 s) y el JSON le sale
  // bien; nemotron-3.5-lightning tardó 82 s la primera vez y 13 s la mejor,
  // razonando sobre «di solo: listo». No sirve para un chat.
  NVIDIA_MODEL: z.string().default('z-ai/glm-5.3'),
  // OVHcloud: el ÚLTIMO recurso, para cuando no contesta nadie más. No lleva
  // clave —es anónimo— y por eso cuenta 2 peticiones por minuto POR IP: la IP
  // es la del servidor entero, así que no aguanta a dos personas a la vez. Está
  // aquí porque es europeo y porque sin clave no hay nada que caducar. Vacío =
  // fuera.
  OVH_MODEL: vacioComoAusente(z.string()),
  // El de los vectores con los que la búsqueda semántica de Scopus ordena por
  // significado. Probado en el servidor el 19-sep-2026: los 002 y
  // text-embedding-004 ya dan 404.
  GEMINI_EMBEDDING_MODEL: z.string().default('gemini-embedding-001'),
  // Mensajes al día para todo el sitio, contados en memoria. 0 = sin tope.
  ASISTENTE_MAX_DIARIO: z.coerce.number().int().nonnegative().default(1500),

  // ── Preparar documento ──────────────────────────────────────────────────
  // Edición de inglés académico y traducción. Usa la misma clave de
  // Gemini que el asistente; sin ella el servicio no se ofrece.
  //
  // Aquí SÍ el modelo bueno, al revés que en el chat. Allí se contesta una
  // pregunta de una ficha y la espera se nota más que la calidad; aquí se
  // entrega un Word por el que alguien pagó, no lo mira un humano después y no
  // hay a quién reclamarle una frase mal traducida. Un documento de 25.000
  // palabras cuesta unos S/ 0,64 con este modelo: a diez documentos al mes,
  // menos de un tercio de lo que paga la membresía mensual.
  // Dónde viven los .docx. Vacío = al lado de los comprobantes, igual que los
  // capítulos y los pedidos, para que el respaldo diario ya los recoja.
  PREPARAR_DIR: vacioComoAusente(z.string()),
  // Su PROPIA clave de Gemini, distinta de la del asistente. Vacío = comparte
  // la de arriba, como hasta el 23-sep-2026.
  //
  // La cuota de Google se cuenta por clave, no por servicio: con una sola, el
  // chat de la web —gratis, y que cualquiera puede usar mil veces— se come las
  // peticiones que necesita el documento de quien pagó la membresía. El
  // 23-sep-2026 la clave de la casa daba 429 en todos los modelos y con ella
  // caían los dos. Separadas, el chat puede agotarse sin llevarse por delante
  // una entrega.
  PREPARAR_GEMINI_API_KEY: vacioComoAusente(z.string()),
  PREPARAR_MODELO: z.string().default('gemini-3.8-flash'),
  // Admite VARIOS separados por comas, y se prueban en ese orden. Los de otra
  // casa (groq:… , nvidia:…) los últimos y a propósito: son planes gratuitos
  // que se guardan lo que se les manda, y lo que sale de aquí es la tesis
  // inédita de quien pagó. Solo se llega a ellos cuando Google no contesta.
  PREPARAR_MODELO_RESPALDO: vacioComoAusente(z.string()).default('gemini-3.5-flash'),
  // Cuánto se le deja pensar aquí. `auto` = no se le dice nada y decide él.
  //
  // Y `auto` por defecto porque `minimal` —lo que mandaba el código para todo
  // el mundo, pensando en el chat— NO lo acepta `gemini-3.8-flash`: contesta
  // «Thinking level MINIMAL is not supported for this model» con un 400, que no
  // se arregla esperando. Comprobado contra la API el 23-sep-2026: con el nivel
  // quitado, el mismo modelo y la misma clave contestan. El fallo no se veía
  // porque el respaldo recogía todas las tandas, así que el modelo bueno que se
  // eligió a propósito no había llegado a traducir nunca una línea.
  PREPARAR_THINKING: z.enum(['auto', 'minimal', 'low', 'medium', 'high']).default('auto'),
  // Palabras por tanda. Más grande = menos llamadas y más contexto para que el
  // modelo mantenga el mismo registro, pero también más que rehacer si una
  // tanda sale mal y más riesgo de que la respuesta se corte.
  PREPARAR_PALABRAS_POR_TANDA: z.coerce.number().int().positive().default(900),
  // Cuántas tandas a la vez. El proceso es UNO y lo comparten todos los
  // clientes: con veinte en paralelo, el conector y la web se quedan esperando.
  PREPARAR_TANDAS_A_LA_VEZ: z.coerce.number().int().positive().default(3),
  // Tope técnico, no comercial: la membresía es de tamaño libre. Es lo que
  // evita que un documento de 200.000 palabras se lleve media hora de proceso
  // y el presupuesto de Gemini de un día.
  PREPARAR_MAX_PALABRAS: z.coerce.number().int().positive().default(60000),

  // ── Acceso con Google ───────────────────────────────────────────────────
  // Client ID de la app OAuth (console.cloud.google.com → Credenciales). Es
  // público por diseño: viaja en el HTML y Google comprueba el origen. Vacío =
  // no se ofrece el botón y solo queda el acceso con contraseña.
  // Admite varios separados por comas: es normal tener un cliente OAuth para
  // desarrollo y otro para el dominio real. El token solo se acepta si su
  // `aud` es uno de estos, así que la lista no afloja nada — cada entrada
  // sigue siendo un cliente nuestro.
  GOOGLE_CLIENT_ID: vacioComoAusente(z.string()),

  // ── Pasarela de pago (PayPal) ───────────────────────────────────────────
  // Sin credenciales, el módulo responde 503 y la venta sigue siendo manual.
  PAYPAL_ENV: z.enum(['sandbox', 'live']).default('sandbox'),
  PAYPAL_CLIENT_ID: vacioComoAusente(z.string()),
  PAYPAL_CLIENT_SECRET: vacioComoAusente(z.string()),

  // ── Pasarela de pago (Culqi) ────────────────────────────────────────────
  // Tarjeta y Yape en soles, con el cobro confirmado al momento. Llaves del
  // panel de Culqi: la pública (pk_…) viaja al navegador para abrir el
  // formulario; la secreta (sk_…) no sale nunca de este servidor. No hay
  // variable de entorno aparte: el prefijo `_test_` o `_live_` de la llave ya
  // dice si el cobro es de prueba o real, y la API es la misma.
  //
  // Sin regex a propósito: una llave mal pegada aquí tumbaría el arranque de
  // todo el servidor. Si no tienen buena forma, `culqiEnabled` queda en false
  // y Culqi simplemente no se ofrece.
  CULQI_PUBLIC_KEY: vacioComoAusente(z.string().trim()),
  CULQI_SECRET_KEY: vacioComoAusente(z.string().trim()),

  // ── Pago manual (Yape o transferencia) ──────────────────────────────────
  // El comprador paga con el QR y sube la captura; un administrador la mira y
  // activa el acceso. Es la vía principal en Perú, donde PayPal es minoritario.
  // Vacíos = no se muestran los datos del titular junto al QR, solo el QR.
  YAPE_TITULAR: vacioComoAusente(z.string()),
  YAPE_NUMERO: vacioComoAusente(z.string()),
  // A quién le llega el aviso de que hay un comprobante esperando. Si se deja
  // vacío se busca en la base de datos el primer administrador activo, para
  // que el aviso no se pierda por un .env sin rellenar.
  ADMIN_NOTIFY_EMAIL: vacioComoAusente(z.string().email()),
  // Aviso al móvil cuando entra un comprobante. El correo llega igual; esto es
  // para enterarse sin abrir el correo, que es lo que acorta la espera del
  // comprador.
  //
  // Sin `NTFY_TOPIC` no se llama a ningún servidor: el aviso se queda en el
  // log, que es justo lo que hace falta en desarrollo.
  //
  // El tópico ES la credencial: en el plan gratuito de ntfy cualquiera que
  // acierte el nombre puede leer lo que se publique en él. Por eso se genera
  // largo y aleatorio, y por eso el aviso no lleva datos del comprador.
  NTFY_URL: z.string().url().default('https://ntfy.sh'),
  NTFY_TOPIC: vacioComoAusente(z.string()),
  // Solo si el tópico está reservado con una cuenta de pago. Con uno público
  // sobra.
  NTFY_TOKEN: vacioComoAusente(z.string()),
  // Carpeta de los comprobantes. Como la de skills, tiene que ser persistente:
  // son la prueba de un cobro y hay que poder releerlos meses después.
  PROOFS_DIR: z.string().default(path.resolve(__dirname, '../../storage/comprobantes')),

  // ── Los capítulos escritos ──────────────────────────────────────────────
  // Dónde se guarda el texto de la tesis de cada comprador.
  //
  // EN DISCO Y NO EN LA BASE DE DATOS, y no es una preferencia. La base va por
  // el plan Dev de un proveedor compartido y ya pesa 171 MB, de los cuales 170
  // son el corpus bibliográfico. Una tesis completa ronda el medio mega; dos
  // centenares de tesistas serían cien megas más, encima de una base que ya
  // está donde está. En disco hay 34 GB libres.
  //
  // Vacío = al lado de los comprobantes, que en producción es
  // /var/lib/acostaresearch. Eso lo mete en el respaldo diario sin tener que
  // acordarse de nada.
  CAPITULOS_DIR: vacioComoAusente(z.string()),

  // ── Pedidos de revisión ─────────────────────────────────────────────────
  // El Word que sube el tesista para que se lo observen. Mismo criterio que los
  // capítulos: vacío = al lado de los comprobantes, que en producción es
  // /var/lib/acostaresearch, así entra en el respaldo diario sin acordarse de
  // nada y un despliegue no puede llevárselo por delante.
  PEDIDOS_DIR: vacioComoAusente(z.string()),
  // Techo del documento. Una tesis con figuras incrustadas ronda los 10 MB; 25
  // deja margen sin abrir la puerta a que alguien use esto de alojamiento.
  PEDIDO_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // Quién ve la revisión con asesor dentro de su panel. Una lista de correos
  // separados por coma. Vacía = no la ve nadie, que es lo que tiene que pasar
  // donde no se haya encendido a propósito. Ver `modules/pedidos/beta`.
  BETA_REVISION_EMAILS: z.string().default(''),
  // ¿Avisan al móvil las cosas del piloto de revisión? Apagado mientras se
  // prueba: las pruebas de uno mismo no son noticias, y un tópico lleno de
  // avisos que no hay que atender enseña a no mirarlos. Se enciende poniendo
  // `true` aquí y reiniciando, sin desplegar nada.
  AVISOS_REVISION: booleanish.default('false'),

  // ── Guía de instalación ─────────────────────────────────────────────────
  // Dónde está el PDF que se le enlaza al comprador, y con qué dirección se le
  // enlaza.
  //
  // La sirve este backend y no la web por una razón práctica: la web se publica
  // en Netlify, y Netlify puede quedarse sin poder desplegar —por créditos, por
  // un build roto, por lo que sea— justo cuando hace falta cambiar el PDF. El
  // correo de compra sale de aquí, así que la guía que ese correo enlaza vive
  // aquí también: una cosa menos que dependa de un tercero.
  //
  // La carpeta va fuera del directorio del código, como skills y comprobantes,
  // para que un despliegue no se la lleve por delante.
  GUIAS_DIR: z.string().default(path.resolve(__dirname, '../../storage/guias')),
  // Dirección pública de la guía. Vacía = se enlaza la copia de la web.
  GUIA_URL: vacioComoAusente(z.string().url()),
  // Techo de la captura. Una foto de pantalla de móvil no pasa de 2-3 MB.
  PROOF_MAX_BYTES: z.coerce.number().int().positive().default(6 * 1024 * 1024),

  // ── Videos de las reseñas ───────────────────────────────────────────────
  // Vacío = al lado de los comprobantes, como los capítulos: así entra en el
  // respaldo diario y un despliegue no puede llevárselo por delante.
  RESENAS_DIR: vacioComoAusente(z.string()),
  // Techo del video. Un testimonio grabado con el móvil de un minuto ronda los
  // 40 MB; 80 deja aire para dos minutos sin que esto se vuelva alojamiento de
  // video. Lo que pase de aquí se rechaza con un mensaje, no a medias.
  RESENA_VIDEO_MAX_BYTES: z.coerce.number().int().positive().default(80 * 1024 * 1024),

  // Techo del export bibliográfico que sube un comprador. Un CSV de Scopus con
  // resúmenes ronda los tres kilobytes por fuente, así que ocho megas cubren de
  // sobra las mil largas que caben en el tope por usuario.
  IMPORT_MAX_BYTES: z.coerce.number().int().positive().default(8 * 1024 * 1024),

  // ── Conector MCP (licencias) ────────────────────────────────────────────
  // Base pública de la URL que el comprador pega en Claude. Tiene que ser
  // HTTPS y estar accesible desde internet: Claude llama desde la nube de
  // Anthropic, no desde el equipo del comprador.
  MCP_PUBLIC_URL: z.string().default('http://localhost:3000/mcp'),
  // Producto por defecto al generar códigos de activación.
  LICENSE_PRODUCT_CODE: z.string().default('METODO_9_SKILLS'),
  // Días de vigencia de una licencia nueva. 0 = sin caducidad.
  LICENSE_DURATION_DAYS: z.coerce.number().int().nonnegative().default(0),

  // Carpeta donde viven los bundles (.skill) que sirve el conector. Es la que
  // escribe el panel al subir una skill, así que tiene que ser persistente:
  // en un hosting con disco efímero hay que montarle un volumen.
  SKILLS_DIR: z.string().default(path.resolve(__dirname, '../../../skills')),
  // Techo del .skill que se acepta por el panel. Los del método rondan los
  // 60 KB; el margen es para bundles con muchos materiales de apoyo.
  SKILLS_MAX_BYTES: z.coerce.number().int().positive().default(15 * 1024 * 1024),

  // ── Corpus bibliográfico (Zotero) ───────────────────────────────────────
  // La biblioteca se cura en Zotero y este servidor la espeja. La clave TIENE
  // QUE SER DE SOLO LECTURA: se crea en zotero.org/settings/keys sin marcar
  // «Allow write access». Así, aunque se filtrara entera, nadie puede borrar
  // ni modificar el corpus; y como el conector no expone ninguna herramienta
  // de escritura, tampoco hay por dónde intentarlo.
  //
  // Vacía = la sincronización y la búsqueda de fuentes quedan apagadas, sin
  // romper nada: el conector sigue sirviendo capítulos como hasta ahora.
  ZOTERO_API_KEY: vacioComoAusente(z.string()),
  // El identificador numérico de la cuenta, no el nombre de usuario.
  ZOTERO_USER_ID: vacioComoAusente(z.string().regex(/^[0-9]+$/, 'ZOTERO_USER_ID es numérico')),
  // Biblioteca de grupo, si el corpus vive en una en vez de en la personal.
  // Con valor, manda sobre ZOTERO_USER_ID.
  ZOTERO_GROUP_ID: vacioComoAusente(z.string().regex(/^[0-9]+$/, 'ZOTERO_GROUP_ID es numérico')),

  // ── El Zotero de cada tesista (OAuth) ───────────────────────────────────
  // Lo de arriba es LA BIBLIOTECA DE LA CASA, con una sola clave que es tuya.
  // Esto es otra cosa: cada comprador conecta la SUYA, y la clave la emite
  // Zotero a su nombre cuando él autoriza.
  //
  // Se registra una vez en zotero.org/oauth/apps y de ahí salen estas dos.
  // Vacías = la conexión no se ofrece y sus rutas no se montan: una función a
  // medio conectar enseña a desconfiar del resto.
  ZOTERO_OAUTH_CLIENT_KEY: vacioComoAusente(z.string()),
  ZOTERO_OAUTH_CLIENT_SECRET: vacioComoAusente(z.string()),

  // ── El Mendeley de cada tesista (OAuth 2) ───────────────────────────────
  // Se registra una vez en dev.mendeley.com/myapps.html: de ahí salen el id de
  // la aplicación y su secreto, y allí se escribe la dirección de vuelta, que
  // Mendeley compara carácter por carácter. Por defecto es
  // `${APP_URL}/api/v1/mi-mendeley/vuelta`; si la registrada es otra, va aquí.
  //
  // Vacías = la conexión no se ofrece, igual que Zotero.
  MENDELEY_CLIENT_ID: vacioComoAusente(z.string()),
  MENDELEY_CLIENT_SECRET: vacioComoAusente(z.string()),
  MENDELEY_REDIRECT_URI: vacioComoAusente(z.string().url()),


  // ── Scopus por API (Elsevier) ───────────────────────────────────────────
  // ESTO ESTÁ APAGADO POR DEFECTO, Y NO ES PRUDENCIA DE MÁS.
  //
  // El Acuerdo de Servicio de la API de Elsevier dice que la licencia se rige
  // por «the agreement between Elsevier and Your institution, company or
  // organization», y prohíbe expresamente dos cosas que este producto haría:
  // «substantially or systematically reproduce, retain, store locally» el
  // contenido, y «share with and/or enable a third party access to the
  // Elsevier content». Guardar fichas de Scopus en la biblioteca de cada
  // comprador de un producto que se vende es justo eso.
  //
  // Registrar la clave en dev.elsevier.com es gratis y no arregla nada de lo
  // anterior: da acceso técnico, no permiso. Por eso hace falta encender esto
  // A MANO, y solo cuando exista por escrito el acuerdo con Elsevier que lo
  // ampare. Mientras esté en false, las rutas contestan que no está disponible
  // y la web no ofrece el botón: la subida de exports sigue igual que siempre,
  // que es la vía que no depende de nadie.
  SCOPUS_API_ENABLED: booleanish.default('false'),

  // La clave de dev.elsevier.com. Va en la cabecera `X-ELS-APIKey` y NUNCA
  // sale de este servidor: ni al navegador, ni en una URL, ni en un log.
  ELSEVIER_API_KEY: vacioComoAusente(z.string()),

  // El token institucional, si Elsevier lo emite para esta clave.
  //
  // Sin él, la clave se autentica POR LA IP desde la que sale la petición, y
  // la de este servidor no pertenece a ninguna universidad suscrita: lo que
  // vuelve es la vista STANDARD, que NO TRAE RESUMEN. Y una ficha sin resumen
  // se puede citar pero no se puede encontrar — es el mismo problema que ya
  // avisa la web cuando alguien exporta sin marcar «Abstract & keywords».
  //
  // Lo pide la biblioteca de una institución suscrita a Elsevier, indicando la
  // clave. Elsevier lo puede revocar en cualquier momento y sin avisar.
  ELSEVIER_INSTTOKEN: vacioComoAusente(z.string()),

  // ── OAuth de Elsevier ───────────────────────────────────────────────────
  // Los endpoints van en el `.env` y no escritos en el código A PROPÓSITO.
  //
  // Elsevier dice en su documentación de autenticación que ofrece «an oauth
  // implementation for developers wanting to integrate ScienceDirect and/or
  // Scopus content into client-side applications requiring access to user
  // level content», pero NO PUBLICA los endpoints, ni los scopes, ni cómo se
  // registra un client_id: el portal solo emite API Keys. Se consigue
  // escribiendo a apisupport@elsevier.com.
  //
  // Escribir aquí una URL adivinada sería peor que no tenerla: el día que
  // Elsevier conteste, alguien tendría que descubrir que el valor de verdad
  // estaba enterrado en un archivo y no en la configuración. Con esto vacío,
  // el botón conecta por el modo de clave compartida; rellenándolo, y sin
  // tocar una línea, pasa a ser el OAuth del propio tesista.
  ELSEVIER_CLIENT_ID: vacioComoAusente(z.string()),
  ELSEVIER_CLIENT_SECRET: vacioComoAusente(z.string()),
  // A dónde devuelve Elsevier al tesista. Tiene que coincidir carácter por
  // carácter con la que quede registrada en Elsevier. Vacío = se arma sola
  // sobre APP_URL, que es lo correcto salvo que Elsevier exija otra.
  ELSEVIER_REDIRECT_URI: vacioComoAusente(z.string().url()),
  // La pantalla de autorización y el canje del código. Los da Elsevier.
  ELSEVIER_AUTH_URL: vacioComoAusente(z.string().url()),
  ELSEVIER_TOKEN_URL: vacioComoAusente(z.string().url()),
  // Los permisos que se piden, separados por espacios. Los da Elsevier.
  ELSEVIER_SCOPE: vacioComoAusente(z.string()),

  // ── La llave con la que se guardan secretos de otros ────────────────────
  // 32 bytes en hexadecimal o en base64: «openssl rand -base64 32».
  //
  // Con ella se cifran las claves de Zotero de los tesistas antes de tocar la
  // base. Si se pierde, esas claves quedan ilegibles y hay que volver a
  // conectar — que es molesto pero no destruye nada: las fuentes ya importadas
  // siguen donde están. Si se filtra JUNTO con un volcado de la base, quedan
  // legibles las claves de todos, así que no vive en el repositorio ni en el
  // respaldo: solo en el `.env` del servidor.
  SECRETS_KEY: vacioComoAusente(z.string()),

  // ── Búsqueda abierta en OpenAlex ────────────────────────────────────────
  // El correo con el que se identifica el conector al buscar. No es cortesía:
  // sin él, OpenAlex atiende por la cola lenta y una búsqueda tarda lo bastante
  // como para que el tesista crea que el conector se colgó.
  //
  // Vacío = se usa MAIL_FROM, que ya es una dirección nuestra y real.
  OPENALEX_MAILTO: vacioComoAusente(z.string()),

  // La clave gratuita de openalex.org. Sin ella el presupuesto es de diez
  // centavos al día por IP —unas cien búsquedas para todos los tesistas juntos—
  // y cuando se acaba el catálogo abierto deja de contestar hasta la medianoche
  // UTC. Con ella, un dólar al día.
  OPENALEX_API_KEY: vacioComoAusente(z.string()),

  // ── Unpaywall, el refuerzo del enlace abierto ───────────────────────────
  // Unpaywall exige un correo en cada petición, igual que OpenAlex. Se le
  // pregunta solo por los DOI que OpenAlex no conoce todavía —lo recién
  // depositado en repositorios, que es justo lo de este año— y como mucho por
  // diez en cada búsqueda: su API abierta no tiene consulta por lotes.
  //
  // Vacío = se usa OPENALEX_MAILTO, y si tampoco, MAIL_FROM. No hay clave que
  // pedir ni nada que registrar: el correo es todo lo que quieren.
  UNPAYWALL_MAILTO: vacioComoAusente(z.string()),

  // ── R en la conversación ────────────────────────────────────────────────
  // Claude corre el análisis del tesista con la herramienta «trabajar_en_r».
  //
  // Quién arranca R:
  //   · systemd — en el servidor, dentro de la jaula de infra/r/. Es lo que se
  //     usa en producción si no se dice otra cosa.
  //   · local   — Rscript a pelo, SOLO en desarrollo: sin jaula, el código que
  //     llegue por el conector correría con los permisos de este proceso. El
  //     arranque lo impide en producción.
  //   · apagado — la herramienta existe pero dice que no está disponible. Es lo
  //     de por defecto fuera de producción, para no depender de tener R.
  R_MOTOR: z.enum(['apagado', 'local', 'systemd']).optional(),
  // Una carpeta por proyecto. En producción la crea infra/r/instalar.sh con el
  // dueño y los permisos que la jaula espera; no se cambia sin cambiar la unidad.
  R_SESIONES_DIR: vacioComoAusente(z.string()),
  // Solo para el modo local. En Windows, la ruta entera a Rscript.exe.
  RSCRIPT: z.string().default('Rscript'),
  // Procesos de R a la vez en todo el servidor. Cuatro caben holgados en el
  // tope de 1,5 GB del slice con 400 MB cada uno.
  R_MAX_SIMULTANEAS: z.coerce.number().int().positive().default(4),
  // TIENE QUE COINCIDIR con TimeoutStartSec de infra/r/acostaresearch-r@.service:
  // con él se distingue «se acabó el tiempo» de «se quedó sin memoria».
  R_LIMITE_SEGUNDOS: z.coerce.number().int().positive().default(45),
  // Una matriz de tesis con cientos de encuestados no llega a un mega.
  R_SUBIDA_MAX_BYTES: z.coerce.number().int().positive().default(5 * 1024 * 1024),
  // El exporte de Scopus o WoS para bibliometrix, con resúmenes y referencias:
  // unos 10 KB por documento, así que 2000 documentos rondan los 20 MB. Solo
  // vale para un exporte bibliográfico; una matriz sigue con el tope de arriba.
  R_SUBIDA_BIBLIO_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  // A partir de cuánto ocupa una sesión se le dice a Claude que libere espacio.
  // El techo de verdad es el disco de las sesiones (infra/r/disco-de-sesiones.sh).
  R_AVISO_SESION_MB: z.coerce.number().int().positive().default(300),

  // ── Libro de Reclamaciones ──────────────────────────────────────────────
  // Los datos del proveedor que encabezan cada hoja. Los pide el reglamento:
  // quien reclama tiene que saber a quién. Sin RUC la hoja sale igual, pero
  // incompleta, así que conviene rellenarlo en cuanto se tenga.
  RECLAMOS_RAZON_SOCIAL: z.string().default('Benicio Gonzalo Acosta Enríquez'),
  RECLAMOS_RUC: vacioComoAusente(z.string().regex(/^\d{11}$/, 'RECLAMOS_RUC tiene 11 dígitos')),
  RECLAMOS_DOMICILIO: z.string().default('Trujillo, La Libertad, Perú'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const detalle = parsed.error.issues
    .map((issue) => `  · ${issue.path.join('.')}: ${issue.message}`)
    .join('\n');
  // Fallar en el arranque: es preferible no levantar el servidor mal configurado.
  console.error(`Configuración inválida en .env:\n${detalle}`);
  process.exit(1);
}

const raw = parsed.data;

/**
 * Comprobaciones que solo tienen sentido en producción.
 *
 * La del conector no es cosmética: Claude llama desde la nube de Anthropic, así
 * que una URL en localhost o sin HTTPS simplemente no es alcanzable y el
 * comprador vería un conector que nunca conecta, sin ningún error que lo
 * explique. Es mejor no arrancar.
 */
if (raw.NODE_ENV === 'production') {
  const problemas = [];

  if (!raw.MCP_PUBLIC_URL.startsWith('https://')) {
    problemas.push('MCP_PUBLIC_URL debe empezar por https:// para que Claude pueda conectarse.');
  }
  if (/localhost|127\.0\.0\.1/.test(raw.MCP_PUBLIC_URL)) {
    problemas.push('MCP_PUBLIC_URL apunta a localhost: Claude no llama desde el equipo del comprador.');
  }
  if (!raw.COOKIE_SECURE) {
    problemas.push('COOKIE_SECURE debería ser true en producción.');
  }
  if (raw.SKILLS_SIMULADAS) {
    problemas.push(
      'SKILLS_SIMULADAS está activo: el conector devolvería texto de mentira a clientes reales.',
    );
  }
  if (raw.R_MOTOR === 'local') {
    problemas.push(
      'R_MOTOR=local ejecuta el R que llega por el conector SIN JAULA, con los permisos de la API. ' +
        'En producción, systemd (o apagado).',
    );
  }

  if (problemas.length > 0) {
    console.error(`Configuración inválida para producción:\n${problemas.map((p) => `  · ${p}`).join('\n')}`);
    process.exit(1);
  }
}

const env = Object.freeze({
  ...raw,
  isProduction: raw.NODE_ENV === 'production',
  isDevelopment: raw.NODE_ENV === 'development',
  corsOrigins: raw.CORS_ORIGIN.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  // El refresh token solo viaja a las rutas que lo necesitan.
  refreshCookiePath: `${raw.API_PREFIX}/auth`,
  // De dónde cuelgan los enlaces cortos, `/s/<código>`.
  //
  // Se saca de MCP_PUBLIC_URL en vez de pedir una variable nueva: esa ya apunta
  // a esta misma API y está puesta en todos los entornos, y el `.env` del
  // servidor no se toca en los despliegues. Si mañana el conector se sirviera
  // desde otro dominio, esto es lo primero que habría que separar.
  apiPublicUrl: raw.MCP_PUBLIC_URL.replace(/\/mcp\/?$/, ''),
  // Hace falta host y contraseña: con uno solo, el envío fallaría en cada intento.
  smtpEnabled: Boolean(raw.SMTP_HOST && raw.SMTP_PASS),
  // Con la simulación encendida el conector funciona sin clave. La doble
  // condición no es redundante: aunque el arranque ya lo impide en producción,
  // esta es la que consulta el código, y conviene que no dependa de otra
  // comprobación hecha treinta líneas más arriba.
  skillsSimuladas: raw.SKILLS_SIMULADAS && raw.NODE_ENV !== 'production',
  rewriteEnabled:
    Boolean(raw.ANTHROPIC_API_KEY) || (raw.SKILLS_SIMULADAS && raw.NODE_ENV !== 'production'),
  googleAuthEnabled: Boolean(raw.GOOGLE_CLIENT_ID),
  asistenteEnabled: Boolean(raw.GEMINI_API_KEY),
  googleClientIds: (raw.GOOGLE_CLIENT_ID ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean),
  paypalEnabled: Boolean(raw.PAYPAL_CLIENT_ID && raw.PAYPAL_CLIENT_SECRET),
  // Las dos llaves, con su forma, y del MISMO entorno: una pública de prueba
  // con una secreta real genera tokens que el cobro rechaza siempre.
  culqiEnabled: llavesCulqiValidas(raw.CULQI_PUBLIC_KEY, raw.CULQI_SECRET_KEY),
  // El pago manual no depende de credenciales: basta con que haya un QR en la
  // web. Estos datos son solo el texto que lo acompaña.
  yape: {
    titular: raw.YAPE_TITULAR ?? null,
    numero: raw.YAPE_NUMERO ?? null,
  },
  // Se cuelga de donde estén los comprobantes en vez de pedir otra variable.
  // Así, el día que se mueva el almacenamiento persistente, esto se mueve con
  // él y nadie tiene que acordarse de que existía una segunda ruta.
  capitulosDir:
    raw.CAPITULOS_DIR ?? path.join(path.dirname(raw.PROOFS_DIR), 'capitulos'),
  // Por lo mismo que los capítulos: colgado de donde vivan los comprobantes.
  pedidosDir: raw.PEDIDOS_DIR ?? path.join(path.dirname(raw.PROOFS_DIR), 'pedidos'),
  // Los videos de los testimonios. Mismo criterio: colgados de donde estén los
  // comprobantes, sin pedir otra variable que alguien tenga que recordar.
  resenasDir: raw.RESENAS_DIR ?? path.join(path.dirname(raw.PROOFS_DIR), 'resenas'),
  // Los .docx de «Preparar documento», el que sube el cliente y el que se le
  // devuelve. Colgado de los comprobantes, como los anteriores, así que el
  // respaldo diario ya se lo lleva sin tocar nada.
  preparacionesDir:
    raw.PREPARAR_DIR ?? path.join(path.dirname(raw.PROOFS_DIR), 'preparaciones'),
  // El servicio necesita una clave de Gemini: la suya, o la de la casa si no
  // tiene. Sin ninguna, la web no enseña la pestaña y las rutas contestan 503.
  prepararEnabled: Boolean(raw.PREPARAR_GEMINI_API_KEY || raw.GEMINI_API_KEY),
  // R en la conversación (ver R_MOTOR): la jaula en producción, apagado fuera.
  rMotor: raw.R_MOTOR ?? (raw.NODE_ENV === 'production' ? 'systemd' : 'apagado'),
  // Fuera de /var/lib/acostaresearch a propósito: la jaula tapa /var entero y
  // vuelve a montar solo la carpeta de la sesión. Tampoco va en el respaldo
  // diario: son copias de trabajo de la matriz, que el tesista conserva.
  rSesionesDir:
    raw.R_SESIONES_DIR ??
    (raw.NODE_ENV === 'production'
      ? '/var/lib/acostaresearch-r/sesiones'
      : path.resolve(__dirname, '../../storage/r-sesiones')),
  // El corpus solo se activa con clave y con una biblioteca a la que apuntar.
  zoteroEnabled: Boolean(raw.ZOTERO_API_KEY && (raw.ZOTERO_GROUP_ID || raw.ZOTERO_USER_ID)),
  // La ruta de la biblioteca dentro de la API. Un grupo manda sobre la cuenta
  // personal: si algún día el corpus se mueve a un grupo compartido, basta con
  // rellenar ZOTERO_GROUP_ID y no hay que tocar código.
  zoteroLibrary: raw.ZOTERO_GROUP_ID
    ? `groups/${raw.ZOTERO_GROUP_ID}`
    : raw.ZOTERO_USER_ID
      ? `users/${raw.ZOTERO_USER_ID}`
      : null,
  // Conectar el Zotero propio exige las tres cosas a la vez: las dos de la
  // aplicación registrada en Zotero y la llave con la que se guarda la clave
  // que devuelve. Sin la tercera, el resultado del OAuth acabaría en la base
  // en claro, así que es mejor no ofrecer el botón.
  zoteroOauthEnabled: Boolean(
    raw.ZOTERO_OAUTH_CLIENT_KEY && raw.ZOTERO_OAUTH_CLIENT_SECRET && raw.SECRETS_KEY,
  ),
  // Lo mismo para Mendeley: la aplicación registrada y la llave con la que se
  // cifran los tokens. Sin la llave, los tokens acabarían en claro en la base.
  mendeleyOauthEnabled: Boolean(
    raw.MENDELEY_CLIENT_ID && raw.MENDELEY_CLIENT_SECRET && raw.SECRETS_KEY,
  ),
  // ── Scopus por API ──────────────────────────────────────────────────────
  // Las dos cosas a la vez: el interruptor que dice que hay permiso de
  // Elsevier para esto, y una clave con la que preguntar. Falta cualquiera y
  // la función no se ofrece — ni el botón en la web, ni las rutas contestando
  // otra cosa que «no está disponible». La subida de exports no depende de
  // esto y sigue funcionando pase lo que pase.
  scopusApiEnabled: Boolean(raw.SCOPUS_API_ENABLED && raw.ELSEVIER_API_KEY),
  // Con token institucional se puede pedir la vista COMPLETE, que es la que
  // trae resumen y palabras clave. Sin él, lo que vuelva será STANDARD aunque
  // se pida otra cosa, así que es mejor no pedirla y no prometer resúmenes.
  scopusView: raw.ELSEVIER_INSTTOKEN ? 'COMPLETE' : 'STANDARD',
  // El OAuth del propio tesista exige TODO: los endpoints que Elsevier todavía
  // no publica, las credenciales de la aplicación, y la llave con la que se
  // cifran los tokens que devuelva. Sin la última, los tokens de la gente
  // acabarían en la base en claro, así que es mejor no ofrecer el flujo.
  //
  // Mientras esto sea false, «Conectar Scopus» conecta por la clave de la
  // casa. Es la misma pantalla y el mismo botón: lo que cambia por detrás es
  // con qué credencial se pregunta.
  scopusOauthEnabled: Boolean(
    raw.SCOPUS_API_ENABLED &&
      raw.ELSEVIER_CLIENT_ID &&
      raw.ELSEVIER_CLIENT_SECRET &&
      raw.ELSEVIER_AUTH_URL &&
      raw.ELSEVIER_TOKEN_URL &&
      raw.SECRETS_KEY,
  ),
  paypalApiBase:
    raw.PAYPAL_ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com',
});

module.exports = env;
