# Año de las fuentes por DOI — 17-nov-2026

Entrada preparada para añadir a `documentacion/05-integraciones.md`, junto a
OpenAlex/Crossref. Esa carpeta está fuera del único directorio con permiso de
escritura de esta sesión (`backend/`); no se modificó el documento externo.

## Año del número frente a publicación en línea (17-nov-2026)

Al guardar o completar una fuente por DOI, si el artículo ya tiene volumen o
número, se usa el año del número. Los dos lectores de Crossref comparten ahora
esta prioridad: `journal-issue.published-print`, `published-print`, `issued` y,
como último recurso, `published-online`. Se salta una fecha vacía o inválida.
Si no hay volumen ni número, se prefiere el año de `published-online`.

En las uniones con OpenAlex y en el completado de Scopus, el año de Crossref
manda cuando hay volumen o número, incluso si se acaban de rellenar esos
campos. Si Crossref no responde o no tiene año, se conserva el anterior.
También se rellena un año ausente cuando Crossref lo aporta.

No se añaden llamadas de red: se aprovecha el Crossref que ya se consultaba
por DOI. Las búsquedas y el lote por DOI de la base externa solicitan ahora el
registro completo, porque `journal-issue` no está entre los campos que admite
`select`. Esto aumenta el tamaño de la respuesta, sin cambiar el número de
peticiones, los filtros, los límites ni los tiempos de espera. Lista oficial
de campos: [API de Crossref](https://api.crossref.org/swagger-docs).

Caso de regresión: DOI `10.1177/0972150920954612`, Jamir, *Impact of Global
Financial Crisis on Indian Handicrafts Exports*, *Global Business Review*,
volumen `25`, número `2_suppl`: online/issued 2020, fecha impresa del número
2024 → **year = 2024**. Un artículo solo online sin volumen/número mantiene
el año online.

Las claves de cita (`ref`), las identidades (`sourceRef`), la deduplicación y
el bloqueo de «Corregir» para fuentes con DOI se conservan. Zotero y Mendeley
mandan desde su gestor: sus mappers y sincronizaciones no cambian, y el
completado por Crossref deja enteras las fichas con esos orígenes. No hay
migración, recálculo ni modificación de fuentes ya guardadas.

Recorridos revisados: `propias.service` (DOI, SciELO/resto de OpenAlex y bases
externas), `propias.repository`, los dos clientes de Crossref, OpenAlex,
Scopus y los parsers de CSV/RIS/BibTeX. Los parsers toman el año del archivo,
sin resolver fechas por DOI, y no se alteran. Las fichas completas de Scopus
siguen entrando con sus propios datos, sin una consulta adicional a Crossref.

Archivos de código: `references/crossref.anio.js`,
`references/crossref.client.js`, `externas/crossref.js` y
`scopus/scopus.mapper.js`, bajo `backend/src/modules/`.

Pruebas de regresión nuevas en `backend/tests/references.anio-doi.test.js`:
prioridades de fechas, número suplementario, solo online, caída/falta de fecha,
completado de volumen/número, año ausente, protección de gestores, identidades,
índice de búsqueda y guardado por las tres vías. Reprodujeron el fallo con el
código anterior. Se ajustan las expectativas de las URL en `crossref.test.js`
y `externas.grupo3.test.js` para exigir el registro completo.

Validación local:

- Prueba nueva contra el código anterior: 3 aprobadas, 16 fallidas; reproduce
  el año 2020 donde se exige 2024.
- Archivo nuevo con la corrección: sus 19 pruebas pasan. Junto con los tests
  existentes de Crossref y la base externa: 39 aprobadas, 0 fallidas.
- `npm.cmd test` (el mismo script `npm test`; PowerShell bloquea `npm.ps1`):
  **2931 pruebas, 2930 aprobadas, 1 fallida, 0 omitidas**, en 105,765 s.
  La ejecución previa dio el mismo recuento. Falla únicamente
  `tests/r.motor.real.test.js:155`, «una orden que pasa del límite se corta y
  la sesión sigue como estaba»: recibe `ok` y espera `tiempo`.
  Este fallo ya consta antes del cambio en
  `documentacion/pruebas/2026-11-17-fuentes-sin-doi.md`, sección «Verificación»
  (2911/2912); no se modificó el motor de R ni su prueba.
- `git diff --check`: sin errores. Se verificó que `propias.service.js`,
  `propias.repository.js`, OpenAlex, los parsers y el esquema no tienen cambios.

Pendientes: incorporar esta entrada al documento de integraciones desde una
sesión con permiso de escritura en `documentacion/`, y resolver por separado
el fallo previo de R para que la batería completa quede verde.

Validación real de la API pendiente: las peticiones desde Node a Crossref
están bloqueadas por el entorno (`fetch failed`, causa `EACCES`); las pruebas
usan respuestas simuladas. No se ejecutaron scripts de reparación ni se
accedió al VPS o a una base de producción. Sin commit, push ni despliegue.
