import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JwtModule } from '@nestjs/jwt';
import { AUTH_CONSTANTS } from '@common/constants';
import AuthController from '@/modules/auth/auth.controller';
import MailModule from '@/modules/mail/mail.module';
import TemplateUser from '@/common/db/entities/user.entity';
import AuthService from '@/modules/auth/auth.service';

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
