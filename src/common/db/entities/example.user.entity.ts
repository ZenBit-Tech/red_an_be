import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';
import {
  EXAMPLE_USER_ALIASES,
  EXAMPLE_USER_LIMITS,
} from '../../../modules/example-user/example.user.constants';

@Entity({ name: EXAMPLE_USER_ALIASES.TABLE })
@Index('IDX_TEMPLATE_USERS_EMAIL', ['email'])
export default class TemplateUser {
  @PrimaryGeneratedColumn('uuid')
  uuid: string;

  @Column({ length: EXAMPLE_USER_LIMITS.EMAIL_MAX_LENGTH, unique: true, nullable: false })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;
}
