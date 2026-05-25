import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('daily_usage')
@Index('UQ_DAILY_USAGE_USER_DATE', ['userId', 'usageDate'], { unique: true })
export default class DailyUsage {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 36 })
  userId!: string;

  @Column({ type: 'date' })
  usageDate!: string;

  @Column({ type: 'int', unsigned: true, default: 0 })
  documentsUsed!: number;

  @CreateDateColumn({ type: 'timestamp' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamp' })
  updatedAt!: Date;
}
