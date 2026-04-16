import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import TemplateUser from './entities/example.user.entity';
import DeIdJob from './entities/de-id-job.entity';
import DetectedEntity from './entities/detected-entity.entity';
import { NODE_ENV } from '../constants';

config();
const configService = new ConfigService();
const shouldUseTsMigrations = configService.get<string>('TYPEORM_USE_TS_MIGRATIONS') === 'true';
const nodeEnvironment = configService.getOrThrow<string>('NODE_ENV');

const shouldAutoRunMigrations = nodeEnvironment === NODE_ENV.DEVELOPMENT;

let migrations: string[] = ['dist/migrations/*.js'];
if (shouldUseTsMigrations) {
  migrations = ['src/migrations/*.ts'];
}

export const dataSourceOptions: DataSourceOptions = {
  type: 'mysql',
  host: configService.getOrThrow<string>('DB_HOST'),
  port: configService.getOrThrow<number>('DB_PORT'),
  username: configService.getOrThrow<string>('DB_USERNAME'),
  password: configService.getOrThrow<string>('DB_PASSWORD'),
  database: configService.getOrThrow<string>('DB_NAME'),
  entities: [TemplateUser, DeIdJob, DetectedEntity],
  migrations,
  migrationsRun: shouldAutoRunMigrations,
  synchronize: false,
  logging: false,
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
