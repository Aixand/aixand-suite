import { Module } from '@nestjs/common';
import { TerminalsGateway } from './terminals.gateway.js';

@Module({ providers: [TerminalsGateway] })
export class TerminalsModule {}
