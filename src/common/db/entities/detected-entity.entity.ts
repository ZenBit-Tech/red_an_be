import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, JoinColumn } from 'typeorm';
import type DeIdJob from './de-id-job.entity';

@Entity('detected_entities')
export default class DetectedEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column()
  jobId!: string;

  @Column()
  category!: string;

  @Column({ type: 'float' })
  confidence!: number;

  @Column()
  start!: number;

  @Column()
  end!: number;

  @Column()
  proxyType!: string;

  @ManyToOne('DeIdJob', (job: DeIdJob) => job.detectedEntities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job!: DeIdJob;
}
