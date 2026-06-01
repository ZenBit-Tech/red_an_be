import { MigrationInterface, QueryRunner } from 'typeorm';

export class CreatePaymentHistoryTable1779827000000 implements MigrationInterface {
  name = 'CreatePaymentHistoryTable1779827000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE \`payment_history\` (\`id\` varchar(36) NOT NULL, \`userId\` varchar(36) NOT NULL, \`stripeInvoiceId\` varchar(64) NOT NULL, \`invoiceNumber\` varchar(32) NULL, \`amount\` int NOT NULL, \`status\` varchar(16) NOT NULL DEFAULT 'pending', \`createdAt\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), \`updatedAt\` timestamp(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6), INDEX \`IDX_34d643de1a588d2350297da5c2\` (\`userId\`), UNIQUE INDEX \`IDX_3192a9c099dd4c565230711b12\` (\`stripeInvoiceId\`), PRIMARY KEY (\`id\`)) ENGINE=InnoDB`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX \`IDX_3192a9c099dd4c565230711b12\` ON \`payment_history\``);
    await queryRunner.query(`DROP INDEX \`IDX_34d643de1a588d2350297da5c2\` ON \`payment_history\``);
    await queryRunner.query(`DROP TABLE \`payment_history\``);
  }
}
