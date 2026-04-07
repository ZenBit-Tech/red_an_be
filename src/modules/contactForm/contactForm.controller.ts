import { Controller, Post, Body } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { ContactFormService } from './contactForm.service';
import { CreateContactDto } from './dto/contactForm.dto';

@Controller('contact-us')
export class ContactFormController {
  constructor(private readonly contactFormService: ContactFormService) {}

  @Post()
  @ApiOperation({ summary: 'Send contact us form' })
  @ApiResponse({ status: 201, description: 'Success' })
  @ApiResponse({ status: 400, description: 'Bad Request (Validation Error)' })
  @ApiResponse({ status: 500, description: 'Internal Server Error' })
  async create(@Body() createContactDto: CreateContactDto) {
    return this.contactFormService.handleContactForm(createContactDto);
  }
}
