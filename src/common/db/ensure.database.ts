import { createPool } from 'mysql2/promise';
import { config } from 'dotenv';
import { ConfigService } from '@nestjs/config';

config();
const configService = new ConfigService();

export default async function ensureDatabase(): Promise<void> {
  const host = configService.getOrThrow<string>('DB_HOST');
  const port = configService.getOrThrow<number>('DB_PORT');
  const username = configService.getOrThrow<string>('DB_USERNAME');
  const password = configService.getOrThrow<string>('DB_PASSWORD');
  const databaseName = configService.getOrThrow<string>('DB_NAME');

  const pool = createPool({
    host,
    port,
    user: username,
    password,
    waitForConnections: true,
    connectionLimit: 2,
  });

  try {
    try {
      await pool.query(`CREATE DATABASE IF NOT EXISTS \`${databaseName}\``);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to ensure database existence: ${message}`);
    }
  } finally {
    await pool.end();
  }
}
