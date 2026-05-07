import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import AppModule from './app.module';
import {
  APP_DESCRIPTION,
  APP_NAME,
  APP_VERSION,
  CORS_ALLOWED_HEADERS,
  CORS_ALLOWED_METHODS,
  DEFAULT_PORT,
} from './common/constants';
import ensureDatabase from './common/db/ensure.database';

function resolveCorsOrigins(configService: ConfigService): string[] {
  const configuredOrigins = configService.get<string>('CORS_ALLOWED_ORIGINS')?.trim();

  if (configuredOrigins) {
    return configuredOrigins
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0);
  }

  const frontendDomain = configService.get<string>('FRONTEND_DOMAIN')?.trim();

  if (frontendDomain && frontendDomain.length > 0) {
    return [frontendDomain];
  }

  return [];
}

async function bootstrap() {
  if (process.env.NODE_ENV !== 'production') {
    await ensureDatabase();
  }

  const app = await NestFactory.create(AppModule, { rawBody: true });
  const configService = new ConfigService();
  const corsOrigins = resolveCorsOrigins(configService);

  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    methods: CORS_ALLOWED_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${APP_NAME} API`)
    .setDescription(APP_DESCRIPTION)
    .setVersion(APP_VERSION)
    .addBearerAuth()
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = configService.get<number>('PORT') || process.env.PORT || DEFAULT_PORT;
  await app.listen(port, '0.0.0.0');
}

bootstrap().catch((e) => {
  console.error('BOOTSTRAP ERROR:', e);
  process.exit(1);
});
