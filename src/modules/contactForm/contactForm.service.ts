import { Injectable } from '@nestjs/common';
import MailService from '../mail/mail.service';
import { CreateContactDto } from './dto/contactForm.dto';

@Injectable()
export class ContactFormService {
  constructor(private readonly mailService: MailService) {}

  async handleContactForm(data: CreateContactDto) {
    console.log('--- START SENDING EMAIL ---');
    console.log('Data reaching service:', data);
    const mail = await this.mailService.sendContactLead({
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      message: data.message,
      company: 'ZenBit Lead',
    });
    console.log('--- EMAIL SENT SUCCESSFULLY ---');
    return mail;
  }
}
