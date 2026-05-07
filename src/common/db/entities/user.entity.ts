import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('template_users')
@Index('IDX_TEMPLATE_USERS_EMAIL', ['email'])
export default class TemplateUser {
  @PrimaryGeneratedColumn('uuid')
  uuid: string | undefined;

  @Column({ type: 'varchar', unique: true, nullable: false })
  email: string | undefined;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  stripeCustomerId?: string | null;
}
