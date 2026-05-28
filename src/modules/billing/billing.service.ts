import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import Stripe from 'stripe';

import DailyUsage from '@common/db/entities/daily-usage.entity';
import Subscription, { SubscriptionStatus } from '@common/db/entities/subscription.entity';
import StripeWebhookEvent from '@common/db/entities/stripe-webhook-event.entity';
import User from '@common/db/entities/user.entity';
import isMySqlError from '@common/utils/isMySqlError';

import {
  BILLING_DEFAULT_TIMEZONE,
  BILLING_ENV,
  BILLING_ERRORS,
  BILLING_PHASE,
  BILLING_FREE_DAILY_DOCUMENT_LIMIT,
  BILLING_PATHS,
  BILLING_PROFESSIONAL_TRIAL_DAYS,
  BILLING_PLAN_STATUS,
  BILLING_PLAN_TIER,
  BILLING_STRIPE_ACTIVE_STATUSES,
} from '@common/constants/billing.constants';
import { CHECKOUT_TARGET_PLAN, type CheckoutTargetPlan } from './dto/create-checkout-session.dto';

type CreateCheckoutSessionResult = { url: string };
type CreateCustomerPortalSessionResult = { url: string };
type BillingStatusResult = {
  planTier: User['planTier'];
  planStatus: User['planStatus'];
  billingPhase: (typeof BILLING_PHASE)[keyof typeof BILLING_PHASE];
  isTrialing: boolean;
  trialEndsAt: Date | null;
  trialDaysLeft: number | null;
  dailyLimit: number | null;
  usedToday: number;
  remainingToday: number | null;
  currentPeriodEnd: Date | null;
  hasActiveSubscription: boolean;
  canUpgrade: boolean;
  canManageSubscription: boolean;
};
const MYSQL_DUPLICATE_ENTRY_CODE = 'ER_DUP_ENTRY';
const ENTITLEMENT_RECONCILE_STALE_MINUTES = 15;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

@Injectable()
export default class BillingService {
  private readonly logger = new Logger(BillingService.name);

  private readonly stripe: Stripe;

  private readonly frontendDomain: string;

  private readonly webhookSecret: string;

