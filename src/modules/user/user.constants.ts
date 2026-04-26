export const USER_ROUTE = 'users';
export const USER_TAG = 'users';

export const USER_ALIASES = {
  TABLE: 'users',
  ENTITY_ALIAS: 'user',
};

export const USER_LIMITS = {
  EMAIL_MAX_LENGTH: 320,
};

export const USER_ERRORS = {
  FETCH_ALL_FAILED: 'Failed to fetch users',
  FETCH_ONE_FAILED: 'Failed to fetch user',
  CREATE_FAILED: 'Failed to create user',
  CREATED_ID_MISSING: 'User creation failed: no id returned',
  CREATED_USER_MISSING: 'User creation failed: could not fetch created user',
  DUPLICATE_EMAIL: 'Email already exists',
  NOT_FOUND: 'User with uuid %uuid% not found',
  DB_CONNECTION_FAILED: 'Database connection check failed',
};

export const USER_MESSAGES = {
  DB_CONNECTION_OK: 'Database connection is healthy',
};

export const MYSQL_ERROR_CODES = {
  DUPLICATE_ENTRY: 'ER_DUP_ENTRY',
};
