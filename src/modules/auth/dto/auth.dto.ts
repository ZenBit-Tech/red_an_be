/* eslint-disable max-classes-per-file */
import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty } from 'class-validator';
import { Expose } from 'class-transformer';

export class MagicLinkRequestDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  email!: string;
}

export class AuthResponseDto {
  @ApiProperty()
  @Expose()
  accessToken!: string;
}
