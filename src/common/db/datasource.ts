import { DataSource, DataSourceOptions } from 'typeorm';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';
import User from './entities/user.entity';
import DeIdJob from './entities/de-id-job.entity';
import DetectedEntity from './entities/detected-entity.entity';
import { NODE_ENV } from '../constants';
import Subscription from './entities/subscription.entity';

config();
const configService = new ConfigService();
const shouldUseTsMigrations = configService.get<string>('TYPEORM_USE_TS_MIGRATIONS') === 'true';
const nodeEnvironment = configService.getOrThrow<string>('NODE_ENV');
const databaseUrl = configService.get<string>('JAWSDB_URL');

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
  entities: [TemplateUser, DeIdJob, DetectedEntity, Subscription],
  migrations,
  migrationsRun: shouldAutoRunMigrations,
  synchronize: false,
  logging: false,
  entities: [User, DeIdJob, DetectedEntity],
  ...(databaseUrl
    ? { url: databaseUrl }
    : {
        host: configService.getOrThrow<string>('DB_HOST'),
        port: configService.getOrThrow<number>('DB_PORT'),
        username: configService.getOrThrow<string>('DB_USERNAME'),
        password: configService.getOrThrow<string>('DB_PASSWORD'),
        database: configService.getOrThrow<string>('DB_NAME'),
        entities: [User, DeIdJob, DetectedEntity],
      }),
};

const dataSource = new DataSource(dataSourceOptions);

export default dataSource;
