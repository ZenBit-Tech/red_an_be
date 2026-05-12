import { MigrationInterface, QueryRunner } from 'typeorm';

const DETECTED_ENTITIES_TABLE = 'detected_entities';

const SYSTEM_STATUS_COLUMN = 'systemStatus';
const SYSTEM_STATUS_REASON_COLUMN = 'systemStatusReason';
const USER_STATUS_COLUMN = 'userStatus';
const USER_STATUS_REASON_COLUMN = 'userStatusReason';
const SOURCE_COLUMN = 'source';
const SYNTHETIC_ELIGIBLE_COLUMN = 'isSyntheticEligible';
const STATUS_UPDATED_AT_COLUMN = 'statusUpdatedAt';
const STATUS_UPDATED_BY_USER_UUID_COLUMN = 'statusUpdatedByUserUuid';

const JOB_SYSTEM_STATUS_INDEX = 'IDX_DETECTED_ENTITIES_JOB_SYSTEM_STATUS';
const JOB_USER_STATUS_INDEX = 'IDX_DETECTED_ENTITIES_JOB_USER_STATUS';
const JOB_SYNTHETIC_ELIGIBLE_INDEX = 'IDX_DETECTED_ENTITIES_JOB_SYNTHETIC_ELIGIBLE';

export class AddDetectedEntityStatuses1778600000000 implements MigrationInterface {
  name = 'AddDetectedEntityStatuses1778600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${SYSTEM_STATUS_COLUMN}\` enum('ACTIVE','INACTIVE') NOT NULL DEFAULT 'ACTIVE'`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${SYSTEM_STATUS_REASON_COLUMN}\` enum('ANALYZER_DETECTED','POSTPROCESSOR_ADDED','FILTERED_CONTEXT','FILTERED_ALLOWLIST','FILTERED_OVERLAP','FILTERED_RULE') NOT NULL DEFAULT 'ANALYZER_DETECTED'`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${USER_STATUS_COLUMN}\` enum('ACTIVE','INACTIVE') NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${USER_STATUS_REASON_COLUMN}\` enum('USER_BULK_ACTIVATE','USER_BULK_DEACTIVATE','USER_SINGLE_UPDATE','USER_RESET_OVERRIDE') NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${SOURCE_COLUMN}\` enum('ANALYZER','POSTPROCESSOR') NOT NULL DEFAULT 'ANALYZER'`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${SYNTHETIC_ELIGIBLE_COLUMN}\` tinyint NOT NULL DEFAULT 1`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${STATUS_UPDATED_AT_COLUMN}\` datetime NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` ADD COLUMN \`${STATUS_UPDATED_BY_USER_UUID_COLUMN}\` varchar(36) NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_SYSTEM_STATUS_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`${SYSTEM_STATUS_COLUMN}\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_USER_STATUS_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`${USER_STATUS_COLUMN}\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_SYNTHETIC_ELIGIBLE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`${SYNTHETIC_ELIGIBLE_COLUMN}\`)`,
      )
      .catch(() => undefined);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`DROP INDEX \`${JOB_SYNTHETIC_ELIGIBLE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${JOB_USER_STATUS_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${JOB_SYSTEM_STATUS_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${STATUS_UPDATED_BY_USER_UUID_COLUMN}\``,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${STATUS_UPDATED_AT_COLUMN}\``,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${SYNTHETIC_ELIGIBLE_COLUMN}\``,
      )
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${SOURCE_COLUMN}\``)
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${USER_STATUS_REASON_COLUMN}\``,
      )
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${USER_STATUS_COLUMN}\``)
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${SYSTEM_STATUS_REASON_COLUMN}\``,
      )
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DETECTED_ENTITIES_TABLE}\` DROP COLUMN \`${SYSTEM_STATUS_COLUMN}\``)
      .catch(() => undefined);
  }
}
