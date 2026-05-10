export const BILLING_ROUTE = 'billing';
export const BILLING_TAG = 'Billing';

export const WEBHOOKS_ROUTE = 'webhooks';
export const WEBHOOKS_STRIPE_PATH = 'stripe';

export const STRIPE_API_VERSION = '2026-04-22.dahlia';

export const STRIPE_EVENTS = {
  CHECKOUT_COMPLETED: 'checkout.session.completed',
  SUBSCRIPTION_CREATED: 'customer.subscription.created',
  SUBSCRIPTION_UPDATED: 'customer.subscription.updated',
  SUBSCRIPTION_DELETED: 'customer.subscription.deleted',
  INVOICE_PAYMENT_FAILED: 'invoice.payment_failed',
} as const;

export const BILLING_ERRORS = {
  CHECKOUT_URL_MISSING: 'Stripe did not return a checkout URL',
  WEBHOOK_RAW_BODY_MISSING: 'Missing raw body',
  WEBHOOK_SIGNATURE_INVALID: 'Webhook signature verification failed',
  CHECKOUT_FAILED: 'Failed to create checkout session',
  USER_NOT_FOUND: 'Authenticated user not found',
} as const;

export const BILLING_ENV = {
  STRIPE_SECRET_KEY: 'STRIPE_SECRET_KEY',
  STRIPE_WEBHOOK_SECRET: 'STRIPE_WEBHOOK_SECRET',
  FRONTEND_DOMAIN: 'FRONTEND_DOMAIN',
} as const;

export const BILLING_PATHS = {
  SUCCESS: '/dashboard?payment=success',
  CANCEL: '/dashboard?payment=failed',
} as const;
