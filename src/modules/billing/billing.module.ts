import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import Subscription from '@common/db/entities/subscription.entity';
import StripeWebhookEvent from '@common/db/entities/stripe-webhook-event.entity';
import User from '@common/db/entities/user.entity';

import AuthModule from '../auth/auth.module';
import BillingController from './billing.controller';
import WebhookController from '../../webhook.controller';
import BillingService from './billing.service';

@Module({
  imports: [TypeOrmModule.forFeature([User, Subscription, StripeWebhookEvent]), AuthModule],
  controllers: [BillingController, WebhookController],
  providers: [BillingService],
  exports: [BillingService],
})
export default class BillingModule {}
