import { MigrationInterface, QueryRunner } from 'typeorm';

export class UpdateAuthToMagicOnly1775476768408 implements MigrationInterface {
  name = 'UpdateAuthToMagicOnly1775476768408';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX \`IDX_TEMPLATE_USERS_EMAIL_UNIQUE\` ON \`template_users\``);
    await queryRunner.query(
      `ALTER TABLE \`template_users\` ADD \`magicLinkToken\` varchar(255) NULL`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`IDX_91b7ab89f51669febcd4e65c1e\` ON \`template_users\` (\`email\`)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX \`IDX_91b7ab89f51669febcd4e65c1e\` ON \`template_users\``);
    await queryRunner.query(`ALTER TABLE \`template_users\` DROP COLUMN \`magicLinkToken\``);
    await queryRunner.query(
      `CREATE UNIQUE INDEX \`IDX_TEMPLATE_USERS_EMAIL_UNIQUE\` ON \`template_users\` (\`email\`)`,
    );
  }
}
