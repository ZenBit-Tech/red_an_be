export enum DeIdStatsPeriod {
  TODAY = 'today',
  LAST_7_DAYS = 'last_7_days',
  LAST_14_DAYS = 'last_14_days',
  MONTH = 'month',
}

export const DE_ID_STATS_FILTERS = {
  DEFAULT_TIMEZONE: 'UTC',
  SOURCE_UTC_OFFSET: '+00:00',
  START_OF_DAY_TIME: '00:00:00',
  TODAY_RANGE_DAYS: 1,
  LAST_7_DAYS_RANGE_DAYS: 7,
  LAST_14_DAYS_RANGE_DAYS: 14,
  MONTH_RANGE_DAYS: 30,
  DATE_STRING_SEPARATOR: '-',
};

export const DE_ID_STATS_ERRORS = {
  INVALID_TIMEZONE: 'Invalid timezone value',
};
