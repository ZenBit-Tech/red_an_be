import { Body, Controller, Post, UseGuards, Get, Param } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
  ApiInternalServerErrorResponse,
} from '@nestjs/swagger';

import { BILLING_ROUTE, BILLING_TAG } from '@common/constants/billing.constants';
import JwtAuthGuard from '@auth/guards/jwt-auth.guard';
import { CurrentUser } from '@auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '@auth/types/authenticated-user.type';
import BillingService from '@billing/billing.service';
import CreateCheckoutSessionDto from '@billing/dto/create-checkout-session.dto';
import PaymentHistory from '@common/db/entities/payment-history.entity';

class CheckoutSessionResponseDto {
  url!: string;
}

class CustomerPortalResponseDto {
  url!: string;
}

class BillingStatusResponseDto {
  planTier!: string;

  planStatus!: string;

  billingPhase!: string;

  isTrialing!: boolean;

  trialEndsAt!: Date | null;

  trialDaysLeft!: number | null;

  dailyLimit!: number | null;

  usedToday!: number;

  remainingToday!: number | null;

  currentPeriodEnd!: Date | null;

  hasActiveSubscription!: boolean;

  canUpgrade!: boolean;

  canManageSubscription!: boolean;
}

@ApiTags(BILLING_TAG)
@ApiBearerAuth()
@Controller(BILLING_ROUTE)
@UseGuards(JwtAuthGuard)
export default class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('create-checkout-session')
  @ApiOperation({ summary: 'Create a Stripe Checkout session for the authenticated user' })
  @ApiCreatedResponse({
    description: 'Stripe-hosted checkout URL the client should redirect to',
    type: CheckoutSessionResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiInternalServerErrorResponse({ description: 'Failed to create Stripe checkout session' })
  async createCheckoutSession(
    @Body() dto: CreateCheckoutSessionDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CheckoutSessionResponseDto> {
    return this.billingService.createCheckoutSession(user.uuid, dto.targetPlan);
  }

  @Post('customer-portal')
  @ApiOperation({ summary: 'Create a Stripe Customer Portal session for the authenticated user' })
  @ApiCreatedResponse({
    description: 'Stripe-hosted customer portal URL for subscription management',
    type: CustomerPortalResponseDto,
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiInternalServerErrorResponse({ description: 'Failed to create customer portal session' })
  async createCustomerPortalSession(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<CustomerPortalResponseDto> {
    return this.billingService.createCustomerPortalSession(user.uuid);
  }

  @Get('checkout-session/:sessionId')
  @ApiOperation({ summary: 'Get Stripe Checkout Session status' })
  async getCheckoutSession(
    @Param('sessionId') sessionId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.billingService.getCheckoutSessionStatus(user.uuid, sessionId);
  }

  @Get('status')
  @ApiOperation({ summary: 'Get billing status and daily usage for the authenticated user' })
  @ApiCreatedResponse({ type: BillingStatusResponseDto })
  async getBillingStatus(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BillingStatusResponseDto> {
    return this.billingService.getBillingStatus(user.uuid);
  }

  @Get('subscription')
  @ApiOperation({ summary: 'Get current subscription details for the authenticated user' })
  async getSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.getSubscriptionByUserId(user.uuid);
  }

  @Post('cancel-subscription')
  @ApiOperation({ summary: 'Cancel current subscription' })
  async cancelSubscription(@CurrentUser() user: AuthenticatedUser) {
    return this.billingService.cancelSubscription(user.uuid);
  }

  @Get('history')
  @ApiOperation({ summary: 'Get billing and payment history for the authenticated user' })
  @ApiOkResponse({
    description: 'Array of payment history records',
    type: [PaymentHistory],
  })
  @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
  @ApiInternalServerErrorResponse({ description: 'Failed to retrieve payment history' })
  async getPaymentHistory(@CurrentUser() user: AuthenticatedUser): Promise<PaymentHistory[]> {
    return this.billingService.getPaymentHistoryByUserId(user.uuid);
  }

  @Get('history/:invoiceId/download')
  @ApiOperation({ summary: 'Get the Stripe Invoice PDF download URL' })
  async downloadInvoice(
    @Param('invoiceId') invoiceId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const pdfUrl = await this.billingService.getInvoicePdfUrl(user.uuid, invoiceId);

    return { url: pdfUrl };
  }
}
