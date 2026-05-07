import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import TemplateUser from '@db/entities/user.entity';
import Subscription from '@db/entities/subscription.entity';

import AuthModule from '../auth/auth.module';
import BillingController from './billing.controller';
import WebhookController from '../../webhook.controller';
import BillingService from './billing.service';

@Module({
  imports: [TypeOrmModule.forFeature([TemplateUser, Subscription]), AuthModule],
  controllers: [BillingController, WebhookController],
  providers: [BillingService],
  exports: [BillingService],
})
export default class BillingModule {}
