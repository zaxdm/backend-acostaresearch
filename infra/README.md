# Lo que vive en el servidor

Copia de los archivos que hacen funcionar el servidor y que **no** están dentro
de la aplicación. Hasta ahora existían en un solo sitio: la máquina. Si se
pierde el servidor, con la aplicación sola no se puede reconstruir cómo se
despliega, ni cuándo se respalda, ni qué se respalda.

**Esto es una copia para poder rehacer la máquina, no la versión viva.** El
servidor no lee de aquí. Al cambiar algo allí, hay que traerlo aquí a mano — y
si algún día divergen, manda el servidor.

## Qué es cada cosa

| Archivo | Dónde vive en el servidor | Qué hace |
|---|---|---|
| `desplegar.sh` | `/opt/acostaresearch/desplegar.sh` | Trae la última versión de `main`, instala, aplica migraciones, reinicia y comprueba desde fuera que la web responde |
| `respaldar.sh` | `/opt/acostaresearch/respaldar.sh` | Vuelca la base de datos entera y empaqueta las skills, los comprobantes de Yape y el `.env`. Se niega a rotar los respaldos viejos si el volcado sale a medias |
| `systemd/acostaresearch-respaldo.*` | `/etc/systemd/system/` | Lanza el respaldo cada día a las 3:30 UTC |
| `systemd/acostaresearch-caducidad.*` | `/etc/systemd/system/` | Lanza el aviso de caducidad cada día a las 13:00 UTC, las 8 de la mañana en Lima |
| `systemd/acostaresearch-corpus.*` | `/etc/systemd/system/` | Sincroniza el corpus con Zotero cada noche a las 04:30 UTC, las 23:30 en Lima |
| `systemd/acostaresearch-bibliotecas.*` | `/etc/systemd/system/` | Trae la colección de Zotero de cada comprador que la conectó, a las 05:30 UTC, las 00:30 en Lima |
| `r/acostaresearch-r@.service` | `/etc/systemd/system/` | La jaula donde corre el R de «trabajar_en_r»: sin red, sin ver /opt ni /var, sin el entorno de la API, 400 MB, un núcleo, 16 procesos y 45 s |
| `r/acostaresearch-r.slice` | `/etc/systemd/system/` | El tope de todas las sesiones de R juntas: 1,5 GB y núcleo y medio |
| `r/60-acostaresearch-r.rules` | `/etc/polkit-1/rules.d/` | Deja al usuario de la API arrancar y parar esa plantilla, y nada más |
| `r/instalar.sh` | se ejecuta desde `/opt/acostaresearch/app/infra/r/` | Instala R, el usuario `acosta-r`, la carpeta de sesiones, lo de arriba y 2 GB de swap |
| `r/probar-jaula.sh` | se ejecuta desde `/opt/acostaresearch/app/infra/r/` | Intenta escapar de la jaula (secretos, red, memoria, tiempo, procesos, disco, ejecutar lo que escribe) y dice si lo consigue |
| `r/disco-de-sesiones.sh` | se ejecuta desde `/opt/acostaresearch/app/infra/r/` | Pone las sesiones de R en una imagen propia de 4 GB montada con `noexec`: llenarla ya no llena el disco de la API, el registro y el respaldo. Se puede repetir |

## R en la conversación

El R de la herramienta `trabajar_en_r` **no corre en el proceso de la API**.
El backend deja el código en `/var/lib/acostaresearch-r/sesiones/<proyecto>/` y
arranca `acostaresearch-r@<proyecto>.service`, que ejecuta `r/ejecutar.R`
dentro de la jaula. Ver la cabecera de la unidad para lo que R no puede hacer.

Instalación, una vez y después de desplegar el código que la trae:

```bash
bash /opt/acostaresearch/app/infra/r/instalar.sh
bash /opt/acostaresearch/app/infra/r/probar-jaula.sh   # todo tiene que salir OK
```

`R_LIMITE_SEGUNDOS` del `.env` y `TimeoutStartSec` de la unidad tienen que
coincidir (45 por defecto). Las sesiones no van en el respaldo diario: son
copias de trabajo de la matriz, y se borran con el proyecto.

## Las cuatro horas

| Hora UTC | Hora en Lima | Qué corre |
|---|---|---|
| 03:30 | 22:30 | Respaldo |
| 04:30 | 23:30 | Sincronización del corpus |
| 05:30 | 00:30 | Sincronización de las bibliotecas de los compradores |
| 13:00 | 08:00 | Aviso de caducidad |

## Por qué las horas están separadas

El plan de la base de datos da **cinco conexiones simultáneas**. Ya se agotaron
dos veces: una porque un despliegue coincidió con una sincronización de Zotero,
y otra porque el pool de Prisma se dimensiona por número de núcleos. Cada tarea
programada ocupa una conexión, así que van a horas distintas y ninguna debe
coincidir con una sincronización manual.

## Rehacer la máquina desde cero

1. Instalar Node 24, Caddy y `mysql-client-core-8.0`.
2. Clonar el repositorio en `/opt/acostaresearch/app` y poner el `.env`
   (sale del último respaldo).
3. Copiar `desplegar.sh` y `respaldar.sh` a `/opt/acostaresearch/`, con permisos
   `755` y dueño `root`.
4. Copiar las unidades de `systemd/` a `/etc/systemd/system/`, luego
   `systemctl daemon-reload` y `systemctl enable --now` los dos temporizadores.
5. Cargar la base de datos desde `base-de-datos.sql.gz`, que va dentro del
   respaldo.

> El paso 5 **todavía no se ha ensayado**. Está comprobado que el volcado sale
> completo y con los datos dentro, pero nadie lo ha cargado en una base vacía.
> Hasta que eso se haga, el respaldo es una suposición razonable, no una certeza.
