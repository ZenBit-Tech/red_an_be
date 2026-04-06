import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import * as nodemailer from 'nodemailer';
import * as handlebars from 'handlebars';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  ContactLeadData,
  MAGIC_LINK_PATH,
  MAIL_STRATEGY,
  MAIL_SUBJECTS,
  MAIL_TEMPLATES,
} from './mail.constants';

@Injectable()
export default class MailService {
  private resend: Resend | null = null;

  private transporter: nodemailer.Transporter | null = null;

  constructor(private configService: ConfigService) {
    const strategy = this.configService.get<string>('MAIL_STRATEGY');

    if (strategy === MAIL_STRATEGY.RESEND) {
      this.resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
    } else {
      this.transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: {
          user: this.configService.get<string>('GMAIL_USER'),
          pass: this.configService.get<string>('GMAIL_APP_PASSWORD'),
        },
      });
    }
  }

  private async sendEmailWithTemplate<T extends object>(options: {
    to: string;
    subject: string;
    templateName: string;
    context: T;
  }): Promise<void> {
    try {
      const templatePath = path.resolve(
        __dirname,
        '../../templates',
        `${options.templateName}.html`,
      );
      const templateSource = await fs.readFile(templatePath, 'utf-8');
      const template = handlebars.compile(templateSource);
      const html = template(options.context);

      const from = this.configService.getOrThrow<string>('SMTP_FROM');

      if (this.resend) {
        await this.resend.emails.send({
          from,
          to: options.to,
          subject: options.subject,
          html,
        });
      } else if (this.transporter) {
        await this.transporter.sendMail({
          from,
          to: options.to,
          subject: options.subject,
          html,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InternalServerErrorException(`Mail error: ${message}`);
    }
  }

  async sendMagicLink(email: string, token: string): Promise<void> {
    const domain = this.configService.get<string>('FRONTEND_DOMAIN');
    const magicLink = `${domain}${MAGIC_LINK_PATH}${token}`;

    await this.sendEmailWithTemplate({
      to: email,
      subject: MAIL_SUBJECTS.MAGIC_LINK,
      templateName: MAIL_TEMPLATES.MAGIC_LINK,
      context: { link: magicLink },
    });
  }

  async sendContactLead(clientData: ContactLeadData): Promise<void> {
    const salesEmail = this.configService.getOrThrow<string>('SALES_EMAIL');

    await this.sendEmailWithTemplate({
      to: salesEmail,
      subject: MAIL_SUBJECTS.CONTACT_LEAD_PREFIX,
      templateName: MAIL_TEMPLATES.CONTACT_LEAD,
      context: clientData,
    });
  }
}
