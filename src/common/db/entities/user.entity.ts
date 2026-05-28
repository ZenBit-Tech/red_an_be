import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';
import {
  BILLING_DEFAULT_TIMEZONE,
  BILLING_FREE_DAILY_DOCUMENT_LIMIT,
  BILLING_PLAN_STATUS,
  BILLING_PLAN_TIER,
} from '@common/constants/billing.constants';

export type BillingPlanTier = (typeof BILLING_PLAN_TIER)[keyof typeof BILLING_PLAN_TIER];
export type BillingPlanStatus = (typeof BILLING_PLAN_STATUS)[keyof typeof BILLING_PLAN_STATUS];

@Entity('users')
@Index('IDX_USERS_EMAIL', ['email'])
export default class User {
  @PrimaryGeneratedColumn('uuid')
  uuid!: string;

  @Column({ type: 'varchar', unique: true, nullable: false })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  stripeCustomerId?: string | null;

  @Column({ type: 'boolean', default: false })
  hasUsedProfessionalTrial!: boolean;

  @Column({
    type: 'enum',
    enum: BILLING_PLAN_TIER,
    default: BILLING_PLAN_TIER.FREE,
  })
  planTier!: BillingPlanTier;

  @Column({
    type: 'enum',
    enum: BILLING_PLAN_STATUS,
    default: BILLING_PLAN_STATUS.INACTIVE,
  })
  planStatus!: BillingPlanStatus;

  @Column({ type: 'datetime', nullable: true })
  currentPeriodEnd!: Date | null;

  @Column({ type: 'int', nullable: true, default: BILLING_FREE_DAILY_DOCUMENT_LIMIT })
  dailyLimit!: number | null;

  @Column({ type: 'datetime', nullable: true })
  entitlementsUpdatedAt!: Date | null;

  @Column({ type: 'varchar', length: 64, nullable: true, default: BILLING_DEFAULT_TIMEZONE })
  timezone!: string | null;
}
