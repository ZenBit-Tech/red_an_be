import { MigrationInterface, QueryRunner } from 'typeorm';

export class DeIdentificationTables1775600000000 implements MigrationInterface {
  name = 'DeIdentificationTables1775600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      "CREATE TABLE IF NOT EXISTS `de_id_jobs` (`id` varchar(36) NOT NULL, `framework` enum('HIPAA','GDPR_EU','GDPR_UK') NOT NULL, `threshold` float NOT NULL, `preserveStructure` tinyint NOT NULL DEFAULT 1, `sourceTextHash` varchar(64) NOT NULL, `sourceTextLength` int UNSIGNED NOT NULL, `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6), INDEX `IDX_5dba18af0f50ace4cf2f30e8e7` (`framework`), PRIMARY KEY (`id`)) ENGINE=InnoDB",
    );

    await queryRunner.query(
      'CREATE TABLE IF NOT EXISTS `detected_entities` (`id` varchar(36) NOT NULL, `jobId` varchar(36) NOT NULL, `category` varchar(255) NOT NULL, `confidence` float NOT NULL, `start` int NOT NULL, `end` int NOT NULL, `proxyType` varchar(255) NOT NULL, INDEX `IDX_de9a47a9ce95f7d3340fd8be77` (`jobId`), PRIMARY KEY (`id`)) ENGINE=InnoDB',
    );

    await queryRunner
      .query(
        'ALTER TABLE `detected_entities` ADD CONSTRAINT `FK_de9a47a9ce95f7d3340fd8be779` FOREIGN KEY (`jobId`) REFERENCES `de_id_jobs`(`id`) ON DELETE CASCADE ON UPDATE NO ACTION',
      )
      .catch(() => undefined);

    await queryRunner
      .query('ALTER TABLE `de_id_jobs` ADD COLUMN `sourceTextHash` varchar(64) NOT NULL')
      .catch(() => undefined);

    await queryRunner
      .query('ALTER TABLE `de_id_jobs` ADD COLUMN `sourceTextLength` int UNSIGNED NOT NULL')
      .catch(() => undefined);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner
      .query('ALTER TABLE `detected_entities` DROP FOREIGN KEY `FK_de9a47a9ce95f7d3340fd8be779`')
      .catch(() => undefined);
    await queryRunner.query('DROP TABLE IF EXISTS `detected_entities`');
    await queryRunner.query('DROP TABLE IF EXISTS `de_id_jobs`');
  }
}
