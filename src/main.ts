import './env';
import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';

async function bootstrap() {
  for (const k of ['DATABASE_URL', 'JWT_ACCESS_SECRET']) {
    if (!process.env[k]) throw new Error(`Environment ${k} belum di-set (lihat backend/.env.example)`);
  }

  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api/v1');
  app.enableCors({ origin: (process.env.WEB_ORIGIN ?? 'http://localhost:3000').split(','), credentials: true });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));

  const config = new DocumentBuilder()
    .setTitle('Contractor ERP API')
    .setDescription('REST API v1 — tenant-scoped, JSON envelope { data, meta? } / { error }')
    .setVersion('1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  Logger.log(`API berjalan di http://localhost:${port}/api/v1  ·  Swagger: http://localhost:${port}/api/docs`, 'Bootstrap');
}
bootstrap();
