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

  // Enable CORS for the frontend URL specified in the environment variables, or default to localhost:5173
  app.enableCors({
    origin: configService.get<string>('FRONTEND_URL') ?? 'http://localhost:5173',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  await app.listen(configService.getOrThrow<number>('PORT') ?? DEFAULT_PORT);
}

bootstrap().catch(() => {
  process.exit(1);
});
