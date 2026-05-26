import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export type PaymentStatus = 'paid' | 'failed' | 'canceled' | 'pending';

@Entity('payment_history')
export default class PaymentHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 64 })
  stripeInvoiceId!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  invoiceNumber!: string | null;

  @Column({ type: 'integer' })
  amount!: number;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: PaymentStatus;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
