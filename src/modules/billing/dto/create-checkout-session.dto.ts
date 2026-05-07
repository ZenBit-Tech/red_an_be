import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export default class CreateCheckoutSessionDto {
  @ApiProperty({
    example: 'price_1TJX2rJYsXYgdDVrgYY88YrD',
    description: 'Stripe Price ID for the selected subscription plan',
  })
  @IsString()
  @IsNotEmpty()
  readonly priceId!: string;
}
