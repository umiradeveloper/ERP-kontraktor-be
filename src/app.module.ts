import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { PrismaModule } from './prisma/prisma.service';
import { CommonModule } from './common/common.service';
import { AuthGuard } from './common/auth';
import { AllExceptionsFilter, EnvelopeInterceptor, RequestIdMiddleware } from './common/http';
import { AuthModule } from './modules/auth.module';
import { MasterModule } from './modules/master.module';
import { ApprovalsModule } from './modules/approvals.module';
import { AccountingModule } from './modules/accounting.module';
import { TendersModule } from './modules/tenders.module';
import { ProjectsModule } from './modules/projects.module';
import { ProcurementModule } from './modules/procurement.module';
import { BillingModule } from './modules/billing.module';
import { AssetsModule } from './modules/assets.module';
import { DashboardModule } from './modules/dashboard.module';
import { FilesModule } from './modules/files.module';
import { NotificationsModule } from './modules/notifications.module';
import { RfqModule } from './modules/rfq.module';
import { InventoryModule } from './modules/inventory.module';
import { VariationOrdersModule } from './modules/variation-orders.module';
import { ExportsModule } from './modules/exports.module';

@Module({
  imports: [
    JwtModule.register({ global: true }),
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 300 }]),
    PrismaModule,
    CommonModule,
    AuthModule,
    MasterModule,
    ApprovalsModule,
    AccountingModule,
    TendersModule,
    ProjectsModule,
    ProcurementModule,
    BillingModule,
    AssetsModule,
    DashboardModule,
    FilesModule,
    NotificationsModule,
    RfqModule,
    InventoryModule,
    VariationOrdersModule,
    ExportsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_INTERCEPTOR, useClass: EnvelopeInterceptor },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
