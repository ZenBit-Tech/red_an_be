export const DEFAULT_PORT = 3000;
export const HELLO_MESSAGE = 'Hello World!';
export const APP_NAME = 'red-an-be';
export const APP_DESCRIPTION = 'API documentation for red-an-be backend template';
export const APP_VERSION = '0.1.0';

export const NODE_ENV = {
  PRODUCTION: 'production',
  DEVELOPMENT: 'development',
};

export const AUTH_CONSTANTS = {
  JWT_SECRET: process.env.JWT_SECRET || 'super-secret-jwt-key-for-red-an-be',
  JWT_EXPIRATION: 3600,
};
export const USER_ALIASES = {
  TABLE: 'template_users',
  ENTITY_ALIAS: 'templateUser',
};

export const USER_LIMITS = {
  EMAIL_MAX_LENGTH: 320,
};
