import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import TemplateUser from '../../common/db/entities/example.user.entity';
import ExampleUserService from './example.user.service';
import ExampleUserController from './example.user.controller';
import MailModule from '../mail/mail.module';

@Module({
  imports: [TypeOrmModule.forFeature([TemplateUser]), MailModule],
  controllers: [ExampleUserController],
  providers: [ExampleUserService],
  exports: [ExampleUserService],
})
export default class ExampleUserModule {}
