# Estilos e idiomas CSL

Los archivos de esta carpeta dan formato a las citas y a la bibliografía del Word
de la tesis. Los lee `project.normas.js` y los aplica `project.csl.js` con
citeproc-js.

## De dónde salen

- `estilos/*.csl` — los quince estilos que Zotero trae de fábrica, descargados
  de `https://www.zotero.org/styles/<id>` el 12 de septiembre de 2026. Son los
  mismos archivos que usa Zotero: si alguien abre el Word con Zotero y pulsa
  «Refresh», las citas no cambian.
- `idiomas/locales-*.xml` — del repositorio oficial
  `https://github.com/citation-style-language/locales`. De Perú no hay: se ofrecen
  España, México y Chile, y el inglés de respaldo.

## Licencias

- Estilos e idiomas CSL: **Creative Commons Attribution-ShareAlike 3.0**
  (CC BY-SA 3.0), del proyecto Citation Style Language
  (https://citationstyles.org). Cada `.csl` lleva dentro sus autores y su
  licencia; no se han modificado.
- citeproc-js (paquete `citeproc` de npm): doble licencia **CPAL-1.0 o
  AGPL-3.0**, de Frank Bennett y colaboradores
  (https://github.com/Juris-M/citeproc-js). Se usa sin modificar, desde el
  servidor.

## Cómo actualizar un estilo

```bash
curl -fsSL "https://www.zotero.org/styles/apa" -o estilos/apa.csl
```

Después, `npm test`: `normas.test.js` comprueba que cada estilo sigue siendo
independiente y que su familia (autor-fecha, numérica o notas) no ha cambiado, y
`citas.norma.test.js` que los quince siguen dando citas y bibliografía.
