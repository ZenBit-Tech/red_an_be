import { Controller, Post, Get, Body, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody } from '@nestjs/swagger';
import AuthService from './auth.service';
import { AuthResponseDto, MagicLinkRequestDto } from './dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export default class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link')
  @ApiOperation({ summary: 'Request a magic link for login/registration' })
  @ApiResponse({ status: 201, description: 'Magic link sent to email' })
  @ApiBody({ type: MagicLinkRequestDto })
  async requestMagicLink(@Body('email') email: string) {
    await this.authService.requestMagicLink(email);
    return { message: 'Magic link sent' };
  }

  @Get('magic-link/callback')
  @ApiOperation({ summary: 'Verify magic link token and return JWT' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async verifyMagicLink(@Query('token') token: string): Promise<AuthResponseDto> {
    return this.authService.verifyMagicLink(token);
  }
}
