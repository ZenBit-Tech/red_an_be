import { MigrationInterface, QueryRunner } from 'typeorm';

export class StripeWebhookEvents1777594600000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`stripe_webhook_events\` (\`id\` varchar(36) NOT NULL, \`stripeEventId\` varchar(64) NOT NULL, \`createdAt\` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE INDEX \`IDX_STRIPE_WEBHOOK_EVENTS_EVENT_ID\` (\`stripeEventId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'DROP INDEX `IDX_STRIPE_WEBHOOK_EVENTS_EVENT_ID` ON `stripe_webhook_events`',
    );
    await queryRunner.query('DROP TABLE `stripe_webhook_events`');
  }
}
