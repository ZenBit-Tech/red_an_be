import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';
import { USER_LIMITS } from '../user.constants';

export default class CreateUserDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Unique email of a user',
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(USER_LIMITS.EMAIL_MAX_LENGTH)
  email: string;
}
