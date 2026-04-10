import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  OneToMany,
  Index,
} from 'typeorm';
import { ComplianceFramework } from '@common/constants/compliance.constants';
import type DetectedEntity from './detected-entity.entity';

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

  @OneToMany('DetectedEntity', (entity: DetectedEntity) => entity.job)
  detectedEntities!: DetectedEntity[];

  @CreateDateColumn()
  createdAt!: Date;
}
