import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UpdatesService } from './updates.module.js';

const previous = process.env.AIXAND_PACKAGED_RUNTIME;
afterEach(() => { if (previous === undefined) delete process.env.AIXAND_PACKAGED_RUNTIME; else process.env.AIXAND_PACKAGED_RUNTIME = previous; });
describe('installer update API', () => {
  it('reports source development mode and never launches an updater', async () => {
    delete process.env.AIXAND_PACKAGED_RUNTIME;
    const service = new UpdatesService();
    expect(await service.status()).toEqual({ available: false, message: 'Installer updates are unavailable in source development mode.' });
    expect(await service.action({ action: 'check' })).toEqual(await service.status());
    service.onModuleInit(); service.onModuleDestroy();
  });
  it('refuses download without a managed Server installation', async () => {
    delete process.env.AIXAND_PACKAGED_RUNTIME;
    await expect(new UpdatesService().action({ action: 'download' })).rejects.toThrow('Desktop connection window');
  });
  it('does not accept caller-supplied executables, feed addresses, or implicit confirmation', async () => {
    const service = new UpdatesService();
    for (const input of [{ action: 'check', url: 'https://other.example' }, { action: 'install', confirmed: false },
      { action: 'install', confirmed: true, revision: 'a'.repeat(64), acceptedLicenses: [], application: '/other/app' },
      { action: 'settings', daily: 'yes' }]) await expect(service.action(input)).rejects.toThrow('Invalid update request');
  });
});

describe('component update request boundaries', () => {
  it('accepts bounded selections and preferences, and requires complete install consent', async () => {
    delete process.env.AIXAND_PACKAGED_RUNTIME;
    const service = new UpdatesService();
    for (const input of [
      { action: 'plan', components: ['server', 'connect'] },
      { action: 'settings', automaticDownload: true },
      { action: 'install', confirmed: true, restartConsent: true, revision: 'a'.repeat(64), acceptedLicenses: [] },
    ]) expect(await service.action(input)).toEqual(await service.status());
    for (const input of [
      { action: 'plan', components: [] }, { action: 'plan', components: ['server', 'server'] },
      { action: 'download', components: ['../../other'] }, { action: 'plan', components: Array(11).fill('server') },
      { action: 'settings' }, { action: 'settings', automaticDownload: 'yes' },
      { action: 'install', confirmed: true, revision: 'a'.repeat(64), acceptedLicenses: [] },
      { action: 'install', confirmed: true, restartConsent: false, revision: 'a'.repeat(64), acceptedLicenses: [] },
    ]) await expect(service.action(input)).rejects.toThrow('Invalid update request');
  });
});

