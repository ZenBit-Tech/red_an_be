import { Injectable } from '@nestjs/common';
import MailService from '../mail/mail.service';
import { CreateContactDto } from './dto/contactForm.dto';
import { ContactLeadData } from '../mail/mail.constants';

@Injectable()
export class ContactFormService {
  constructor(private readonly mailService: MailService) {}

  async handleContactForm(data: CreateContactDto) {
    const leadData: ContactLeadData = {
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email,
      message: data.message,
      phone: data.phone,
    };
    await this.mailService.sendContactLead(leadData);

    return {
      status: 'success',
      message: 'Email sent successfully',
    };
  }
}
