import * as argon2 from 'argon2';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

const common = new Set(
  readFileSync(new URL('./common-passwords.txt', import.meta.url), 'utf8')
    .split(/\r?\n/)
    .map((value) => value.toLowerCase()),
);
export const passwordSchema = z.string().refine((value) => {
  const length = [...value].length;
  return length >= 15 && length <= 128 && !common.has(value.toLowerCase());
}, 'Use 15–128 characters and avoid common passwords.');
export const loginPasswordSchema = z.string().min(1).max(512);
export function hashPassword(password: string) {
  passwordSchema.parse(password);
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 65536,
    timeCost: 3,
    parallelism: 1,
    hashLength: 32,
  });
}
export function verifyPassword(hash: string, password: string) {
  return argon2.verify(hash, password);
}
