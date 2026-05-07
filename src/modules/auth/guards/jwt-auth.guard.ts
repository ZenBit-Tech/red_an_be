import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Request } from 'express';

export type JwtPayload = {
  sub: string;
  email: string;
};

export type AuthenticatedRequest = Request & { user: JwtPayload };

@Injectable()
export default class JwtAuthGuard implements CanActivate {
  constructor(private readonly jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = JwtAuthGuard.extractTokenFromHeader(request);

    if (!token) {
      throw new UnauthorizedException('Missing or malformed Authorization header');
    }

    try {
      const payload = this.jwtService.verify<JwtPayload>(token);
      (request as AuthenticatedRequest).user = payload;
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired access token');
    }
  }

  private static extractTokenFromHeader(request: Request): string | undefined {
    const [type, token] = request.headers.authorization?.split(' ') ?? [];
    return type === 'Bearer' ? token : undefined;
  }
}
