import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import TemplateUser from '@db/entities/user.entity';
import CreateUserDto from './dto/createExampleUser.dto';

@Injectable()
export default class UserService {
  constructor(
    @InjectRepository(TemplateUser)
    private readonly userRepository: Repository<TemplateUser>,
    private readonly dataSource: DataSource,
  ) {}

  async create(dto: CreateUserDto): Promise<TemplateUser> {
    const existing = await this.userRepository.findOne({ where: { email: dto.email } });
    if (existing) {
      throw new ConflictException('Email already exists');
    }

    const user = this.userRepository.create(dto);
    return this.userRepository.save(user);
  }

  async findAll(): Promise<TemplateUser[]> {
    return this.userRepository.find();
  }

  async findOne(uuid: string): Promise<TemplateUser> {
    const user = await this.userRepository.findOne({ where: { uuid } });
    if (!user) {
      throw new NotFoundException(`User with uuid ${uuid} not found`);
    }
    return user;
  }

  async checkDbConnection(): Promise<{ status: string; queryResult: number }> {
    try {
      const result = await this.dataSource
        .createQueryBuilder()
        .select('1 + 1', 'result')
        .getRawOne<{ result: number }>();

      return {
        status: 'ok',
        queryResult: result?.result ?? 0,
      };
    } catch {
      throw new InternalServerErrorException('Database connection check failed');
    }
  }
}
