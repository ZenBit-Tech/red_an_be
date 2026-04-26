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
import UserService from './user.service';
import CreateUserDto from './dto/createUser.dto';
import ReturnUserDto from './dto/returnUser.dto';
import { USER_ROUTE, USER_TAG, USER_MESSAGES } from './user.constants';

type DbHealthResponse = {
  status: string;
  queryResult: number;
};

@ApiTags(USER_TAG)
@UseInterceptors(ClassSerializerInterceptor)
@Controller(USER_ROUTE)
export default class UserController {
  constructor(private readonly userService: UserService) {}

  @ApiOperation({ summary: 'Create a new user' })
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

  @ApiOperation({ summary: 'Get all users' })
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
  @ApiOkResponse({ description: USER_MESSAGES.DB_CONNECTION_OK })
  @ApiInternalServerErrorResponse({ description: 'Database connection check failed' })
  @Get('health/db')
  async checkDbConnection(): Promise<DbHealthResponse> {
    return this.userService.checkDbConnection();
  }
}
