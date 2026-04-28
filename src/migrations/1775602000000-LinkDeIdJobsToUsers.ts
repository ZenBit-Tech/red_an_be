import { MigrationInterface, QueryRunner } from 'typeorm';

const DE_ID_JOBS_TABLE = 'de_id_jobs';
const USERS_TABLE = 'users';
const USER_UUID_COLUMN = 'userUuid';
const USER_UUID_INDEX = 'IDX_DE_ID_JOBS_USER_UUID';
const USER_UUID_FOREIGN_KEY = 'FK_DE_ID_JOBS_USER_UUID_USERS_UUID';

export class LinkDeIdJobsToUsers1775602000000 implements MigrationInterface {
  name = 'LinkDeIdJobsToUsers1775602000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(
        `ALTER TABLE \`${DE_ID_JOBS_TABLE}\` ADD COLUMN \`${USER_UUID_COLUMN}\` varchar(36) NULL`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `CREATE INDEX \`${USER_UUID_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\` (\`${USER_UUID_COLUMN}\`)`,
      )
      .catch(() => undefined);

    await queryRunner
      .query(
        `ALTER TABLE \`${DE_ID_JOBS_TABLE}\` ADD CONSTRAINT \`${USER_UUID_FOREIGN_KEY}\` FOREIGN KEY (\`${USER_UUID_COLUMN}\`) REFERENCES \`${USERS_TABLE}\`(\`uuid\`) ON DELETE SET NULL ON UPDATE NO ACTION`,
      )
      .catch(() => undefined);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query(`ALTER TABLE \`${DE_ID_JOBS_TABLE}\` DROP FOREIGN KEY \`${USER_UUID_FOREIGN_KEY}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`DROP INDEX \`${USER_UUID_INDEX}\` ON \`${DE_ID_JOBS_TABLE}\``)
      .catch(() => undefined);

    await queryRunner
      .query(`ALTER TABLE \`${DE_ID_JOBS_TABLE}\` DROP COLUMN \`${USER_UUID_COLUMN}\``)
      .catch(() => undefined);
  }
}
