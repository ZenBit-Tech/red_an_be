import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type SubscriptionStatus =
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'
  | 'unpaid';

@Entity('subscriptions')
export default class Subscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64, nullable: true })
  stripeSubscriptionId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  stripeCustomerId!: string;

  @Column({ type: 'varchar', length: 64 })
  stripePriceId!: string;

  @Column({ type: 'varchar', length: 32 })
  status!: SubscriptionStatus;

  @Column({ type: 'timestamp', nullable: true })
  currentPeriodEnd!: Date | null;

  @Column({ type: 'boolean', default: false })
  cancelAtPeriodEnd!: boolean;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
