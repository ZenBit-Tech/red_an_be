import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import DeIdJob from '@common/db/entities/de-id-job.entity';
import DetectedEntity from '@common/db/entities/detected-entity.entity';
import DeIdController from './de-identification.controller';
import DeIdService from './de-identification.service';
import StatsService from './stats.service';
import PresidioClient from './presidio.client';
import RemoteNlpClient from './remote-nlp.client';

@Module({
  imports: [TypeOrmModule.forFeature([DeIdJob, DetectedEntity])],
  controllers: [DeIdController],
  providers: [DeIdService, StatsService, PresidioClient, RemoteNlpClient],
  exports: [DeIdService],
})
export default class DeIdModule {}
