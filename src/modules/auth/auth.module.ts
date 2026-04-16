import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { TypeOrmModule } from '@nestjs/typeorm';
import MailModule from '@/modules/mail/mail.module';
import TemplateUser from '@/common/db/entities/user.entity';
import AuthController from './auth.controller';
import AuthService from './auth.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([TemplateUser]),
    MailModule,
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const secret = configService.get<string>('JWT_SECRET');
        if (!secret) {
          throw new Error('JWT_SECRET is not defined in environment variables');
        }
        const expiresInString = configService.get<string | number>('JWT_EXPIRATION');
        const expiresIn = Number(expiresInString);
        return {
          secret,
          signOptions: {
            expiresIn,
          },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService],
  exports: [AuthService, JwtModule],
})
export default class AuthModule {}
