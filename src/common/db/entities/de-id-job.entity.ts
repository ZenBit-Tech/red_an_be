import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ComplianceFramework } from '@common/constants/compliance.constants';
import type DetectedEntity from './detected-entity.entity';
import type User from './user.entity';

export enum DeIdJobStatus {
  SUCCESS = 'SUCCESS',
  FAILED = 'FAILED',
}

@Index('IDX_DE_ID_JOBS_USER_CREATED_AT', ['userUuid', 'createdAt'])
@Entity('de_id_jobs')
export default class DeIdJob {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'enum', enum: ComplianceFramework })
  framework!: ComplianceFramework;

  @Column({ type: 'float' })
  threshold!: number;

  @Column({ type: 'boolean', default: true })
  preserveStructure!: boolean;

  @Column({ type: 'varchar', length: 64 })
  sourceTextHash!: string;

  @Column({ type: 'int', unsigned: true })
  sourceTextLength!: number;

  @Index()
  @Column({ type: 'varchar', length: 36, nullable: true })
  userUuid!: string | null;

  @ManyToOne('User', { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userUuid' })
  user!: User | null;

  @OneToMany('DetectedEntity', (entity: DetectedEntity) => entity.job)
  detectedEntities!: DetectedEntity[];

  @Index()
  @Column({ type: 'enum', enum: DeIdJobStatus, default: DeIdJobStatus.SUCCESS })
  status!: DeIdJobStatus;

  @Column({ type: 'datetime', nullable: true })
  processedAt!: Date | null;

  @Column({ type: 'varchar', length: 120, nullable: true })
  errorCode!: string | null;

  @CreateDateColumn()
  createdAt!: Date;
}
