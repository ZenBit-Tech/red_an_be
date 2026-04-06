import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';

export class AuthResponseDto {
  @ApiProperty()
  @Expose()
  accessToken!: string;
}

export default AuthResponseDto;
