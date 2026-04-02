import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsString, MinLength } from 'class-validator';
import { MAIL_TEMPLATES } from '../../mail/mail.constants';

type MailTemplate = (typeof MAIL_TEMPLATES)[keyof typeof MAIL_TEMPLATES];

export default class SendTestEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email: string;

  @ApiProperty({
    enum: MAIL_TEMPLATES,
    example: MAIL_TEMPLATES.MAGIC_LINK,
  })
  @IsEnum(MAIL_TEMPLATES)
  template: MailTemplate;

  @ApiProperty({ example: 'test-token-123' })
  @IsString()
  @MinLength(1)
  token: string;
}
