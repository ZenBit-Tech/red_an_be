import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import {
  BILLING_ERRORS,
  STRIPE_EVENTS,
  WEBHOOKS_ROUTE,
  WEBHOOKS_STRIPE_PATH,
} from '@common/constants/billing.constants';
import Stripe from 'stripe';

import BillingService from './modules/billing/billing.service';

@ApiExcludeController()
@Controller(WEBHOOKS_ROUTE)
export default class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(private readonly billingService: BillingService) {}

  @Post(WEBHOOKS_STRIPE_PATH)
  @HttpCode(200)
  async handleStripeWebhook(
    @Req() req: Request & { rawBody?: Buffer },
    @Headers('stripe-signature') signature: string,
  ): Promise<{ received: boolean; duplicate?: boolean }> {
    if (!req.rawBody) {
      throw new BadRequestException(BILLING_ERRORS.WEBHOOK_RAW_BODY_MISSING);
    }

    let event: Stripe.Event;
    try {
      event = this.billingService.verifyWebhookSignature(req.rawBody, signature);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(`${BILLING_ERRORS.WEBHOOK_SIGNATURE_INVALID}: ${message}`);
      throw new BadRequestException(`${BILLING_ERRORS.WEBHOOK_SIGNATURE_INVALID}: ${message}`);
    }

    const isNewEvent = await this.billingService.claimWebhookEvent(event.id);
    if (!isNewEvent) {
      this.logger.log(`Skipping duplicate event ${event.id}`);
      return { received: true, duplicate: true };
    }

    switch (event.type) {
      case STRIPE_EVENTS.CHECKOUT_COMPLETED: {
        const session = event.data.object as Stripe.Checkout.Session;
        this.logger.log(`Checkout completed: ${session.id}`);
        break;
      }

      case STRIPE_EVENTS.SUBSCRIPTION_CREATED:
      case STRIPE_EVENTS.SUBSCRIPTION_UPDATED:
      case STRIPE_EVENTS.SUBSCRIPTION_DELETED: {
        const subscription = event.data.object as Stripe.Subscription;
        await this.billingService.upsertSubscriptionFromStripe(subscription);
        break;
      }

      case STRIPE_EVENTS.INVOICE_PAYMENT_FAILED: {
        const invoice = event.data.object as Stripe.Invoice;
        this.logger.warn(`Payment failed for invoice ${invoice.id}`);
        break;
      }

      default:
        this.logger.log(`Unhandled Stripe event: ${event.type}`);
    }

    return { received: true };
  }
}
