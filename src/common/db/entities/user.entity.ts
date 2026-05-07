import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('users')
@Index('IDX_USERS_EMAIL', ['email'])
export default class User {
  @PrimaryGeneratedColumn('uuid')
  uuid: string | undefined;

  @Column({ type: 'varchar', unique: true, nullable: false })
  email: string | undefined;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  stripeCustomerId?: string | null;
}
