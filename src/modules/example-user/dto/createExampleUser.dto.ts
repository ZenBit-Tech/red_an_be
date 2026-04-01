import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsNotEmpty, MaxLength } from 'class-validator';
import { EXAMPLE_USER_LIMITS } from '../example.user.constants';

export default class CreateExampleUserDto {
  @ApiProperty({
    example: 'user@example.com',
    description: 'Unique email of a user',
  })
  @IsEmail()
  @IsNotEmpty()
  @MaxLength(EXAMPLE_USER_LIMITS.EMAIL_MAX_LENGTH)
  email: string;
}
