import { MigrationInterface, QueryRunner } from 'typeorm';

const USERS_TABLE = 'users';
const LEGACY_USERS_TABLE = 'template_users';

export class BillingEntitlementsAndDailyUsage1779000000000 implements MigrationInterface {
  name = 'BillingEntitlementsAndDailyUsage1779000000000';

  private async resolveUsersTable(queryRunner: QueryRunner): Promise<string> {
    const hasUsersTable = await queryRunner.hasTable(USERS_TABLE);
    if (hasUsersTable) {
      return USERS_TABLE;
    }

    return LEGACY_USERS_TABLE;
  }

  public async up(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await this.resolveUsersTable(queryRunner);

    await queryRunner.query(
      `ALTER TABLE \`${usersTable}\` ADD \`planTier\` enum('FREE','PROFESSIONAL') NOT NULL DEFAULT 'FREE'`,
    );
    await queryRunner.query(
      `ALTER TABLE \`${usersTable}\` ADD \`planStatus\` enum('ACTIVE','INACTIVE','PAST_DUE','CANCELED') NOT NULL DEFAULT 'INACTIVE'`,
    );
    await queryRunner.query(`ALTER TABLE \`${usersTable}\` ADD \`currentPeriodEnd\` datetime NULL`);
    await queryRunner.query(`ALTER TABLE \`${usersTable}\` ADD \`dailyLimit\` int NULL DEFAULT 2`);
    await queryRunner.query(
      `ALTER TABLE \`${usersTable}\` ADD \`entitlementsUpdatedAt\` datetime NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE \`${usersTable}\` ADD \`timezone\` varchar(64) NULL DEFAULT 'UTC'`,
    );

    await queryRunner.query(
      `CREATE TABLE \`daily_usage\` (
        \`id\` varchar(36) NOT NULL,
        \`userId\` varchar(36) NOT NULL,
        \`usageDate\` date NOT NULL,
        \`documentsUsed\` int unsigned NOT NULL DEFAULT 0,
        \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        \`updatedAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE INDEX \`UQ_DAILY_USAGE_USER_DATE\` (\`userId\`, \`usageDate\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB`,
    );

    await queryRunner.query(
      `ALTER TABLE \`daily_usage\`
        ADD CONSTRAINT \`FK_DAILY_USAGE_USER_ID\`
        FOREIGN KEY (\`userId\`)
        REFERENCES \`${usersTable}\`(\`uuid\`)
        ON DELETE CASCADE
        ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await this.resolveUsersTable(queryRunner);

    await queryRunner
      .query('ALTER TABLE `daily_usage` DROP FOREIGN KEY `FK_DAILY_USAGE_USER_ID`')
      .catch(() => undefined);
    await queryRunner.query('DROP TABLE IF EXISTS `daily_usage`');

    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`timezone\``)
      .catch(() => undefined);
    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`entitlementsUpdatedAt\``)
      .catch(() => undefined);
    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`dailyLimit\``)
      .catch(() => undefined);
    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`currentPeriodEnd\``)
      .catch(() => undefined);
    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`planStatus\``)
      .catch(() => undefined);
    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`planTier\``)
      .catch(() => undefined);
  }
}
