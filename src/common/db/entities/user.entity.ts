import { Entity, Column, PrimaryGeneratedColumn, Index } from 'typeorm';

@Entity('users')
@Index('IDX_USERS_EMAIL', ['email'])
export default class User {
  @PrimaryGeneratedColumn('uuid')
  uuid: string;

  @Column({ unique: true, nullable: false })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  magicLinkToken?: string | null;
}
