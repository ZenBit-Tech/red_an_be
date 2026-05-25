import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';
import { BILLING_PLAN_TIER } from '@common/constants/billing.constants';

export const CHECKOUT_TARGET_PLAN = {
  PROFESSIONAL: BILLING_PLAN_TIER.PROFESSIONAL,
} as const;

export type CheckoutTargetPlan = (typeof CHECKOUT_TARGET_PLAN)[keyof typeof CHECKOUT_TARGET_PLAN];

export default class CreateCheckoutSessionDto {
  @ApiProperty({
    example: CHECKOUT_TARGET_PLAN.PROFESSIONAL,
    description: 'Target plan for checkout. Only PROFESSIONAL is supported.',
    enum: CHECKOUT_TARGET_PLAN,
  })
  @IsEnum(CHECKOUT_TARGET_PLAN)
  readonly targetPlan!: CheckoutTargetPlan;
}
