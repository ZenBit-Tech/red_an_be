import { Controller, Post, Body } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import MailService from './mail.service';

import { SubmitContactFormDto } from './dto/submitForm.dto';

@Controller()
export class MailController {
  constructor(private readonly mailService: MailService) {}

  @Post('contact-form')
  @ApiOperation({ summary: 'Send contact us form' })
  @ApiResponse({ status: 201, description: 'Success' })
  @ApiResponse({ status: 400, description: 'Bad Request (Validation Error)' })
  @ApiResponse({ status: 500, description: 'Internal Server Error' })
  async handleContactForm(@Body() dto: SubmitContactFormDto): Promise<void> {
    return this.mailService.sendContactLead(dto);
  }
}
