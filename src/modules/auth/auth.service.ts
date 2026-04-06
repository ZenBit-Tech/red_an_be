import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import MailService from '../mail/mail.service';
import TemplateUser from '../../common/db/entities/user.entity';
import LoginDto from './dto/login.dto';
import MagicLinkRequestDto from './dto/magic-link-request.dto';

@Injectable()
// eslint-disable-next-line import/prefer-default-export
export class AuthService {
  constructor(
    @InjectRepository(TemplateUser)
    private readonly userRepository: Repository<TemplateUser>,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async login(dto: LoginDto): Promise<{ accessToken: string }> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: dto.email })
      .getOne();

    if (!user || !user.password) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(dto.password, user.password);
    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.generateToken(user.uuid, user.email);
  }

  async requestMagicLink(dto: MagicLinkRequestDto): Promise<void> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: dto.email })
      .getOne();

    if (!user) {
      return;
    }

    const magicToken = crypto.randomBytes(32).toString('hex');

    // Оновлюємо базу
    await this.userRepository
      .createQueryBuilder()
      .update(TemplateUser)
      .set({ magicLinkToken: magicToken })
      .where('id = :id', { id: user.uuid })
      .execute();

    // Відправляємо реальний лист через MailService
    await this.mailService.sendMagicLink(user.email, magicToken);
  }

  async verifyMagicLink(token: string): Promise<{ accessToken: string }> {
    const user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.magicLinkToken = :token', { token })
      .getOne();

    if (!user) {
      throw new UnauthorizedException('Invalid or expired magic link');
    }


    await this.userRepository
      .createQueryBuilder()
      .update(TemplateUser)
      .set({ magicLinkToken: () => "'NULL'" })
      .where('id = :id', { id: user.uuid })
      .execute();

    return this.generateToken(user.uuid, user.email);
  }

  private generateToken(userId: number | string, email: string) {
    const payload = { sub: userId, email };
    return {
      accessToken: this.jwtService.sign(payload),
    };
  }
}