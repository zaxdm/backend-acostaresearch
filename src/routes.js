'use strict';

const { Router } = require('express');
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');
const rewriteRoutes = require('./modules/rewrite/rewrite.routes');
const billingRoutes = require('./modules/billing/billing.routes');
const paymentRoutes = require('./modules/payments/payment.routes');
const licenseRoutes = require('./modules/licensing/license.routes');
const skillRoutes = require('./modules/skills/skill.routes');

const router = Router();

router.get('/health', (_req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } }),
);

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/rewrites', rewriteRoutes);
router.use('/billing', billingRoutes);
router.use('/payments', paymentRoutes);
router.use('/licenses', licenseRoutes);
router.use('/skills', skillRoutes);

module.exports = router;
