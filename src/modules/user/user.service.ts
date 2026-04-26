import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import User from '@db/entities/user.entity';
import isMySqlError from '@common/utils/isMySqlError';
import CreateUserDto from './dto/createUser.dto';
import { USER_ALIASES, USER_ERRORS, USER_MESSAGES, MYSQL_ERROR_CODES } from './user.constants';

type DbHealthCheckResult = {
  status: string;
  queryResult: number;
};

@Injectable()
export default class UserService {
  constructor(
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async findAll(): Promise<User[]> {
    try {
      return await this.userRepository.createQueryBuilder(USER_ALIASES.ENTITY_ALIAS).getMany();
    } catch (error) {
      throw new InternalServerErrorException(USER_ERRORS.FETCH_ALL_FAILED);
    }
  }

  async findOne(uuid: string): Promise<User> {
    try {
      const user = await this.userRepository
        .createQueryBuilder(USER_ALIASES.ENTITY_ALIAS)
        .where(`${USER_ALIASES.ENTITY_ALIAS}.uuid = :uuid`, { uuid })
        .getOne();

      if (!user) {
        throw new NotFoundException(USER_ERRORS.NOT_FOUND.replace('%uuid%', uuid));
      }

      return user;
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      throw new InternalServerErrorException(USER_ERRORS.FETCH_ONE_FAILED);
    }
  }

  async create(payload: CreateUserDto): Promise<User> {
    try {
      const insertResult = await this.userRepository
        .createQueryBuilder()
        .insert()
        .into(User)
        .values([{ email: payload.email }])
        .execute();

      const userId: string = insertResult.identifiers[0]?.uuid;
      if (!userId) {
        throw new InternalServerErrorException(USER_ERRORS.CREATED_ID_MISSING);
      }

      const user = await this.findOne(userId);
      if (!user) {
        throw new InternalServerErrorException(USER_ERRORS.CREATED_USER_MISSING);
      }

      return user;
    } catch (error: unknown) {
      if (isMySqlError(error) && error.code === MYSQL_ERROR_CODES.DUPLICATE_ENTRY) {
        throw new ConflictException(USER_ERRORS.DUPLICATE_EMAIL);
      }

      throw new InternalServerErrorException(USER_ERRORS.CREATE_FAILED);
    }
  }

  async checkDbConnection(): Promise<DbHealthCheckResult> {
    try {
      const result = await this.userRepository
        .createQueryBuilder(USER_ALIASES.ENTITY_ALIAS)
        .select('1', 'queryResult')
        .limit(1)
        .getRawOne<{ queryResult: string }>();

      return {
        status: USER_MESSAGES.DB_CONNECTION_OK,
        queryResult: Number(result?.queryResult ?? 0),
      };
    } catch (error) {
      throw new InternalServerErrorException(USER_ERRORS.DB_CONNECTION_FAILED);
    }
  }
}
