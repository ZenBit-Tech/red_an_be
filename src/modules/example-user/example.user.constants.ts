export const EXAMPLE_USER_ROUTE = 'example-users';
export const EXAMPLE_USER_TAG = 'example-users';

export const EXAMPLE_USER_ALIASES = {
  TABLE: 'template_users',
  ENTITY_ALIAS: 'templateUser',
};

export const EXAMPLE_USER_LIMITS = {
  EMAIL_MAX_LENGTH: 320,
};

export const EXAMPLE_USER_ERRORS = {
  FETCH_ALL_FAILED: 'Failed to fetch users',
  FETCH_ONE_FAILED: 'Failed to fetch user',
  CREATE_FAILED: 'Failed to create user',
  CREATED_ID_MISSING: 'User creation failed: no id returned',
  CREATED_USER_MISSING: 'User creation failed: could not fetch created user',
  DUPLICATE_EMAIL: 'Email already exists',
  NOT_FOUND: 'User with uuid %uuid% not found',
  DB_CONNECTION_FAILED: 'Database connection check failed',
};

export const EXAMPLE_USER_MESSAGES = {
  DB_CONNECTION_OK: 'Database connection is healthy',
};

export const MYSQL_ERROR_CODES = {
  DUPLICATE_ENTRY: 'ER_DUP_ENTRY',
};
