import { Module } from '@nestjs/common';
import { WorkflowsGateway } from './workflows.gateway.js';
import { WorkflowJobsGateway } from './jobs.gateway.js';
@Module({ providers: [WorkflowsGateway, WorkflowJobsGateway] })
export class WorkflowsModule {}
