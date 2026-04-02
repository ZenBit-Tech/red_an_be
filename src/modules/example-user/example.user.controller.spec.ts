import { Test, TestingModule } from '@nestjs/testing';
import UserController from './example.user.controller';
import UserService from './example.user.service';
import MailService from '../mail/mail.service';
import { MAIL_TEMPLATES } from '../mail/mail.constants';
import { MAIL_TEST_MESSAGES } from './example.user.constants';

describe('UserController', () => {
  let controller: UserController;

  const userServiceMock = {
    create: jest.fn(),
    findAll: jest.fn(),
    findOne: jest.fn(),
    checkDbConnection: jest.fn(),
  };

  const mailServiceMock = {
    sendMagicLink: jest.fn(),
    sendContactLead: jest.fn(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UserController],
      providers: [
        { provide: UserService, useValue: userServiceMock },
        { provide: MailService, useValue: mailServiceMock },
      ],
    }).compile();

    controller = module.get<UserController>(UserController);
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('sendTestEmail', () => {
    it('should send magic-link template when template is magic-link-email', async () => {
      const response = await controller.sendTestEmail({
        email: 'target@example.com',
        template: MAIL_TEMPLATES.MAGIC_LINK,
        token: 'sample-token',
        firstName: undefined,
        lastName: undefined,
        company: undefined,
        message: undefined,
      });

      expect(mailServiceMock.sendMagicLink).toHaveBeenCalledWith(
        'target@example.com',
        'sample-token',
      );
      expect(mailServiceMock.sendContactLead).not.toHaveBeenCalled();
      expect(response).toEqual({ message: MAIL_TEST_MESSAGES.SENT });
    });

    it('should send contact-lead template when template is contact-lead', async () => {
      const response = await controller.sendTestEmail({
        email: 'lead@example.com',
        template: MAIL_TEMPLATES.CONTACT_LEAD,
        firstName: 'John',
        lastName: 'Doe',
        company: 'Nemo',
        message: 'Just my two cents on your service...',
      });

      expect(mailServiceMock.sendContactLead).toHaveBeenCalledWith({
        firstName: 'John',
        lastName: 'Doe',
        company: 'Nemo',
        email: 'lead@example.com',
        message: 'Just my two cents on your service...',
      });
      expect(mailServiceMock.sendMagicLink).not.toHaveBeenCalled();
      expect(response).toEqual({ message: MAIL_TEST_MESSAGES.SENT });
    });
  });
});
