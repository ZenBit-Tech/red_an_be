import { Test, TestingModule } from '@nestjs/testing';
import { Repository } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import UserService from './example.user.service';
import TemplateUser from '../../common/db/entities/example.user.entity';

describe('UserService', () => {
  let service: UserService;
  let repo: Repository<TemplateUser>;

  const mockUser: TemplateUser = {
    uuid: '1234',
    email: 'test@example.com',
  };

  const mockRepository = {
    createQueryBuilder: jest.fn(() => ({
      getMany: jest.fn().mockResolvedValue([mockUser]),
      getOne: jest.fn().mockResolvedValue(mockUser),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({ identifiers: [{ uuid: mockUser.uuid }] }),
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      getRawOne: jest.fn().mockResolvedValue({ queryResult: '1' }),
    })),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UserService,
        { provide: getRepositoryToken(TemplateUser), useValue: mockRepository },
      ],
    }).compile();

    service = module.get<UserService>(UserService);
    repo = module.get<Repository<TemplateUser>>(getRepositoryToken(TemplateUser));
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('findAll', () => {
    it('should return an array of users', async () => {
      const users = await service.findAll();
      expect(users).toEqual([mockUser]);
      expect(repo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should throw InternalServerErrorException on error', async () => {
      (repo.createQueryBuilder as jest.Mock).mockImplementationOnce(() => {
        throw new Error();
      });
      await expect(service.findAll()).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('findOne', () => {
    it('should return a user by uuid', async () => {
      const user = await service.findOne('1234');
      expect(user).toEqual(mockUser);
      expect(repo.createQueryBuilder).toHaveBeenCalled();
    });

    it('should throw NotFoundException if user not found', async () => {
      (repo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        getOne: jest.fn().mockResolvedValue(null),
        where: jest.fn().mockReturnThis(),
      });

      await expect(service.findOne('not-found')).rejects.toThrow(NotFoundException);
    });

    it('should throw InternalServerErrorException on unexpected error', async () => {
      (repo.createQueryBuilder as jest.Mock).mockImplementationOnce(() => {
        throw new Error();
      });
      await expect(service.findOne('1234')).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('createUser', () => {
    it('should create and return a user', async () => {
      const user = await service.create({
        email: 'test@example.com',
      });
      expect(user).toEqual(mockUser);
    });

    it('should throw InternalServerErrorException if insert fails', async () => {
      (repo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        insert: jest.fn().mockReturnThis(),
        into: jest.fn().mockReturnThis(),
        values: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue({ identifiers: [] }),
      });

      await expect(
        service.create({
          email: 'fail@example.com',
        }),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });

  describe('checkDbConnection', () => {
    it('should return DB health check result', async () => {
      (repo.createQueryBuilder as jest.Mock).mockReturnValueOnce({
        select: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        getRawOne: jest.fn().mockResolvedValue({ queryResult: '1' }),
      });

      await expect(service.checkDbConnection()).resolves.toEqual({
        status: 'Database connection is healthy',
        queryResult: 1,
      });
    });
  });
});
