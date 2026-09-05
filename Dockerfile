# Imagen del backend. Sirve para Railway, Render, Fly o un VPS con Docker.
#
# Se construye en dos etapas para que la imagen final no arrastre las
# dependencias de compilación de argon2 —que sí necesitan compilador de C— ni
# el código fuente de Prisma que solo hace falta para generar el cliente.

# ── Etapa 1: dependencias ───────────────────────────────────────────────────
FROM node:22-bookworm-slim AS deps

WORKDIR /app

# argon2 se compila desde fuente si no hay binario para esta plataforma.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Solo los manifiestos primero: mientras no cambien, esta capa se reutiliza y
# el `npm ci` —que es lo lento— no se repite en cada despliegue.
COPY package.json package-lock.json ./
COPY prisma ./prisma

# Se instalan TAMBIÉN las de desarrollo, a propósito:
#
#   · `postinstall` ejecuta `prisma generate`, y la CLI de Prisma está en
#     devDependencies. Con --omit=dev el despliegue falla ahí mismo.
#   · La misma CLI hace falta en el servidor para `prisma migrate deploy`.
#
# Son unos megas de más en la imagen a cambio de que migrar en producción sea
# un comando y no un rompecabezas.
RUN npm ci

# ── Etapa 2: la imagen que se ejecuta ───────────────────────────────────────
FROM node:22-bookworm-slim

WORKDIR /app

# OpenSSL 3 lo pide el motor de consultas de Prisma (binaryTargets incluye
# "debian-openssl-3.0.x"). Sin él, la primera consulta falla con un error que
# no menciona la causa.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma
COPY src ./src
COPY scripts ./scripts

# ── Lo que hay que persistir ────────────────────────────────────────────────
#
# Dos carpetas sobreviven a los despliegues, y las dos guardan cosas que no
# están en el repositorio:
#
#   · /app/data/skills        los .skill que sube el administrador
#   · /app/data/comprobantes  las capturas de pago de Yape
#
# En un hosting de disco efímero (Railway, Render, Fly) hay que montarles un
# volumen en /app/data. Sin él, el día que redespliegues te quedas sin
# capítulos que servir y sin los comprobantes de los pagos por revisar.
ENV SKILLS_DIR=/app/data/skills \
    PROOFS_DIR=/app/data/comprobantes

RUN mkdir -p /app/data/skills /app/data/comprobantes \
  && chown -R node:node /app/data

# No como root: si alguien se cuela por una vulnerabilidad de una dependencia,
# que no se encuentre con el contenedor entero en la mano.
USER node

EXPOSE 3000

# El servidor ya atiende SIGTERM y cierra ordenadamente (src/server.js), así
# que se lanza node directo, sin npm de por medio: npm no reenvía la señal y
# el contenedor moriría a la fuerza con peticiones a medias.
CMD ["node", "src/server.js"]
