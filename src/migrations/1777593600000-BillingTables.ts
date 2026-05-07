import { MigrationInterface, QueryRunner } from 'typeorm';

export class BillingTables1777593600000 implements MigrationInterface {
  name = 'BillingTables1777593600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('ALTER TABLE `template_users` ADD `stripeCustomerId` varchar(64) NULL');

    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS \`subscriptions\` (
        \`id\` varchar(36) NOT NULL,
        \`userId\` varchar(36) NOT NULL,
        \`stripeSubscriptionId\` varchar(64) NULL,
        \`stripeCustomerId\` varchar(64) NOT NULL,
        \`stripePriceId\` varchar(64) NOT NULL,
        \`status\` varchar(32) NOT NULL,
        \`currentPeriodEnd\` timestamp NULL,
        \`cancelAtPeriodEnd\` tinyint(1) NOT NULL DEFAULT 0,
        \`createdAt\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
        \`updatedAt\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
        INDEX \`IDX_subscriptions_userId\` (\`userId\`),
        UNIQUE INDEX \`IDX_subscriptions_stripeSubscriptionId\` (\`stripeSubscriptionId\`),
        PRIMARY KEY (\`id\`)
      ) ENGINE=InnoDB`,
    );

    await queryRunner.query(
      `ALTER TABLE \`subscriptions\`
        ADD CONSTRAINT \`FK_subscriptions_userId\`
        FOREIGN KEY (\`userId\`)
        REFERENCES \`template_users\`(\`uuid\`)
        ON DELETE CASCADE
        ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query('ALTER TABLE `subscriptions` DROP FOREIGN KEY `FK_subscriptions_userId`')
      .catch(() => undefined);
    await queryRunner.query('DROP TABLE IF EXISTS `subscriptions`');
    await queryRunner
      .query('ALTER TABLE `template_users` DROP COLUMN `stripeCustomerId`')
      .catch(() => undefined);
  }
}
