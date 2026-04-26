# Contributing

## Creating a New Module

Follow the `user` pattern:

1. Create folder: `src/modules/<your-module>/`
2. Add `dto/`, `*.entity.ts` in `common/db/entities/`
3. Create `*.module.ts`, `*.controller.ts`, `*.service.ts`
4. Register entity in `datasource.ts` -> `entities: [...]`
5. Import your module in `app.module.ts`
6. Generate a migration: `npm run migration:generate src/migrations/<name>`

---

## Mail Service

`MailService` supports two delivery strategies: **Resend** and **Gmail (SMTP)**. It renders HTML emails with **Handlebars** templates.

### Configuration

Add the following to your `.env`:

```env
# Choose 'resend' or 'gmail'
MAIL_STRATEGY=resend

# Resend
RESEND_API_KEY=re_your_api_key_here

# Gmail
GMAIL_USER=your@gmail.com
GMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx

# Shared
SMTP_FROM=App Name <no-reply@yourdomain.com>
FRONTEND_DOMAIN=https://your-frontend.com
SALES_EMAIL=sales@yourcompany.com
```

### Available Methods

| Method                        | Template                | Description                                        |
| ----------------------------- | ----------------------- | -------------------------------------------------- |
| `sendMagicLink(email, token)` | `magic-link-email.html` | Passwordless sign-in / password reset              |
| `sendContactLead(clientData)` | `contact-lead.html`     | Forwards a contact-form inquiry to the sales inbox |

### Usage Example

```ts
import { Controller, Post, Body } from '@nestjs/common';
import MailService from '../mail/mail.service';
import { ContactLeadData } from '../mail/mail.constants';

@Controller('auth')
export class AuthController {
  constructor(private readonly mailService: MailService) {}

  @Post('magic-link')
  async requestMagicLink(@Body('email') email: string) {
    const token = '...'; // generate a secure JWT / OTP token
    await this.mailService.sendMagicLink(email, token);
    return { message: 'Magic link sent' };
  }
}

@Controller('support')
export class SupportController {
  constructor(private readonly mailService: MailService) {}

  @Post('contact')
  async handleInquiry(@Body() data: ContactLeadData) {
    await this.mailService.sendContactLead(data);
    return { message: 'Inquiry received' };
  }
}
```

### Resend Setup

1. Create an account at [resend.com](https://resend.com).
2. Go to **Dashboard -> API Keys** and create a new key.
3. (Optional) Verify your sending domain under **Domains**.
4. Set `RESEND_API_KEY` and `SMTP_FROM` in `.env`.

### Gmail (SMTP) Setup

> A regular Google password will not work - you must use an App Password.

1. Enable **2-Step Verification** on your Google account.
2. Go to **Google Account -> Security -> App Passwords**.
3. Create a password (e.g. "NestJS Mailer") and copy the 16-character code.
4. Set `GMAIL_USER`, `GMAIL_APP_PASSWORD`, and `SMTP_FROM` in `.env`.

### Adding a New Template

1. Create `src/templates/<name>.html` using Handlebars syntax (`{{variable}}`).
2. Add the template name to `MAIL_TEMPLATES` in `mail.constants.ts`.
3. Add a public method to `MailService` that calls `sendEmailWithTemplate`.
