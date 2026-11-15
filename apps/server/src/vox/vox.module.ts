import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { VoxService } from './vox.service.js';
import { VoxGateway } from './vox.gateway.js';

@Module({ imports: [AgentsModule], providers: [VoxService, VoxGateway] })
export class VoxModule {}
