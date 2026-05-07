import { Expose } from 'class-transformer';
import { ApiProperty } from '@nestjs/swagger';

export default class ReturnUserDto {
  @ApiProperty()
  @Expose()
  uuid!: string;

  @ApiProperty()
  @Expose()
  email!: string;
}
