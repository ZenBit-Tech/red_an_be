import { Controller, Post, Body } from '@nestjs/common';
import { ContactFormService } from './contactForm.service';
import { CreateContactDto } from './dto/contactForm.dto';

@Controller('contact-us')
export class ContactFormController {
  constructor(private readonly contactFormService: ContactFormService) {}

  @Post()
  async create(@Body() createContactDto: CreateContactDto) {
    return this.contactFormService.handleContactForm(createContactDto);
  }
}
