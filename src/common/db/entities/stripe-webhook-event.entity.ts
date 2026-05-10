import { CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity('stripe_webhook_events')
export default class StripeWebhookEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_STRIPE_WEBHOOK_EVENTS_EVENT_ID', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  stripeEventId!: string;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;
}
