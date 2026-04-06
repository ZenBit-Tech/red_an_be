import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { AUTH_CONSTANTS } from './auth.constants';
import MailModule from '../mail/mail.module';
import TemplateUser from '../../common/db/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([TemplateUser]),
    JwtModule.register({
      secret: AUTH_CONSTANTS.JWT_SECRET,
      signOptions: { expiresIn: AUTH_CONSTANTS.JWT_EXPIRATION },
    }),
    MailModule,
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtModule],
})
export default class AuthModule {}