describe('packaged Server runtime routing', () => {
  it('routes bounded manager updates through the product owner and hides private inventory paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suite-product-update-api-'));
    const previousRoot = process.env.AIXAND_PRODUCT_RUNTIME, previousPackaged = process.env.AIXAND_PACKAGED_RUNTIME;
    try {
      process.env.AIXAND_PRODUCT_RUNTIME = root; process.env.AIXAND_PACKAGED_RUNTIME = '1';
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ installation: { role: 'desktop' } }));
      await writeFile(join(root, 'runtime.mjs'), `const [command,action,json]=process.argv.slice(2);const input=JSON.parse(json||'{}');
if(command!=='product-updates')throw Error('Wrong installation owner');
if(action==='plan')console.log(JSON.stringify({revision:'a'.repeat(64),ready:true,requested:input.products,candidates:{'agent-manager':{version:'0.1.1-beta',artifact:{url:'private'}}},licenses:[],blockers:[],unsupported:[],shared:true}));
else console.log(JSON.stringify({available:true,inventory:{prefix:'/private/store',receiptDigest:'private',products:{'agent-manager':{name:'Agent Manager',version:'0.1.0-beta',scope:'shared',updatable:true}}},candidates:{'agent-manager':{version:'0.1.1-beta',artifact:{url:'private'}}}}));`);
      const service = new UpdatesService();
      const status = await service.status(false, true);
      expect(status.inventory.products['agent-manager'].scope).toBe('shared');
      expect(status.inventory).not.toHaveProperty('prefix'); expect(status.inventory).not.toHaveProperty('receiptDigest');
      expect(status.candidates['agent-manager']).not.toHaveProperty('artifact');
      const plan = await service.action({ action: 'plan', products: ['agent-manager'] }, false, true);
      expect(plan.requested).toEqual(['agent-manager']); expect(plan.shared).toBe(true);
      expect(plan.candidates['agent-manager']).not.toHaveProperty('artifact');
      for (const input of [{ action: 'plan', products: [] }, { action: 'plan', products: ['agent-manager', 'agent-manager'] },
        { action: 'plan', products: ['../../arbitrary'] }, { action: 'plan', products: ['server'] },
        { action: 'install', confirmed: true, revision: 'a'.repeat(64), acceptedLicenses: [] }]) {
        await expect(service.action(input, false, true)).rejects.toThrow('Invalid update request');
      }
    } finally {
      if (previousRoot === undefined) delete process.env.AIXAND_PRODUCT_RUNTIME; else process.env.AIXAND_PRODUCT_RUNTIME = previousRoot;
      if (previousPackaged === undefined) delete process.env.AIXAND_PACKAGED_RUNTIME; else process.env.AIXAND_PACKAGED_RUNTIME = previousPackaged;
      await rm(root, { recursive: true, force: true });
    }
  });
  it('separates component and application commands and forwards selected downloads', async () => {
    const root = await mkdtemp(join(tmpdir(), 'suite-update-api-'));
    const previousRoot = process.env.AIXAND_PRODUCT_RUNTIME;
    const previousPackaged = process.env.AIXAND_PACKAGED_RUNTIME;
    try {
      await writeFile(join(root, 'manifest.json'), JSON.stringify({ installation: { role: 'server' } }));
      await writeFile(join(root, 'runtime.mjs'), `import {writeFileSync} from 'node:fs';
const [command, action, json] = process.argv.slice(2); const input = JSON.parse(json || '{}');
if (action === 'download') writeFileSync(new URL('./called.json', import.meta.url), JSON.stringify({command, action, input}));
if (action === 'plan') console.log(JSON.stringify({revision:'a'.repeat(64),ready:true,requested:['server'],candidates:{server:{version:'0.1.1-beta',files:{private:'inventory'}}},licenses:[],blockers:[],unsupported:[],restartRequired:true,scope:{base:'/private/workspace'},inventory:{paths:{server:'/private/object'}}}));
else console.log(JSON.stringify({command,action,input}));`);
      process.env.AIXAND_PRODUCT_RUNTIME = root; process.env.AIXAND_PACKAGED_RUNTIME = '1';
      const service = new UpdatesService();
      expect(await service.status()).toMatchObject({ command: 'component-updates', action: 'status' });
      expect(await service.status(true)).toMatchObject({ command: 'updates', action: 'status' });
      const plan = await service.action({ action: 'plan', components: ['server'] });
      expect(plan).toMatchObject({ candidates: { server: { version: '0.1.1-beta' } } });
      expect(plan).not.toHaveProperty('inventory'); expect(plan).not.toHaveProperty('scope');
      expect(plan.candidates.server).not.toHaveProperty('files');
      expect(await service.action({ action: 'download', components: ['server', 'connect'] })).toEqual({ started: true });
      await vi.waitFor(async () => expect(JSON.parse(await readFile(join(root, 'called.json'), 'utf8'))).toEqual({ command: 'component-updates', action: 'download', input: { components: ['server', 'connect'] } }));
    } finally {
      if (previousRoot === undefined) delete process.env.AIXAND_PRODUCT_RUNTIME; else process.env.AIXAND_PRODUCT_RUNTIME = previousRoot;
      if (previousPackaged === undefined) delete process.env.AIXAND_PACKAGED_RUNTIME; else process.env.AIXAND_PACKAGED_RUNTIME = previousPackaged;
      await rm(root, { recursive: true, force: true });
    }
  });
});
