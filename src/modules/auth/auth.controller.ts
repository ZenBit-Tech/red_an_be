import { Controller, Post, Body, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
// eslint-disable-next-line import/no-named-as-default
import AuthService from '@/modules/auth/auth.service';
import { MagicLinkRequestDto, AuthResponseDto } from '@/modules/auth/dto/auth.dto';

@ApiTags('Auth')
@Controller('auth')
export default class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('magic-link/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Log in or sign up via magic link' })
  @ApiResponse({ status: 200, description: 'Magic link sent' })
  async requestMagicLink(@Body() dto: MagicLinkRequestDto): Promise<{ message: string }> {
    await this.authService.requestMagicLink(dto);
    return { message: 'A magic link has been sent to your email.' };
  }

  @Get('magic-link/callback')
  @ApiOperation({ summary: 'Verify magic link token and log in' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async verifyMagicLink(@Query('token') token: string): Promise<AuthResponseDto> {
    const result = await this.authService.verifyMagicLink(token);
    return plainToInstance(AuthResponseDto, result, { excludeExtraneousValues: true });
  }
}
