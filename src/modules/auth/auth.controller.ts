/* eslint-disable import/prefer-default-export */
import { Controller, Post, Body, Get, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';
import { plainToInstance } from 'class-transformer';
import { AuthService } from './auth.service';
import LoginDto from './dto/login.dto';
import MagicLinkRequestDto from './dto/magic-link-request.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

@ApiTags('Auth')
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async login(@Body() loginDto: LoginDto): Promise<AuthResponseDto> {
    const result = await this.authService.login(loginDto);
    return plainToInstance(AuthResponseDto, result, { excludeExtraneousValues: true });
  }

  @Post('magic-link/request')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Request a magic link via email' })
  @ApiResponse({ status: 200, description: 'Magic link sent (check console)' })
  async requestMagicLink(@Body() dto: MagicLinkRequestDto): Promise<{ message: string }> {
    await this.authService.requestMagicLink(dto);
    return { message: 'If the email exists, a magic link has been sent.' };
  }

  @Get('magic-link/callback')
  @ApiOperation({ summary: 'Verify magic link token and log in' })
  @ApiResponse({ status: 200, type: AuthResponseDto })
  async verifyMagicLink(@Query('token') token: string): Promise<AuthResponseDto> {
    const result = await this.authService.verifyMagicLink(token);
    return plainToInstance(AuthResponseDto, result, { excludeExtraneousValues: true });
  }
}
