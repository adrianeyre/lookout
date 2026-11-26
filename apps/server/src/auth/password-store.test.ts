import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEST_PASSWORD_HASH } from '../../test/helpers.ts';
import { PASSWORD_FILE, PasswordStore } from './password-store.ts';
import { hashPassword } from './password.ts';

const CHEAP = { memory: 64, passes: 1, parallelism: 1 };

describe('PasswordStore', () => {
  it('uses LOOKOUT_PASSWORD_HASH and cannot change without a data directory', async () => {
    const store = await PasswordStore.open(TEST_PASSWORD_HASH, null);
    expect(store.hash).toBe(TEST_PASSWORD_HASH);
    expect(store.changeable).toBe(false);
    await expect(store.change(TEST_PASSWORD_HASH)).rejects.toThrow(/data directory/);
  });

  it('keeps a changed password across a restart', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-pw-'));
    const store = await PasswordStore.open(TEST_PASSWORD_HASH, dir);
    const next = await hashPassword('another password', CHEAP);
    await store.change(next);
    expect(store.hash).toBe(next);
    expect((await PasswordStore.open(TEST_PASSWORD_HASH, dir)).hash).toBe(next);
  });

  it('lets a new LOOKOUT_PASSWORD_HASH win, so a forgotten password can be reset in .env', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-pw-'));
    await (
      await PasswordStore.open(TEST_PASSWORD_HASH, dir)
    ).change(await hashPassword('forgotten', CHEAP));
    const reset = await hashPassword('reset in env', CHEAP);
    expect((await PasswordStore.open(reset, dir)).hash).toBe(reset);
  });

  it('ignores a damaged or invalid file', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-pw-'));
    for (const content of ['not json', '{"hash":"plain text","replaces":"x"}', 'null']) {
      await writeFile(path.join(dir, PASSWORD_FILE), content);
      expect((await PasswordStore.open(TEST_PASSWORD_HASH, dir)).hash).toBe(TEST_PASSWORD_HASH);
    }
  });

  it('never writes the password itself', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'lookout-pw-'));
    const store = await PasswordStore.open(TEST_PASSWORD_HASH, dir);
    await store.change(await hashPassword('secret words', CHEAP));
    expect(await readFile(path.join(dir, PASSWORD_FILE), 'utf8')).not.toContain('secret words');
  });
});
