import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { QueryFailedError, Repository } from 'typeorm';
import Stripe from 'stripe';

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
type SubscriptionRepositoryContract = Pick<Repository<Subscription>, 'upsert' | 'find'>;

describe('BillingService', () => {
  let service: BillingService;
  let stripeWebhookEventRepositoryMock: {
    insert: jest.Mock;
  };

  const userRepositoryMock: jest.Mocked<UserRepositoryContract> = {
    findOne: jest.fn(),
    update: jest.fn(),
  };

  const subscriptionRepositoryMock: jest.Mocked<SubscriptionRepositoryContract> = {
    upsert: jest.fn(),
    find: jest.fn(),
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

  it('should create checkout session with trial for first professional purchase', async () => {
    const createCheckoutSessionMock = jest
      .fn()
      .mockResolvedValue({ url: 'https://stripe.test/checkout' });
    const ensureStripeCustomerUser: User = {
      uuid: 'user-1',
      email: 'user@example.com',
      stripeCustomerId: 'cus_123',
      hasUsedProfessionalTrial: false,
      planTier: 'FREE',
      planStatus: 'INACTIVE',
      currentPeriodEnd: null,
      dailyLimit: 2,
      entitlementsUpdatedAt: null,
      timezone: 'UTC',
    };

    userRepositoryMock.findOne.mockResolvedValue(ensureStripeCustomerUser);

    Object.defineProperty(service, 'stripe', {
      value: {
        checkout: {
          sessions: {
            create: createCheckoutSessionMock,
          },
        },
      },
    });

    const result = await service.createCheckoutSession('user-1', 'PROFESSIONAL');

    expect(result).toEqual({ url: 'https://stripe.test/checkout' });
    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'subscription',
        customer: 'cus_123',
        subscription_data: expect.objectContaining({
          trial_period_days: 3,
        }),
      }),
    );
  });

  it('should create checkout session without trial after trial was used', async () => {
    const createCheckoutSessionMock = jest
      .fn()
      .mockResolvedValue({ url: 'https://stripe.test/checkout' });
    const returningUser: User = {
      uuid: 'user-2',
      email: 'returning@example.com',
      stripeCustomerId: 'cus_456',
      hasUsedProfessionalTrial: true,
      planTier: 'FREE',
      planStatus: 'INACTIVE',
      currentPeriodEnd: null,
      dailyLimit: 2,
      entitlementsUpdatedAt: null,
      timezone: 'UTC',
    };

    userRepositoryMock.findOne.mockResolvedValue(returningUser);

    Object.defineProperty(service, 'stripe', {
      value: {
        checkout: {
          sessions: {
            create: createCheckoutSessionMock,
          },
        },
      },
    });

    await service.createCheckoutSession('user-2', 'PROFESSIONAL');

    expect(createCheckoutSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        subscription_data: expect.not.objectContaining({
          trial_period_days: expect.anything(),
        }),
      }),
    );
  });

  it('should mark professional trial as used when syncing subscription from Stripe', async () => {
    const subscription = {
      id: 'sub_123',
      customer: 'cus_123',
      status: 'trialing',
      cancel_at_period_end: false,
      metadata: { userId: 'user-1' },
      items: {
        data: [
          {
            current_period_end: 1_800_000_000,
            price: { id: TEST_STRIPE_PRO_PRICE_ID },
          },
        ],
      },
    } as unknown as Stripe.Subscription;

    await service.upsertSubscriptionFromStripe(subscription);

    expect(subscriptionRepositoryMock.upsert).toHaveBeenCalledTimes(1);
    expect(userRepositoryMock.update).toHaveBeenCalledWith(
      { uuid: 'user-1' },
      expect.objectContaining({
        hasUsedProfessionalTrial: true,
        planTier: 'PROFESSIONAL',
        planStatus: 'ACTIVE',
      }),
    );
  });

  it('should throw when checkout session is requested for unknown user', async () => {
    userRepositoryMock.findOne.mockResolvedValue(null);

    await expect(service.createCheckoutSession('missing-user', 'PROFESSIONAL')).rejects.toThrow(
      NotFoundException,
    );
  });

  it('should return TRIAL phase with remaining trial days in billing status', async () => {
    const now = Date.now();
    const trialEnd = new Date(now + 2 * 24 * 60 * 60 * 1000 + 60 * 1000);
    const trialingUser: User = {
      uuid: 'trial-user',
      email: 'trial@example.com',
      stripeCustomerId: null,
      hasUsedProfessionalTrial: true,
      planTier: 'PROFESSIONAL',
      planStatus: 'ACTIVE',
      currentPeriodEnd: trialEnd,
      dailyLimit: null,
      entitlementsUpdatedAt: new Date(now),
      timezone: 'UTC',
    };

    const subscription: Subscription = {
      id: 'subscription-trial',
      userId: 'trial-user',
      stripeSubscriptionId: 'sub_trial',
      stripeCustomerId: 'cus_trial',
      stripePriceId: TEST_STRIPE_PRO_PRICE_ID,
      status: 'trialing',
      currentPeriodEnd: trialEnd,
      cancelAtPeriodEnd: false,
      createdAt: new Date(now - 1000),
      updatedAt: new Date(now - 1000),
    };

    userRepositoryMock.findOne.mockResolvedValue(trialingUser);
    subscriptionRepositoryMock.find.mockResolvedValue([subscription]);

    const status = await service.getBillingStatus('trial-user');

    expect(status.billingPhase).toBe('TRIAL');
    expect(status.isTrialing).toBe(true);
    expect(status.trialEndsAt?.toISOString()).toBe(trialEnd.toISOString());
    expect(status.trialDaysLeft).toBe(3);
  });

  it('should return PAID phase with null trial metadata in billing status', async () => {
    const now = Date.now();
    const paidPeriodEnd = new Date(now + 10 * 24 * 60 * 60 * 1000);
    const paidUser: User = {
      uuid: 'paid-user',
      email: 'paid@example.com',
      stripeCustomerId: 'cus_paid',
      hasUsedProfessionalTrial: true,
      planTier: 'PROFESSIONAL',
      planStatus: 'ACTIVE',
      currentPeriodEnd: paidPeriodEnd,
      dailyLimit: null,
      entitlementsUpdatedAt: new Date(now),
      timezone: 'UTC',
    };

    const subscription: Subscription = {
      id: 'subscription-paid',
      userId: 'paid-user',
      stripeSubscriptionId: 'sub_paid',
      stripeCustomerId: 'cus_paid',
      stripePriceId: TEST_STRIPE_PRO_PRICE_ID,
      status: 'active',
      currentPeriodEnd: paidPeriodEnd,
      cancelAtPeriodEnd: false,
      createdAt: new Date(now - 2000),
      updatedAt: new Date(now - 2000),
    };

    userRepositoryMock.findOne.mockResolvedValue(paidUser);
    subscriptionRepositoryMock.find.mockResolvedValue([subscription]);

    const status = await service.getBillingStatus('paid-user');

    expect(status.billingPhase).toBe('PAID');
    expect(status.isTrialing).toBe(false);
    expect(status.trialEndsAt).toBeNull();
    expect(status.trialDaysLeft).toBeNull();
  });
});
