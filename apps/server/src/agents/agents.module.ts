import { Module } from '@nestjs/common';
import { AgentsGateway } from './agents.gateway.js';
import { AgentsService } from './agents.service.js';

@Module({ providers: [AgentsService, AgentsGateway], exports: [AgentsService] })
export class AgentsModule {}
