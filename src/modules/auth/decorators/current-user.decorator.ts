import { createParamDecorator, ExecutionContext } from '@nestjs/common';
<<<<<<< HEAD
import type { JwtPayload, AuthenticatedRequest } from '../guards/jwt-auth.guard';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): JwtPayload => {
=======
import { AuthenticatedUser } from '../types/authenticated-user.type';

type AuthenticatedRequest = {
  user: AuthenticatedUser;
};

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
>>>>>>> develop
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    return request.user;
  },
);
