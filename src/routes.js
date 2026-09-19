'use strict';

const { Router } = require('express');
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const rewriteRoutes = require('./modules/rewrite/rewrite.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const paymentRoutes = require('./modules/payments/payment.routes');
const licenseRoutes = require('./modules/licensing/license.routes');
const skillRoutes = require('./modules/skills/skill.routes');
const referenceRoutes = require('./modules/references/reference.routes');
const propiasRoutes = require('./modules/references/propias.routes');
const tutorialRoutes = require('./modules/tutorials/tutorial.routes');
const guiaRoutes = require('./modules/guias/guia.routes');
const projectRoutes = require('./modules/projects/project.routes');
const trialRoutes = require('./modules/trials/trial.routes');
const zoteroRoutes = require('./modules/zotero/biblioteca.routes');
const scopusRoutes = require('./modules/scopus/scopus.routes');
const mapasRoutes = require('./modules/mapas/mapas.routes');
const asistenteRoutes = require('./modules/asistente/asistente.routes');
const reclamoRoutes = require('./modules/reclamos/reclamo.routes');
const rRoutes = require('./modules/r/r.routes');
const cualitativoRoutes = require('./modules/cualitativo/cualitativo.routes');

const comprobarBase = require('./lib/comprobarBase');

const router = Router();

router.get('/health', (_req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } }),
);

// `/health` dice si el proceso está vivo y no toca la base, así que con la base
// caída sigue contestando ok. Esta es la que pregunta la pantalla de
// mantenimiento de la web para saber cuándo quitarse. Si la base no está, el
// error llega al manejador de errores y sale como 503.

router.get('/health/bd', async (_req, res, next) => {
  try {
    await comprobarBase();
    res.json({ success: true, data: { status: 'ok' } });
  } catch (error) {
    next(error);
  }
});

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/rewrites', rewriteRoutes);
router.use('/billing', billingRoutes);
router.use('/payments', paymentRoutes);
router.use('/licenses', licenseRoutes);
router.use('/skills', skillRoutes);
// Antes que el módulo del administrador: aquel monta authorize(ADMIN) para
// todo lo que cuelga de él, y un comprador tiene que poder llegar a lo suyo.
router.use('/mis-fuentes', propiasRoutes);
router.use('/referencias', referenceRoutes);
router.use('/tutoriales', tutorialRoutes);
router.use('/guias', guiaRoutes);
router.use('/proyectos', projectRoutes);
router.use('/pruebas', trialRoutes);
// El Zotero de cada comprador. Aparte de /referencias, que es el corpus de la
// casa: aquello lo administra Acosta y esto lo conecta cada tesista.
router.use('/mi-zotero', zoteroRoutes);
// El Scopus de cada comprador: conectar, buscar e importar lo que elija. Sus
// fuentes acaban en el mismo sitio que su export y que su Zotero, y solo las
// ve él. Apagado salvo que el .env lo encienda: ver SCOPUS_API_ENABLED.
router.use('/mi-scopus', scopusRoutes);
// Los mapas de coocurrencia para VOSviewer, desde OpenAlex o desde sus fuentes.
router.use('/mis-mapas', mapasRoutes);
// El chat de la web. Público: está para quien todavía no tiene cuenta.
router.use('/asistente', asistenteRoutes);
// El Libro de Reclamaciones. Presentar una hoja es público; responderla, del
// administrador.
router.use('/reclamos', reclamoRoutes);
// R en la conversación: subir la matriz y bajar lo que produce el análisis,
// desde los enlaces que da Claude. Sin sesión: el enlace firmado es la llave.
router.use('/r', rRoutes);
// El análisis cualitativo: subir las entrevistas desde el enlace que da Claude.
// Sin sesión, como las de R.
router.use('/cualitativo', cualitativoRoutes);

module.exports = router;
