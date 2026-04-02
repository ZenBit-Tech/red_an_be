import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator';
import { MAIL_TEMPLATES } from '../../mail/mail.constants';

type MailTemplate = (typeof MAIL_TEMPLATES)[keyof typeof MAIL_TEMPLATES];

export default class SendTestEmailDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  email!: string;

  @ApiProperty({
    enum: MAIL_TEMPLATES,
    example: MAIL_TEMPLATES.MAGIC_LINK,
  })
  @IsEnum(MAIL_TEMPLATES)
  template!: MailTemplate;

  @ApiPropertyOptional({ example: 'test-token-123' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  token?: string;

  @ApiPropertyOptional({ example: 'John' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  company?: string;

  @ApiPropertyOptional({ example: 'Hello, I have a question...' })
  @IsOptional()
  @IsString()
  message?: string;
}
