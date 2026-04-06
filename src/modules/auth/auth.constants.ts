// eslint-disable-next-line import/prefer-default-export
export const AUTH_CONSTANTS = {
  JWT_SECRET: process.env.JWT_SECRET || 'super-secret-jwt-key-for-red-an-be',
  JWT_EXPIRATION: 3600,
};
