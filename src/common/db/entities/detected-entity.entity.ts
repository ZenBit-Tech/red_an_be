import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, JoinColumn } from 'typeorm';
import type DeIdJob from './de-id-job.entity';

@Index('IDX_DETECTED_ENTITIES_JOB_CATEGORY', ['jobId', 'category'])
@Index('IDX_DETECTED_ENTITIES_JOB_PROXY_TYPE', ['jobId', 'proxyType'])
@Index('IDX_DETECTED_ENTITIES_JOB_CONFIDENCE', ['jobId', 'confidence'])
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
