import { ConfigService } from '@nestjs/config';
import { QueryFailedError, Repository } from 'typeorm';
import DailyUsage from '@common/db/entities/daily-usage.entity';
import Subscription from '@common/db/entities/subscription.entity';
import StripeWebhookEvent from '@common/db/entities/stripe-webhook-event.entity';
import User from '@common/db/entities/user.entity';
import BillingService from './billing.service';

const TEST_SECRET = 'test_secret';
const TEST_WEBHOOK_SECRET = 'whsec_test';
const TEST_FRONTEND_DOMAIN = 'http://localhost:5173';
const TEST_STRIPE_PRO_PRICE_ID = 'price_test_professional';

type UserRepositoryContract = Pick<Repository<User>, 'findOne' | 'update'>;
type SubscriptionRepositoryContract = Pick<Repository<Subscription>, 'upsert'>;

describe('BillingService', () => {
  let service: BillingService;
  let stripeWebhookEventRepositoryMock: {
    insert: jest.Mock;
  };

  beforeEach(() => {
    const configServiceMock: Pick<ConfigService, 'getOrThrow'> = {
      getOrThrow: jest.fn((key: string) => {
        if (key === 'STRIPE_SECRET_KEY') {
          return TEST_SECRET;
        }
        if (key === 'STRIPE_WEBHOOK_SECRET') {
          return TEST_WEBHOOK_SECRET;
        }
        if (key === 'FRONTEND_DOMAIN') {
          return TEST_FRONTEND_DOMAIN;
        }
        if (key === 'STRIPE_PRO_PRICE_ID') {
          return TEST_STRIPE_PRO_PRICE_ID;
        }
        throw new Error(`Unexpected config key: ${key}`);
      }),
    };

    const userRepositoryMock: UserRepositoryContract = {
      findOne: jest.fn(),
      update: jest.fn(),
    };

    const subscriptionRepositoryMock: SubscriptionRepositoryContract = {
      upsert: jest.fn(),
    };

    const dailyUsageRepositoryMock: Pick<Repository<DailyUsage>, 'findOne' | 'manager'> = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn(),
      } as unknown as Repository<DailyUsage>['manager'],
    };

    stripeWebhookEventRepositoryMock = {
      insert: jest.fn(),
    };

    service = new BillingService(
      configServiceMock as ConfigService,
      userRepositoryMock as unknown as Repository<User>,
      subscriptionRepositoryMock as unknown as Repository<Subscription>,
      stripeWebhookEventRepositoryMock as unknown as Repository<StripeWebhookEvent>,
      dailyUsageRepositoryMock as unknown as Repository<DailyUsage>,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should return true when webhook event is inserted', async () => {
    stripeWebhookEventRepositoryMock.insert.mockResolvedValue({});

    const result = await service.claimWebhookEvent('evt_new_1');

    expect(stripeWebhookEventRepositoryMock.insert).toHaveBeenCalledTimes(1);
    expect(stripeWebhookEventRepositoryMock.insert).toHaveBeenCalledWith({
      stripeEventId: 'evt_new_1',
    });
    expect(result).toBe(true);
  });

  it('should return false when webhook event is duplicate', async () => {
    const duplicateError = Object.assign(
      new QueryFailedError(
        'INSERT INTO stripe_webhook_events ...',
        [],
        new Error('Duplicate entry'),
      ),
      { code: 'ER_DUP_ENTRY' },
    );

    stripeWebhookEventRepositoryMock.insert.mockRejectedValue(duplicateError);

    const result = await service.claimWebhookEvent('evt_dup_1');

    expect(result).toBe(false);
  });

  it('should rethrow non-duplicate database errors', async () => {
    const dbError = Object.assign(
      new QueryFailedError('INSERT INTO stripe_webhook_events ...', [], new Error('DB failure')),
      { code: 'ER_PARSE_ERROR' },
    );

    stripeWebhookEventRepositoryMock.insert.mockRejectedValue(dbError);

    await expect(service.claimWebhookEvent('evt_fail_1')).rejects.toThrow(QueryFailedError);
  });
});
