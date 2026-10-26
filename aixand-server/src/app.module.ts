import { FilesystemModule } from './filesystem/filesystem.module.js';
import { OnboardingModule } from './onboarding/onboarding.module.js';
import { InstallationModule } from './onboarding/installation.module.js';
import { Module } from '@nestjs/common';
import { AuthModule } from './auth/auth.module.js';
import { CarrierModule } from './carrier/carrier.module.js';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { TerminalsModule } from './terminals/terminals.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { VoxModule } from './vox/vox.module.js';
import { RecoveryModule } from './recovery/recovery.module.js';

@Module({
  imports: [
    AuthModule,
    FilesystemModule,
    OnboardingModule,
    InstallationModule,
    RecoveryModule,
    TerminalsModule,
    WorkflowsModule,
    AgentsModule,
    CarrierModule,
    VoxModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