  private readonly professionalPriceId: string;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
    @InjectRepository(Subscription)
    private readonly subscriptionRepository: Repository<Subscription>,
    @InjectRepository(StripeWebhookEvent)
    private readonly stripeWebhookEventRepository: Repository<StripeWebhookEvent>,
    @InjectRepository(DailyUsage)
    private readonly dailyUsageRepository: Repository<DailyUsage>,
  ) {
    const secretKey = this.configService.getOrThrow<string>(BILLING_ENV.STRIPE_SECRET_KEY);
    this.webhookSecret = this.configService.getOrThrow<string>(BILLING_ENV.STRIPE_WEBHOOK_SECRET);
    this.professionalPriceId = this.configService.getOrThrow<string>(
      BILLING_ENV.STRIPE_PRO_PRICE_ID,
    );
    this.frontendDomain = this.configService.getOrThrow<string>(BILLING_ENV.FRONTEND_DOMAIN);
    this.stripe = new Stripe(secretKey);
  }

  public async createCheckoutSession(
    userId: string,
    targetPlan: CheckoutTargetPlan,
  ): Promise<CreateCheckoutSessionResult> {
    try {
      if (targetPlan !== CHECKOUT_TARGET_PLAN.PROFESSIONAL) {
        throw new BadRequestException('Unsupported checkout target plan');
      }

      const user = await this.userRepository.findOne({ where: { uuid: userId } });
      if (!user) {
        throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
      }

      const stripeCustomerId = await this.ensureStripeCustomer(user);
      const trialPeriodDays = BillingService.getProfessionalTrialDays(user);

      const session = await this.stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: stripeCustomerId,
        line_items: [{ price: this.professionalPriceId, quantity: 1 }],
        success_url: `${this.frontendDomain}${BILLING_PATHS.SUCCESS}`,
        cancel_url: `${this.frontendDomain}${BILLING_PATHS.CANCEL}`,
        metadata: { userId, targetPlan },
        subscription_data: {
          metadata: { userId, targetPlan },
          ...(trialPeriodDays > 0 ? { trial_period_days: trialPeriodDays } : {}),
        },
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

  public async createCustomerPortalSession(
    userId: string,
  ): Promise<CreateCustomerPortalSessionResult> {
    try {
      const user = await this.userRepository.findOne({ where: { uuid: userId } });
      if (!user) {
        throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
      }

      const { stripeCustomerId } = user;
      if (!stripeCustomerId) {
        throw new NotFoundException(BILLING_ERRORS.NO_STRIPE_CUSTOMER);
      }

      const session = await this.stripe.billingPortal.sessions.create({
        customer: stripeCustomerId,
        return_url: `${this.frontendDomain}${BILLING_PATHS.SUBSCRIPTION}`,
      });

      return { url: session.url };
    } catch (error: unknown) {
      if (error instanceof NotFoundException) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Customer portal session creation failed: ${message}`);
      throw new InternalServerErrorException(BILLING_ERRORS.CUSTOMER_PORTAL_FAILED);
    }
  }

  public async getBillingStatus(userId: string): Promise<BillingStatusResult> {
    const user = await this.userRepository.findOne({ where: { uuid: userId } });
    if (!user) {
      throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
    }

    const reconciledUser = await this.resolveFreshEntitlements(user);
    const usageDate = BillingService.resolveUsageDate(reconciledUser.timezone);
    const usage = await this.dailyUsageRepository.findOne({
      where: { userId, usageDate },
    });
    const usedToday = usage?.documentsUsed ?? 0;
    const { dailyLimit } = reconciledUser;
    const isUnlimited = dailyLimit === null;
    const remainingToday = isUnlimited ? null : Math.max(dailyLimit - usedToday, 0);
    const preferredSubscription = await this.findPreferredStoredSubscription(reconciledUser.uuid);
    const isTrialingSubscription = preferredSubscription?.status === 'trialing';
    const trialEndsAt = isTrialingSubscription ? preferredSubscription.currentPeriodEnd : null;
    const trialDaysLeft = BillingService.resolveTrialDaysLeft(trialEndsAt);
    const hasActiveSubscription =
      reconciledUser.planTier === BILLING_PLAN_TIER.PROFESSIONAL &&
      reconciledUser.planStatus === BILLING_PLAN_STATUS.ACTIVE;
    const billingPhase = BillingService.resolveBillingPhase(
      reconciledUser.planStatus,
      hasActiveSubscription,
      isTrialingSubscription,
    );

    return {
      planTier: reconciledUser.planTier,
      planStatus: reconciledUser.planStatus,
      billingPhase,
      isTrialing: isTrialingSubscription,
      trialEndsAt,
      trialDaysLeft,
      dailyLimit,
      usedToday,
      remainingToday,
      currentPeriodEnd: reconciledUser.currentPeriodEnd,
      hasActiveSubscription,
      canUpgrade: !hasActiveSubscription,
      canManageSubscription: Boolean(reconciledUser.stripeCustomerId),
    };
  }

  public async consumeDeIdDocumentUsage(userId: string): Promise<void> {
    const user = await this.userRepository.findOne({ where: { uuid: userId } });
    if (!user) {
      throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
    }

    const reconciledUser = await this.resolveFreshEntitlements(user);
    const isUnlimited =
      reconciledUser.planTier === BILLING_PLAN_TIER.PROFESSIONAL &&
      reconciledUser.planStatus === BILLING_PLAN_STATUS.ACTIVE;

    if (isUnlimited) {
      return;
    }

    const usageDate = BillingService.resolveUsageDate(reconciledUser.timezone);
    const dailyLimit = reconciledUser.dailyLimit ?? BILLING_FREE_DAILY_DOCUMENT_LIMIT;

    await this.dailyUsageRepository.manager.transaction(async (transactionalEntityManager) => {
      await transactionalEntityManager.query(
        `
          INSERT INTO daily_usage (id, userId, usageDate, documentsUsed, createdAt, updatedAt)
          VALUES (UUID(), ?, ?, 0, NOW(), NOW())
          ON DUPLICATE KEY UPDATE updatedAt = NOW()
        `,
        [userId, usageDate],
      );

      const usageRows = (await transactionalEntityManager.query(
        `
          SELECT documentsUsed
          FROM daily_usage
          WHERE userId = ? AND usageDate = ?
          FOR UPDATE
        `,
        [userId, usageDate],
      )) as Array<{ documentsUsed?: number | string | null }>;

      const currentUsage = Number(usageRows[0]?.documentsUsed ?? 0);
      if (currentUsage >= dailyLimit) {
        throw new ForbiddenException(BILLING_ERRORS.DAILY_LIMIT_EXCEEDED);
      }

      await transactionalEntityManager.query(
        `
          UPDATE daily_usage
          SET documentsUsed = documentsUsed + 1,
              updatedAt = NOW()
          WHERE userId = ? AND usageDate = ?
        `,
        [userId, usageDate],
      );
    });
  }

  public async upsertSubscriptionFromStripe(subscription: Stripe.Subscription): Promise<void> {
    const userId = await this.resolveUserIdFromSubscription(subscription);
    if (!userId) {
      this.logger.error(`No userId in subscription.metadata for subscription ${subscription.id}`);
      return;
    }

    const currentPeriodEndSeconds = subscription.items.data[0]?.current_period_end;
    const currentPeriodEnd =
      typeof currentPeriodEndSeconds === 'number' ? new Date(currentPeriodEndSeconds * 1000) : null;

    await this.subscriptionRepository.upsert(
      {
        userId,
        stripeCustomerId: subscription.customer as string,
        stripeSubscriptionId: subscription.id,
        stripePriceId: subscription.items.data[0]?.price.id ?? this.professionalPriceId,
        status: subscription.status as SubscriptionStatus,
        currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancel_at_period_end,
      },
      ['stripeSubscriptionId'],
    );

    const entitlementPatch = BillingService.buildEntitlementPatch(
      subscription.status,
      currentPeriodEnd,
      subscription.cancel_at_period_end,
    );
    await this.userRepository.update(
      { uuid: userId },
      {
        ...entitlementPatch,
        hasUsedProfessionalTrial: true,
      },
    );

    this.logger.log(
      `Subscription ${subscription.id} upserted for user ${userId} (status: ${subscription.status})`,
    );
  }

  public verifyWebhookSignature(rawBody: Buffer, signature: string): Stripe.Event {
    return this.stripe.webhooks.constructEvent(rawBody, signature, this.webhookSecret);
  }

  public async claimWebhookEvent(eventId: string): Promise<boolean> {
    try {
      await this.stripeWebhookEventRepository.insert({ stripeEventId: eventId });
      return true;
    } catch (error: unknown) {
      if (isMySqlError(error) && error.code === MYSQL_DUPLICATE_ENTRY_CODE) {
        return false;
      }
      throw error;
    }
  }

  private async ensureStripeCustomer(user: User): Promise<string> {
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

  private async resolveUserIdFromSubscription(
    subscription: Stripe.Subscription,
  ): Promise<string | null> {
    const metadataUserId = subscription.metadata?.userId;
    if (metadataUserId) {
      return metadataUserId;
    }

    const stripeCustomerId =
      typeof subscription.customer === 'string' ? subscription.customer : null;
    if (!stripeCustomerId) {
      return null;
    }

    const user = await this.userRepository.findOne({ where: { stripeCustomerId } });
    return user?.uuid ?? null;
  }

  private static buildEntitlementPatch(
    subscriptionStatus: Stripe.Subscription.Status,
    currentPeriodEnd: Date | null,
    cancelAtPeriodEnd: boolean,
  ): Partial<User> {
    const now = new Date();
    const hasPeriodAccess = Boolean(currentPeriodEnd && currentPeriodEnd > now);
    const hasActiveStatus = BILLING_STRIPE_ACTIVE_STATUSES.includes(
      subscriptionStatus as (typeof BILLING_STRIPE_ACTIVE_STATUSES)[number],
    );
    const hasProfessionalAccess = hasActiveStatus || (cancelAtPeriodEnd && hasPeriodAccess);

    if (hasProfessionalAccess) {
      return {
        planTier: BILLING_PLAN_TIER.PROFESSIONAL,
        planStatus: BILLING_PLAN_STATUS.ACTIVE,
        currentPeriodEnd,
        dailyLimit: null,
        entitlementsUpdatedAt: now,
      };
    }

    let planStatus: User['planStatus'] = BILLING_PLAN_STATUS.INACTIVE;
    if (subscriptionStatus === 'past_due') {
      planStatus = BILLING_PLAN_STATUS.PAST_DUE;
    } else if (subscriptionStatus === 'canceled') {
      planStatus = BILLING_PLAN_STATUS.CANCELED;
    }

    return {
      planTier: BILLING_PLAN_TIER.FREE,
      planStatus,
      currentPeriodEnd: hasPeriodAccess ? currentPeriodEnd : null,
      dailyLimit: BILLING_FREE_DAILY_DOCUMENT_LIMIT,
      entitlementsUpdatedAt: now,
    };
  }

  private static getProfessionalTrialDays(user: User): number {
    return user.hasUsedProfessionalTrial ? 0 : BILLING_PROFESSIONAL_TRIAL_DAYS;
  }

  private static resolveTrialDaysLeft(trialEndsAt: Date | null): number | null {
    if (!trialEndsAt) {
      return null;
    }

    const diffMs = trialEndsAt.getTime() - Date.now();
    if (diffMs <= 0) {
      return 0;
    }

    return Math.ceil(diffMs / MILLISECONDS_PER_DAY);
  }

  private static resolveBillingPhase(
    planStatus: User['planStatus'],
    hasActiveSubscription: boolean,
    isTrialingSubscription: boolean,
  ): (typeof BILLING_PHASE)[keyof typeof BILLING_PHASE] {
    if (isTrialingSubscription && hasActiveSubscription) {
      return BILLING_PHASE.TRIAL;
    }

    if (hasActiveSubscription) {
      return BILLING_PHASE.PAID;
    }

    if (planStatus === BILLING_PLAN_STATUS.PAST_DUE) {
      return BILLING_PHASE.PAST_DUE;
    }

    if (planStatus === BILLING_PLAN_STATUS.CANCELED) {
      return BILLING_PHASE.CANCELED;
    }

    return BILLING_PHASE.FREE;
  }

  private async findPreferredStoredSubscription(userId: string): Promise<Subscription | null> {
    const subscriptions = await this.subscriptionRepository.find({
      where: { userId },
      order: { updatedAt: 'DESC', createdAt: 'DESC' },
    });

    return BillingService.selectPreferredStoredSubscription(subscriptions);
  }

  private static selectPreferredStoredSubscription(
    subscriptions: Subscription[],
  ): Subscription | null {
    if (subscriptions.length === 0) {
      return null;
    }

    const now = new Date();
    const activeSubscription = subscriptions.find((subscription) =>
      BILLING_STRIPE_ACTIVE_STATUSES.includes(
        subscription.status as (typeof BILLING_STRIPE_ACTIVE_STATUSES)[number],
      ),
    );

    if (activeSubscription) {
      return activeSubscription;
    }

    const cancelAtPeriodEndSubscription = subscriptions.find(
      (subscription) =>
        subscription.cancelAtPeriodEnd &&
        Boolean(subscription.currentPeriodEnd && subscription.currentPeriodEnd > now),
    );

    if (cancelAtPeriodEndSubscription) {
      return cancelAtPeriodEndSubscription;
    }

    return subscriptions.slice().sort((first, second) => {
      const firstPeriodEnd = first.currentPeriodEnd?.getTime() ?? 0;
      const secondPeriodEnd = second.currentPeriodEnd?.getTime() ?? 0;

      if (firstPeriodEnd !== secondPeriodEnd) {
        return secondPeriodEnd - firstPeriodEnd;
      }

      return second.updatedAt.getTime() - first.updatedAt.getTime();
    })[0];
  }

  private async reconcileExpiredProfessionalAccess(user: User): Promise<User> {
    const now = new Date();
    const isProfessional = user.planTier === BILLING_PLAN_TIER.PROFESSIONAL;
    const hasExpiredPeriod = Boolean(user.currentPeriodEnd && user.currentPeriodEnd <= now);

    if (!isProfessional || !hasExpiredPeriod) {
      return user;
    }

    const patch: Partial<User> = {
      planTier: BILLING_PLAN_TIER.FREE,
      planStatus: BILLING_PLAN_STATUS.CANCELED,
      currentPeriodEnd: null,
      dailyLimit: BILLING_FREE_DAILY_DOCUMENT_LIMIT,
      entitlementsUpdatedAt: now,
    };
    await this.userRepository.update({ uuid: user.uuid }, patch);

    return {
      ...user,
      ...patch,
    };
  }

  private async resolveFreshEntitlements(user: User): Promise<User> {
    const locallyReconciledUser = await this.reconcileExpiredProfessionalAccess(user);

    if (!BillingService.shouldReconcileWithStripe(locallyReconciledUser)) {
      return locallyReconciledUser;
    }

    return this.reconcileEntitlementsFromStripe(locallyReconciledUser);
  }

  private static shouldReconcileWithStripe(user: User): boolean {
    if (!user.stripeCustomerId) {
      return false;
    }

    if (!user.entitlementsUpdatedAt) {
      return true;
    }

    const now = Date.now();
    const staleThresholdMs = ENTITLEMENT_RECONCILE_STALE_MINUTES * 60 * 1000;
    const isStale = now - user.entitlementsUpdatedAt.getTime() >= staleThresholdMs;

    if (user.planTier === BILLING_PLAN_TIER.PROFESSIONAL && !user.currentPeriodEnd) {
      return true;
    }

    return isStale;
  }

  private async reconcileEntitlementsFromStripe(user: User): Promise<User> {
    if (!user.stripeCustomerId) {
      return user;
    }

    try {
      const subscriptions = await this.stripe.subscriptions.list({
        customer: user.stripeCustomerId,
        status: 'all',
        limit: 10,
      });

      const preferredSubscription = BillingService.selectPreferredSubscription(subscriptions.data);
      if (!preferredSubscription) {
        const patch: Partial<User> = {
          planTier: BILLING_PLAN_TIER.FREE,
          planStatus: BILLING_PLAN_STATUS.INACTIVE,
          currentPeriodEnd: null,
          dailyLimit: BILLING_FREE_DAILY_DOCUMENT_LIMIT,
          entitlementsUpdatedAt: new Date(),
        };
        await this.userRepository.update({ uuid: user.uuid }, patch);

        return {
          ...user,
          ...patch,
        };
      }

      await this.upsertSubscriptionFromStripe(preferredSubscription);

      const updatedUser = await this.userRepository.findOne({ where: { uuid: user.uuid } });
      if (!updatedUser) {
        throw new NotFoundException(BILLING_ERRORS.USER_NOT_FOUND);
      }

      return updatedUser;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Stripe entitlement reconciliation skipped: ${message}`);
      return user;
    }
  }

  private static selectPreferredSubscription(
    subscriptions: Stripe.Subscription[],
  ): Stripe.Subscription | null {
    if (subscriptions.length === 0) {
      return null;
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const activeSubscription = subscriptions.find((subscription) =>
      BILLING_STRIPE_ACTIVE_STATUSES.includes(
        subscription.status as (typeof BILLING_STRIPE_ACTIVE_STATUSES)[number],
      ),
    );
    if (activeSubscription) {
      return activeSubscription;
    }

    const cancelAtPeriodEndSubscription = subscriptions.find((subscription) => {
      const currentPeriodEndSeconds = subscription.items.data[0]?.current_period_end;
      return Boolean(
        subscription.cancel_at_period_end &&
        typeof currentPeriodEndSeconds === 'number' &&
        currentPeriodEndSeconds > nowSeconds,
      );
    });
    if (cancelAtPeriodEndSubscription) {
      return cancelAtPeriodEndSubscription;
    }

    return subscriptions.slice().sort((first, second) => {
      const firstPeriodEnd = first.items.data[0]?.current_period_end ?? 0;
      const secondPeriodEnd = second.items.data[0]?.current_period_end ?? 0;

      if (firstPeriodEnd !== secondPeriodEnd) {
        return secondPeriodEnd - firstPeriodEnd;
      }

      return second.created - first.created;
    })[0];
  }

  private static resolveUsageDate(timezone: string | null | undefined): string {
    const normalizedTimezone =
      timezone && timezone.trim().length > 0 ? timezone : BILLING_DEFAULT_TIMEZONE;

    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: normalizedTimezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    } catch {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: BILLING_DEFAULT_TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
    }
  }
}
