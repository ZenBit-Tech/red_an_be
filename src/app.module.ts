import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import AppController from './app.controller';
import AppService from './app.service';
import ExampleUserModule from './modules/example-user/example.user.module';
import { dataSourceOptions } from './common/db/datasource';
import MailModule from './modules/mail/mail.module';
import DeIdModule from './modules/de-identification/de-identification.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(dataSourceOptions),
    ExampleUserModule,
    MailModule,
    DeIdModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export default class AppModule {}
