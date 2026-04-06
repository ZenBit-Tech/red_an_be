// contact.module.ts
import { Module } from '@nestjs/common';
import MailModule from '../mail/mail.module';
import { ContactFormController } from './contactForm.controller';
import { ContactFormService } from './contactForm.service';

@Module({
  imports: [MailModule],
  controllers: [ContactFormController],
  providers: [ContactFormService],
})
export class ContactFormModule {}
