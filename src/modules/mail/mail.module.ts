import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import MailService from './mail.service';
import { MailController } from './mail.controller';

@Module({
  controllers: [MailController],
  imports: [ConfigModule],
  providers: [MailService],
  exports: [MailService],
})
export default class MailModule {}
