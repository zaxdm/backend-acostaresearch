'use strict';

const { Router } = require('express');
const authRoutes = require('./modules/auth/auth.routes');
const userRoutes = require('./modules/users/user.routes');

const router = Router();

router.get('/health', (_req, res) =>
  res.json({ success: true, data: { status: 'ok', uptime: process.uptime() } }),
);

router.use('/auth', authRoutes);
router.use('/users', userRoutes);

module.exports = router;
