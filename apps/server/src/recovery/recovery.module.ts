import { Global, Module } from '@nestjs/common';
import { RecoveryController } from './recovery.controller.js';
import { RecoveryService } from './recovery.service.js';

@Global()
@Module({ controllers: [RecoveryController], providers: [RecoveryService], exports: [RecoveryService] })
export class RecoveryModule {}
