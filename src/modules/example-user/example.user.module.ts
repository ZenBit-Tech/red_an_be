import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import TemplateUser from '../../common/db/entities/example.user.entity';
import ExampleUserService from './example.user.service';
import ExampleUserController from './example.user.controller';

@Module({
  imports: [TypeOrmModule.forFeature([TemplateUser])],
  controllers: [ExampleUserController],
  providers: [ExampleUserService],
  exports: [ExampleUserService],
})
export default class ExampleUserModule {}
