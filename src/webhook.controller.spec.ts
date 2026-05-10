import { BadRequestException } from '@nestjs/common';
import Stripe from 'stripe';
import { BILLING_ERRORS, STRIPE_EVENTS } from '@common/constants/billing.constants';
import BillingService from './modules/billing/billing.service';
import WebhookController from './webhook.controller';

type BillingServiceContract = Pick<
  BillingService,
  'verifyWebhookSignature' | 'claimWebhookEvent' | 'upsertSubscriptionFromStripe'
>;

const RAW_BODY = Buffer.from('payload');
const SIGNATURE = 'sig_header';

describe('WebhookController', () => {
  let controller: WebhookController;
  let billingServiceMock: {
    verifyWebhookSignature: jest.Mock;
    claimWebhookEvent: jest.Mock;
    upsertSubscriptionFromStripe: jest.Mock;
  };

  beforeEach(() => {
    billingServiceMock = {
      verifyWebhookSignature: jest.fn(),
      claimWebhookEvent: jest.fn(),
      upsertSubscriptionFromStripe: jest.fn(),
    };

    controller = new WebhookController(
      billingServiceMock as unknown as BillingServiceContract as BillingService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should throw BadRequestException when raw body is missing', async () => {
    await expect(
      controller.handleStripeWebhook({} as Request & { rawBody?: Buffer }, SIGNATURE),
    ).rejects.toThrow(new BadRequestException(BILLING_ERRORS.WEBHOOK_RAW_BODY_MISSING));
  });

  it('should throw BadRequestException when signature verification fails', async () => {
    billingServiceMock.verifyWebhookSignature.mockImplementation(() => {
      throw new Error('invalid signature');
    });

    await expect(
      controller.handleStripeWebhook(
        { rawBody: RAW_BODY } as Request & { rawBody?: Buffer },
        SIGNATURE,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(billingServiceMock.claimWebhookEvent).not.toHaveBeenCalled();
  });

  it('should return duplicate response when event is already processed', async () => {
    const event = {
      id: 'evt_dup_1',
      type: STRIPE_EVENTS.CHECKOUT_COMPLETED,
      data: { object: { id: 'cs_test_1' } },
    } as unknown as Stripe.Event;

    billingServiceMock.verifyWebhookSignature.mockReturnValue(event);
    billingServiceMock.claimWebhookEvent.mockResolvedValue(false);

    const result = await controller.handleStripeWebhook(
      { rawBody: RAW_BODY } as Request & { rawBody?: Buffer },
      SIGNATURE,
    );

    expect(result).toEqual({ received: true, duplicate: true });
    expect(billingServiceMock.upsertSubscriptionFromStripe).not.toHaveBeenCalled();
  });

  it('should process subscription event when event is new', async () => {
    const subscription = { id: 'sub_1' } as Stripe.Subscription;
    const event = {
      id: 'evt_new_1',
      type: STRIPE_EVENTS.SUBSCRIPTION_CREATED,
      data: { object: subscription },
    } as unknown as Stripe.Event;

    billingServiceMock.verifyWebhookSignature.mockReturnValue(event);
    billingServiceMock.claimWebhookEvent.mockResolvedValue(true);
    billingServiceMock.upsertSubscriptionFromStripe.mockResolvedValue(undefined);

    const result = await controller.handleStripeWebhook(
      { rawBody: RAW_BODY } as Request & { rawBody?: Buffer },
      SIGNATURE,
    );

    expect(result).toEqual({ received: true });
    expect(billingServiceMock.upsertSubscriptionFromStripe).toHaveBeenCalledTimes(1);
    expect(billingServiceMock.upsertSubscriptionFromStripe).toHaveBeenCalledWith(subscription);
  });
});
