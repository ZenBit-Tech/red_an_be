import { MigrationInterface, QueryRunner } from 'typeorm';

const LEGACY_TABLE_NAME = 'template_users';
const TARGET_TABLE_NAME = 'users';
const LEGACY_INDEX_NAME = 'IDX_TEMPLATE_USERS_EMAIL';
const TARGET_INDEX_NAME = 'IDX_USERS_EMAIL';

export class RenameTemplateUsersToUsers1775601000000 implements MigrationInterface {
  name = 'RenameTemplateUsersToUsers1775601000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const hasLegacyTable = await queryRunner.hasTable(LEGACY_TABLE_NAME);
    const hasTargetTable = await queryRunner.hasTable(TARGET_TABLE_NAME);

    if (hasLegacyTable && !hasTargetTable) {
      await queryRunner.query(`RENAME TABLE \`${LEGACY_TABLE_NAME}\` TO \`${TARGET_TABLE_NAME}\``);
    }

    const hasRenamedTable = await queryRunner.hasTable(TARGET_TABLE_NAME);
    if (hasRenamedTable) {
      await queryRunner.query(
        `ALTER TABLE \`${TARGET_TABLE_NAME}\` RENAME INDEX \`${LEGACY_INDEX_NAME}\` TO \`${TARGET_INDEX_NAME}\``,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const hasTargetTable = await queryRunner.hasTable(TARGET_TABLE_NAME);

    if (hasTargetTable) {
      await queryRunner.query(
        `ALTER TABLE \`${TARGET_TABLE_NAME}\` RENAME INDEX \`${TARGET_INDEX_NAME}\` TO \`${LEGACY_INDEX_NAME}\``,
      );
    }

    const hasLegacyTable = await queryRunner.hasTable(LEGACY_TABLE_NAME);
    const hasCurrentTable = await queryRunner.hasTable(TARGET_TABLE_NAME);

    if (!hasLegacyTable && hasCurrentTable) {
      await queryRunner.query(`RENAME TABLE \`${TARGET_TABLE_NAME}\` TO \`${LEGACY_TABLE_NAME}\``);
    }
  }
}
