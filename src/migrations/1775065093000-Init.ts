import { MigrationInterface, QueryRunner } from 'typeorm';

export class Init1775065093000 implements MigrationInterface {
  name = 'Init1775065093000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `template_users` (`uuid` varchar(36) NOT NULL, `email` varchar(320) NOT NULL, INDEX `IDX_TEMPLATE_USERS_EMAIL` (`email`), UNIQUE INDEX `IDX_TEMPLATE_USERS_EMAIL_UNIQUE` (`email`), PRIMARY KEY (`uuid`)) ENGINE=InnoDB',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP TABLE IF EXISTS `template_users`');
  }
}
