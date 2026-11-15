import { Controller, Get, Header, Module, ServiceUnavailableException, StreamableFile } from '@nestjs/common';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

@Controller('connect')
export class ConnectController {
  @Get('companion')
  @Header('Cache-Control', 'private, no-store')
  async companion() {
    const file = process.env.AIXAND_CONNECT_COMPANION ?? resolve('../../build/connect/companion.pyz');
    if (!isAbsolute(file)) throw new ServiceUnavailableException('The Connect companion path must be absolute.');
    const info = await lstat(file).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink() || info.size <= 0 || info.size > 16 * 1024 * 1024)
      throw new ServiceUnavailableException('The Connect companion is unavailable. Build or install the Connect component.');
    return new StreamableFile(createReadStream(file), {
      type: 'application/zip', disposition: 'attachment; filename="aixand-connect.pyz"', length: info.size,
    });
  }
}

@Module({ controllers: [ConnectController] })
export class ConnectModule {}
