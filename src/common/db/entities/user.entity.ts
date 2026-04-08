import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';
import { USER_ALIASES, USER_LIMITS } from '../../constants';

@Entity({ name: USER_ALIASES.TABLE })
@Index('IDX_TEMPLATE_USERS_EMAIL', ['email'])
export default class TemplateUser {
  @PrimaryGeneratedColumn('uuid')
  uuid: string;

  @Column({ length: USER_LIMITS.EMAIL_MAX_LENGTH, unique: true, nullable: false })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;
}
