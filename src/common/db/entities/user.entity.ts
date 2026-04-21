import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('template_users')
@Index('IDX_TEMPLATE_USERS_EMAIL', ['email'])
export default class TemplateUser {
  @PrimaryGeneratedColumn('uuid')
  uuid: string;

  @Column({ unique: true, nullable: false })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;
}
