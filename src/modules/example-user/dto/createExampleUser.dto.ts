import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { EXAMPLE_USER_LIMITS } from '../example.user.constants';

export default class CreateUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(EXAMPLE_USER_LIMITS.EMAIL_MAX_LENGTH)
  email!: string;
}
