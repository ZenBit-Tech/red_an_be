import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { ValidationPipe } from '@nestjs/common';
import AppModule from './app.module';
import { APP_DESCRIPTION, APP_NAME, APP_VERSION, DEFAULT_PORT } from './common/constants';
import ensureDatabase from './common/db/ensure.database';

async function bootstrap() {
  await ensureDatabase();

  const app = await NestFactory.create(AppModule);

  const swaggerConfig = new DocumentBuilder()
    .setTitle(`${APP_NAME} API`)
    .setDescription(APP_DESCRIPTION)
    .setVersion(APP_VERSION)
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  const configService = new ConfigService();

  const corsOrigin = configService.get<string>('app.corsOrigin') ?? 'http://localhost:5173';

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: corsOrigin,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  await app.listen(configService.getOrThrow<number>('PORT') ?? DEFAULT_PORT);
}

bootstrap().catch(() => {
  process.exit(1);
});
