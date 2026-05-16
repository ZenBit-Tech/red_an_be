import { Entity, PrimaryGeneratedColumn, Column, ManyToOne, Index, JoinColumn } from 'typeorm';
import {
  DetectedEntitySource,
  DetectedEntityStatus,
  DetectedEntitySystemReason,
  DetectedEntityUserReason,
} from '@common/constants/compliance.constants';
import type DeIdJob from './de-id-job.entity';

@Index('IDX_DETECTED_ENTITIES_JOB_CATEGORY', ['jobId', 'category'])
@Index('IDX_DETECTED_ENTITIES_JOB_PROXY_TYPE', ['jobId', 'proxyType'])
@Index('IDX_DETECTED_ENTITIES_JOB_CONFIDENCE', ['jobId', 'confidence'])
@Index('IDX_DETECTED_ENTITIES_JOB_SYSTEM_STATUS', ['jobId', 'systemStatus'])
@Index('IDX_DETECTED_ENTITIES_JOB_USER_STATUS', ['jobId', 'userStatus'])
@Index('IDX_DETECTED_ENTITIES_JOB_SYNTHETIC_ELIGIBLE', ['jobId', 'isSyntheticEligible'])
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

  @Column({ type: 'enum', enum: DetectedEntityStatus, default: DetectedEntityStatus.ACTIVE })
  systemStatus!: DetectedEntityStatus;

  @Column({
    type: 'enum',
    enum: DetectedEntitySystemReason,
    default: DetectedEntitySystemReason.ANALYZER_DETECTED,
  })
  systemStatusReason!: DetectedEntitySystemReason;

  @Column({ type: 'enum', enum: DetectedEntityStatus, nullable: true })
  userStatus!: DetectedEntityStatus | null;

  @Column({ type: 'enum', enum: DetectedEntityUserReason, nullable: true })
  userStatusReason!: DetectedEntityUserReason | null;

  @Column({ type: 'enum', enum: DetectedEntitySource, default: DetectedEntitySource.ANALYZER })
  source!: DetectedEntitySource;

  @Column({ type: 'boolean', default: true })
  isSyntheticEligible!: boolean;

  @Column({ type: 'datetime', nullable: true })
  statusUpdatedAt!: Date | null;

  @Column({ type: 'varchar', length: 36, nullable: true })
  statusUpdatedByUserUuid!: string | null;

  @ManyToOne('DeIdJob', (job: DeIdJob) => job.detectedEntities, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'jobId' })
  job!: DeIdJob;
}
