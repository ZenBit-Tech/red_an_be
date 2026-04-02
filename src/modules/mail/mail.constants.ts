export const MAIL_STRATEGY = {
  RESEND: 'resend',
  GMAIL: 'gmail',
} as const;

export const MAIL_TEMPLATES = {
  MAGIC_LINK: 'magic-link-email',
  CONTACT_LEAD: 'contact-lead',
} as const;

export const MAIL_SUBJECTS = {
  MAGIC_LINK: 'Sign in to De-ID Studio',
  CONTACT_LEAD_PREFIX: 'New Lead Inquiry',
} as const;

export const MAGIC_LINK_PATH = '/auth/verify?token=';

export interface ContactLeadData {
  firstName: string;
  lastName: string;
  company: string;
  email: string;
  message: string;
}
