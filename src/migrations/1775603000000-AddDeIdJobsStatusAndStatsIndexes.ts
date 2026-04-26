import { MigrationInterface, QueryRunner } from 'typeorm';

const DE_ID_JOBS_TABLE = 'de_id_jobs';
const DETECTED_ENTITIES_TABLE = 'detected_entities';

const STATUS_COLUMN = 'status';
const PROCESSED_AT_COLUMN = 'processedAt';
const ERROR_CODE_COLUMN = 'errorCode';

const STATUS_INDEX = 'IDX_DE_ID_JOBS_STATUS';
const USER_CREATED_AT_INDEX = 'IDX_DE_ID_JOBS_USER_CREATED_AT';

const JOB_CATEGORY_INDEX = 'IDX_DETECTED_ENTITIES_JOB_CATEGORY';
const JOB_PROXY_TYPE_INDEX = 'IDX_DETECTED_ENTITIES_JOB_PROXY_TYPE';
const JOB_CONFIDENCE_INDEX = 'IDX_DETECTED_ENTITIES_JOB_CONFIDENCE';

export class AddDeIdJobsStatusAndStatsIndexes1775603000000 implements MigrationInterface {
  name = 'AddDeIdJobsStatusAndStatsIndexes1775603000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(
        `ALTER TABLE \`${DE_ID_JOBS_TABLE}\` ADD COLUMN \`${STATUS_COLUMN}\` enum('SUCCESS','FAILED') NOT NULL DEFAULT 'SUCCESS'`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DE_ID_JOBS_TABLE}\` ADD COLUMN \`${PROCESSED_AT_COLUMN}\` datetime NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DE_ID_JOBS_TABLE}\` ADD COLUMN \`${ERROR_CODE_COLUMN}\` varchar(120) NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(`CREATE INDEX \`${STATUS_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\` (\`${STATUS_COLUMN}\`)`)
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${USER_CREATED_AT_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\` (\`userUuid\`, \`createdAt\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_CATEGORY_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`category\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_PROXY_TYPE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`proxyType\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${JOB_CONFIDENCE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\` (\`jobId\`, \`confidence\`)`,
      )
      .catch(() => undefined);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`DROP INDEX \`${JOB_CONFIDENCE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${JOB_PROXY_TYPE_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${JOB_CATEGORY_INDEX}\` ON \`${DETECTED_ENTITIES_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${USER_CREATED_AT_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${STATUS_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DE_ID_JOBS_TABLE}\` DROP COLUMN \`${ERROR_CODE_COLUMN}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DE_ID_JOBS_TABLE}\` DROP COLUMN \`${PROCESSED_AT_COLUMN}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DE_ID_JOBS_TABLE}\` DROP COLUMN \`${STATUS_COLUMN}\``)
      .catch(() => undefined);
  }
}
