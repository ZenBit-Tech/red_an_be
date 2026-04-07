import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { JwtService } from '@nestjs/jwt';
import * as crypto from 'crypto';
import TemplateUser from '../../common/db/entities/example.user.entity';
import MagicLinkRequestDto from './dto/magic-link-request.dto';
import MailService from '../mail/mail.service';

@Injectable()
export default class AuthService {
  constructor(
    @InjectRepository(TemplateUser)
    private readonly userRepository: Repository<TemplateUser>,
    private readonly jwtService: JwtService,
    private readonly mailService: MailService,
  ) {}

  async requestMagicLink(dto: MagicLinkRequestDto): Promise<void> {
    let user = await this.userRepository
      .createQueryBuilder('user')
      .where('user.email = :email', { email: dto.email })
      .getOne();

    if (!user) {
      await this.userRepository
        .createQueryBuilder()
        .insert()
        .into(TemplateUser)
        .values({ email: dto.email })
        .execute();

      user = await this.userRepository
        .createQueryBuilder('user')
        .where('user.email = :email', { email: dto.email })
        .getOne();
    }

    const magicToken = crypto.randomBytes(32).toString('hex');

    await this.userRepository
      .createQueryBuilder()
      .update(TemplateUser)
      .set({ magicLinkToken: magicToken })
      .where('uuid = :uuid', { uuid: user!.uuid })
      .execute();

    await this.mailService.sendMagicLink(user!.email, magicToken);
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
      .set({ magicLinkToken: () => 'NULL' })
      .where('uuid = :uuid', { uuid: user.uuid })
      .execute();

    return {
      accessToken: this.jwtService.sign({ sub: user.uuid, email: user.email }),
    };
  }
}
