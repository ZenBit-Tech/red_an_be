import {
  Body,
  Controller,
  Get,
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
import CreateUserDto from './dto/createExampleUser.dto';
import ReturnUserDto from './dto/returnExampleUser.dto';

import {
  EXAMPLE_USER_ROUTE,
  EXAMPLE_USER_TAG,
  EXAMPLE_USER_MESSAGES,
} from './example.user.constants';

type DbHealthResponse = {
  status: string;
  queryResult: number;
};

@ApiTags(EXAMPLE_USER_TAG)
@UseInterceptors(ClassSerializerInterceptor)
@Controller(EXAMPLE_USER_ROUTE)
export default class UserController {
  constructor(private readonly userService: UserService) {}

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
    return (await this.userService.create(body)) as ReturnUserDto;
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
    return (await this.userService.findAll()) as ReturnUserDto[];
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
    return (await this.userService.findOne(uuid)) as ReturnUserDto;
  }

  @ApiOperation({ summary: 'Check database connection using QueryBuilder select' })
  @ApiOkResponse({ description: EXAMPLE_USER_MESSAGES.DB_CONNECTION_OK })
  @ApiInternalServerErrorResponse({ description: 'Database connection check failed' })
  @Get('health/db')
  async checkDbConnection(): Promise<DbHealthResponse> {
    return (await this.userService.checkDbConnection()) as DbHealthResponse;
  }
}
