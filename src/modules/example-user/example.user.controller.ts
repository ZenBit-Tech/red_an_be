import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Param,
  ParseUUIDPipe,
  UseInterceptors,
  ClassSerializerInterceptor,
  SerializeOptions,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiBadRequestResponse,
  ApiCreatedResponse,
  ApiFoundResponse,
  ApiInternalServerErrorResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import UserService from './example.user.service';
import MailService from '../mail/mail.service';
import CreateUserDto from './dto/createExampleUser.dto';
import ReturnUserDto from './dto/returnExampleUser.dto';
import SendTestEmailDto from './dto/sendTestEmail.dto';
import { MAIL_TEMPLATES } from '../mail/mail.constants';
import {
  EXAMPLE_USER_ROUTE,
  EXAMPLE_USER_TAG,
  EXAMPLE_USER_MESSAGES,
  MAIL_TEST_ROUTE,
  MAIL_TEST_MESSAGES,
} from './example.user.constants';

type DbHealthResponse = {
  status: string;
  queryResult: number;
};

@ApiTags(EXAMPLE_USER_TAG)
@UseInterceptors(ClassSerializerInterceptor)
@Controller(EXAMPLE_USER_ROUTE)
export default class UserController {
  constructor(
    private readonly userService: UserService,
    private readonly mailService: MailService,
  ) {}

  @ApiOperation({ summary: 'Create a new template user' })
  @ApiCreatedResponse({
    description: 'User successfully created',
    type: ReturnUserDto,
  })
  @ApiBadRequestResponse({ description: 'Validation failed for request payload' })
  @ApiConflictResponse({ description: 'Email already exists' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  @SerializeOptions({ type: ReturnUserDto })
  @Post()
  async create(@Body() body: CreateUserDto): Promise<ReturnUserDto> {
    return this.userService.create(body);
  }

  @ApiOperation({ summary: 'Get all template users' })
  @ApiOkResponse({
    description: 'Users retrieved successfully',
    type: ReturnUserDto,
    isArray: true,
  })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  @SerializeOptions({ type: ReturnUserDto })
  @Get()
  async getAll(): Promise<ReturnUserDto[]> {
    return this.userService.findAll();
  }

  @ApiOperation({ summary: 'Get user by uuid' })
  @ApiFoundResponse({
    description: 'User found successfully',
    type: ReturnUserDto,
  })
  @ApiNotFoundResponse({
    description: 'User with specified uuid not found',
  })
  @ApiBadRequestResponse({ description: 'Invalid uuid parameter' })
  @ApiInternalServerErrorResponse({ description: 'Unexpected server error' })
  @SerializeOptions({ type: ReturnUserDto })
  @Get(':uuid')
  async getByUuid(@Param('uuid', new ParseUUIDPipe()) uuid: string): Promise<ReturnUserDto> {
    return this.userService.findOne(uuid);
  }

  @ApiOperation({ summary: 'Check database connection using QueryBuilder select' })
  @ApiOkResponse({ description: EXAMPLE_USER_MESSAGES.DB_CONNECTION_OK })
  @ApiInternalServerErrorResponse({ description: 'Database connection check failed' })
  @Get('health/db')
  async checkDbConnection(): Promise<DbHealthResponse> {
    return this.userService.checkDbConnection();
  }

  @ApiOperation({ summary: 'Send a test email to verify mail service configuration' })
  @ApiOkResponse({ description: MAIL_TEST_MESSAGES.SENT })
  @ApiBadRequestResponse({ description: 'Validation failed for request payload' })
  @ApiInternalServerErrorResponse({ description: 'Failed to send test email' })
  @HttpCode(HttpStatus.OK)
  @Post(MAIL_TEST_ROUTE)
  async sendTestEmail(@Body() body: SendTestEmailDto): Promise<{ message: string }> {
    if (body.template === MAIL_TEMPLATES.CONTACT_LEAD) {
      await this.mailService.sendContactLead({
        firstName: 'Test',
        lastName: 'User',
        company: 'Test Company',
        email: body.email,
        message: body.token,
      });
    } else {
      await this.mailService.sendMagicLink(body.email, body.token);
    }

    return { message: MAIL_TEST_MESSAGES.SENT };
  }
}
