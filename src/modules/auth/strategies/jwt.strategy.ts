import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { AuthenticatedUser } from '../types/authenticated-user.type';
import { JwtPayload } from '../types/jwt-payload.type';

@Injectable()
export default class JwtStrategy extends PassportStrategy(Strategy) {
  private readonly invalidTokenPayloadMessage = 'Invalid token payload';

  constructor(private readonly configService: ConfigService) {
    const jwtSecret = configService.get<string>('JWT_SECRET');

    if (!jwtSecret) {
      throw new Error('JWT_SECRET is not defined in environment variables');
    }

    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  validate(payload: JwtPayload): AuthenticatedUser {
    if (!payload.sub || !payload.email) {
      throw new UnauthorizedException(this.invalidTokenPayloadMessage);
    }

    return {
      uuid: payload.sub,
      email: payload.email,
    };
  }
}
