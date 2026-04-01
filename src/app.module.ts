import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import AppController from './app.controller';
import AppService from './app.service';
import ExampleUserModule from './modules/example-user/example.user.module';
import { dataSourceOptions } from './common/db/datasource';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    TypeOrmModule.forRoot(dataSourceOptions),
    ExampleUserModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export default class AppModule {}
