import { MigrationInterface, QueryRunner } from 'typeorm';

const USERS_TABLE = 'users';
const LEGACY_USERS_TABLE = 'template_users';
const SUBSCRIPTIONS_TABLE = 'subscriptions';

export class AddProfessionalTrialUsageFlag1779400000000 implements MigrationInterface {
  name = 'AddProfessionalTrialUsageFlag1779400000000';

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
      `ALTER TABLE \`${usersTable}\` ADD \`hasUsedProfessionalTrial\` tinyint NOT NULL DEFAULT 0`,
    );

    const hasSubscriptionsTable = await queryRunner.hasTable(SUBSCRIPTIONS_TABLE);
    if (!hasSubscriptionsTable) {
      return;
    }

    await queryRunner.query(
      `UPDATE \`${usersTable}\`
       SET \`hasUsedProfessionalTrial\` = 1
       WHERE \`uuid\` IN (
         SELECT DISTINCT \`userId\`
         FROM \`${SUBSCRIPTIONS_TABLE}\`
         WHERE \`userId\` IS NOT NULL
       )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const usersTable = await this.resolveUsersTable(queryRunner);

    await queryRunner
      .query(`ALTER TABLE \`${usersTable}\` DROP COLUMN \`hasUsedProfessionalTrial\``)
      .catch(() => undefined);
  }
}
