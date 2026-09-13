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
const projectRoutes = require('./modules/projects/project.routes');
const trialRoutes = require('./modules/trials/trial.routes');
const zoteroRoutes = require('./modules/zotero/biblioteca.routes');

const prisma = require('./lib/prisma');
const { crearSonda } = require('./lib/sondaBase');

const router = Router();

router.get('/health', (_req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } }),
);

// `/health` dice si el proceso está vivo y no toca la base, así que con la base
// caída sigue contestando ok. Esta es la que pregunta la pantalla de
// mantenimiento de la web para saber cuándo quitarse. Si la base no está, el
// error llega al manejador de errores y sale como 503.
const comprobarBase = crearSonda({ consultar: () => prisma.$queryRaw`SELECT 1` });

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
router.use('/proyectos', projectRoutes);
router.use('/pruebas', trialRoutes);
// El Zotero de cada comprador. Aparte de /referencias, que es el corpus de la
// casa: aquello lo administra Acosta y esto lo conecta cada tesista.
router.use('/mi-zotero', zoteroRoutes);

module.exports = router;
