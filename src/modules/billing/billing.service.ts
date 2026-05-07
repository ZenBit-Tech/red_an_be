import {
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe from 'stripe';

import TemplateUser from '@db/entities/user.entity';
import Subscription, { SubscriptionStatus } from '@db/entities/subscription.entity';

import { BILLING_ENV, BILLING_ERRORS, BILLING_PATHS } from '@common/constants/billing.constants';

type CreateCheckoutSessionResult = { url: string };

@Injectable()
export default class BillingService {
  private readonly logger = new Logger(BillingService.name);

  private readonly stripe: Stripe;

  private readonly frontendDomain: string;

  private readonly webhookSecret: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(TemplateUser)
    private readonly userRepository: Repository<TemplateUser>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
  ) {
    const secretKey = this.configService.getOrThrow<string>(BILLING_ENV.STRIPE_SECRET_KEY);
    this.webhookSecret = this.configService.getOrThrow<string>(BILLING_ENV.STRIPE_WEBHOOK_SECRET);
    this.frontendDomain = this.configService.getOrThrow<string>(BILLING_ENV.FRONTEND_DOMAIN);
    this.stripe = new Stripe(secretKey);
  }

  public async createCheckoutSession(
    userId: string,
    priceId: string,
  ): Promise<CreateCheckoutSessionResult> {
    try {
      const user = await this.userRepository.findOne({ where: { uuid: userId } });
      if (!user) {
        throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
      }

      const stripeCustomerId = await this.ensureStripeCustomer(user);

      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: priceId, quantity: 1 }],
        success_url: `${this.frontendDomain}${BILLING_PATHS.SUCCESS}`,
        cancel_url: `${this.frontendDomain}${BILLING_PATHS.CANCEL}`,
        metadata: { userId },
        subscription_data: { metadata: { userId } },
      });

      if (!session.url) {
        throw new InternalServerErrorException(BILLING_ERRORS.CHECKOUT_URL_MISSING);
      }

      return { url: session.url };
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Checkout session creation failed: ${message}`);
      throw new InternalServerErrorException(BILLING_ERRORS.CHECKOUT_FAILED);
    }
  }

  public async upsertSubscriptionFromStripe(subscription: Stripe.Subscription): Promise<void> {
    const userId = subscription.metadata?.userId;
    if (!userId) {
      this.logger.error(`No userId in subscription.metadata for subscription ${subscription.id}`);
      return;
    }

    await this.subscriptionRepository.upsert(
      {
        userId,
        stripeCustomerId: subscription.customer as string,
        stripeSubscriptionId: subscription.id,
        stripePriceId: subscription.items.data[0].price.id,
        status: subscription.status as SubscriptionStatus,
        currentPeriodEnd: new Date(subscription.items.data[0].current_period_end * 1000),
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      ['stripeSubscriptionId'],
    );

    this.logger.log(
      `Subscription ${subscription.id} upserted for user ${userId} (status: ${subscription.status})`,
    );
  }

  public verifyWebhookSignature(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  private async ensureStripeCustomer(user: TemplateUser): Promise<string> {
    if (user.stripeCustomerId) {
      return user.stripeCustomerId;
    }

    const customer = await this.stripe.customers.create({
      email: user.email,
      metadata: { userId: user.uuid ?? null },
    });

    await this.userRepository.update({ uuid: user.uuid }, { stripeCustomerId: customer.id });
    return customer.id;
  }

  public async getCheckoutSessionStatus(
    userId: string,
    sessionId: string,
  ): Promise<{ status: 'paid' | 'unpaid' | 'pending'; customerEmail: string | null }> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId);

    if (session.metadata?.userId !== userId) {
      throw new NotFoundException('Session not found');
    }
    let status: 'paid' | 'unpaid' | 'pending';
    if (session.payment_status === 'paid') {
      status = 'paid';
    } else if (session.payment_status === 'unpaid') {
      status = 'unpaid';
    } else {
      status = 'pending';
    }

    return {
      status,
      customerEmail: session.customer_details?.email ?? null,
    };
  }
}
