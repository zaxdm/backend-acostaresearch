'use strict';

const { Router } = require('express');
const authenticate = require('../../middlewares/authenticate');
const authorize = require('../../middlewares/authorize');
const validate = require('../../middlewares/validate');
const { ROLES } = require('../../config/constants');
const {
  grantPackSchema,
  createDiscountSchema,
  discountIdParamSchema,
  validateDiscountSchema,
  createProductSchema,
  updateProductSchema,
  productCodeParamSchema,
} = require('./billing.schema');
const billingController = require('./billing.controller');

const router = Router();

// Los planes son públicos: la web de venta los necesita sin sesión.
router.get('/plans', billingController.plans);

router.get('/balance', authenticate, billingController.balance);

// Activación manual tras confirmar un Yape. Cuando haya pasarela, el webhook
// llamará al mismo servicio con los mismos datos.
router.post(
  '/packs',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ body: grantPackSchema }),
  billingController.grant,
);
router.get('/packs', authenticate, authorize(ROLES.ADMIN), billingController.recent);

// ── Grupos de skills ───────────────────────────────────────────────────────
//
// Solo para el administrador. Lo que ve el comprador de un grupo —nombre,
// precio, duración— ya sale por `GET /plans`, que es público y filtra los
// retirados; aquí se listan también esos, que es justo lo que no debe ver
// alguien que solo viene a comprar.
router.get('/products', authenticate, authorize(ROLES.ADMIN), billingController.products);
router.post(
  '/products',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ body: createProductSchema }),
  billingController.createProduct,
);
router.patch(
  '/products/:code',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: productCodeParamSchema, body: updateProductSchema }),
  billingController.updateProduct,
);
// Borrar solo funciona con un grupo que no haya dejado rastro: el servicio se
// niega —diciendo qué lo impide— si tiene licencias, pagos o capítulos. Para
// todo lo demás está «Retirar», que es un PATCH de `active`.
router.delete(
  '/products/:code',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: productCodeParamSchema }),
  billingController.deleteProduct,
);

// ── Descuentos ─────────────────────────────────────────────────────────────
// Comprobar un código exige sesión pero no rol: lo hace el propio comprador
// antes de pagar, para ver cuánto le queda.
router.post(
  '/discounts/validate',
  authenticate,
  validate({ body: validateDiscountSchema }),
  billingController.validateDiscount,
);

router.post(
  '/discounts',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ body: createDiscountSchema }),
  billingController.createDiscount,
);
router.get('/discounts', authenticate, authorize(ROLES.ADMIN), billingController.discounts);
router.patch(
  '/discounts/:id',
  authenticate,
  authorize(ROLES.ADMIN),
  validate({ params: discountIdParamSchema }),
  billingController.toggleDiscount,
);

module.exports = router;
