import { Module } from '@nestjs/common';
import { CarrierGateway } from './carrier.gateway.js';
import { CarrierService } from './carrier.service.js';
import { AgentsModule } from '../agents/agents.module.js';
@Module({ imports: [AgentsModule], providers: [CarrierService, CarrierGateway] })
export class CarrierModule {}
