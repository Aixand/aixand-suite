import { emitKeypressEvents } from 'node:readline';
import { authDatabasePath } from './config.js';
import { AuthStore } from './store.js';
import { hashPassword } from './password.js';

function hiddenPrompt(label: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      'Run this command in an interactive terminal. Passwords are never accepted as command-line arguments.',
    );
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdout.write(label);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = '';
    const finish = () => {
      process.stdin.off('keypress', listener);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const listener = (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') {
        finish();
        reject(new Error('Cancelled'));
      } else if (key.name === 'return' || key.name === 'enter') {
        finish();
        resolve(value);
      } else if (key.name === 'backspace')
        value = [...value].slice(0, -1).join('');
      else if (
        !key.ctrl &&
        text &&
        [...text].every(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        ) &&
        [...value].length < 128
      )
        value += text;
    };
    process.stdin.on('keypress', listener);
  });
}
async function main() {
  const [command] = process.argv.slice(2);
  if (process.argv.length > 3)
    throw new Error(
      'Too many arguments. Passwords and secrets are never accepted as arguments.',
    );
  const file = authDatabasePath();
  if (command === 'status') {
    const { existsSync } = await import('node:fs');
    if (!existsSync(file)) {
      // An initialization marker without its database must not reopen setup.
      if (existsSync(file + '.initialized')) throw new Error('Authentication database is missing after initialization; restore it on the host.');
      console.log(JSON.stringify({ configured: false, initialized: false }));
    } else {
      const store = new AuthStore(file);
      try { console.log(JSON.stringify({ configured: store.credential().state === 'configured', initialized: true })); }
      finally { store.close(); }
    }
    return;
  }
  if (command === 'hash-password' || command === 'recover' || command === 'setup') {
    if (command === 'recover')
      console.log(`Stop aixand-server and back up ${file} before continuing.`);
    const password = await hiddenPrompt('New password (hidden): ');
    const confirmation = await hiddenPrompt('Confirm password (hidden): ');
    if (password !== confirmation) throw new Error('Passwords do not match');
    const hash = await hashPassword(password);
    if (command === 'hash-password') console.log(hash);
    else {
      const store = new AuthStore(file, { initialize: command === 'setup' });
      try {
        if (command === 'setup') store.configurePassword(hash);
        else store.replacePassword(hash);
      } finally {
        store.close();
      }
      console.log(
        command === 'setup' ? 'Workspace password configured. Provider setup can be resumed later.'
          : 'Password replaced and every session revoked. Restart aixand-server, then sign in.',
      );
    }
    return;
  }
  throw new Error(
    'Use setup, status, hash-password or recover. Password setup and recovery require an interactive terminal.',
  );
}
main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : 'Authentication command failed',
  );
  process.exitCode = 1;
});
