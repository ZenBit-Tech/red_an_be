import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import isMySqlError from '../../common/utils/isMySqlError';
import TemplateUser from '../../common/db/entities/example.user.entity';
import CreateExampleUserDto from './dto/createExampleUser.dto';
import {
  EXAMPLE_USER_ALIASES,
  EXAMPLE_USER_ERRORS,
  EXAMPLE_USER_MESSAGES,
  MYSQL_ERROR_CODES,
} from './example.user.constants';

type DbHealthCheckResult = {
  status: string;
  queryResult: number;
};

@Injectable()
export default class ExampleUserService {
  constructor(
    @InjectRepository(TemplateUser)
    private userRepository: Repository<TemplateUser>,
  ) {}

  async findAll(): Promise<TemplateUser[]> {
    try {
      return await this.userRepository
        .createQueryBuilder(EXAMPLE_USER_ALIASES.ENTITY_ALIAS)
        .getMany();
    } catch (error) {
      throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.FETCH_ALL_FAILED);
    }
  }

  async findOne(uuid: string): Promise<TemplateUser> {
    try {
      const user = await this.userRepository
        .createQueryBuilder(EXAMPLE_USER_ALIASES.ENTITY_ALIAS)
        .where(`${EXAMPLE_USER_ALIASES.ENTITY_ALIAS}.uuid = :uuid`, { uuid })
        .getOne();

      if (!user) {
        throw new NotFoundException(EXAMPLE_USER_ERRORS.NOT_FOUND.replace('%uuid%', uuid));
      }

      return user;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.FETCH_ONE_FAILED);
    }
  }

  async create(payload: CreateExampleUserDto): Promise<TemplateUser> {
    try {
      const insertResult = await this.userRepository
        .createQueryBuilder()
        .insert()
        .into(TemplateUser)
        .values([{ email: payload.email }])
        .execute();

      const userId: string = insertResult.identifiers[0]?.uuid;
      if (!userId) {
        throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.CREATED_ID_MISSING);
      }

      const user = await this.findOne(userId);
      if (!user) {
        throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.CREATED_USER_MISSING);
      }

      return user;
    } catch (error: unknown) {
      if (isMySqlError(error) && error.code === MYSQL_ERROR_CODES.DUPLICATE_ENTRY) {
        throw new ConflictException(EXAMPLE_USER_ERRORS.DUPLICATE_EMAIL);
      }

      throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.CREATE_FAILED);
    }
  }

  async checkDbConnection(): Promise<DbHealthCheckResult> {
    try {
      const result = await this.userRepository
        .createQueryBuilder(EXAMPLE_USER_ALIASES.ENTITY_ALIAS)
        .select('1', 'queryResult')
        .limit(1)
        .getRawOne<{ queryResult: string }>();

      return {
        status: EXAMPLE_USER_MESSAGES.DB_CONNECTION_OK,
        queryResult: Number(result?.queryResult ?? 0),
      };
    } catch (error) {
      throw new InternalServerErrorException(EXAMPLE_USER_ERRORS.DB_CONNECTION_FAILED);
    }
  }
}
