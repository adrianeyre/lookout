import { SECRET_MASK } from '@lookout/shared';
import { describe, expect, it } from 'vitest';
import { makeContainer } from '../../test-support/fake-docker.ts';
import { maskArguments, maskLabels, maskMounts, publicDetail, secretValue } from './secrets.ts';

describe('maskArguments (#91)', () => {
  it('masks the value after a secret flag, after "=", and URLs with a password', () => {
    expect(
      maskArguments([
        'redis-server',
        '--requirepass',
        'hunter2',
        '--token=abc',
        'API_KEY=xyz',
        'postgres://app:pw@db/app',
        '--port',
        '6379',
      ]),
    ).toEqual({
      shown: [
        'redis-server',
        '--requirepass',
        SECRET_MASK,
        `--token=${SECRET_MASK}`,
        `API_KEY=${SECRET_MASK}`,
        SECRET_MASK,
        '--port',
        '6379',
      ],
      masked: [2, 3, 4, 5],
    });
  });

  it('masks word by word inside a shell line', () => {
    expect(
      maskArguments(['sh', '-c', 'exec redis-server --requirepass hunter2 --port 6379']),
    ).toEqual({
      shown: ['sh', '-c', `exec redis-server --requirepass ${SECRET_MASK} --port 6379`],
      masked: [2],
    });
  });

  it('leaves ordinary commands alone', () => {
    const args = [
      'node',
      'server.js',
      '--port=3000',
      '-listenip=127.0.0.1',
      'https://example.com/',
    ];
    expect(maskArguments(args)).toEqual({ shown: args, masked: [] });
  });
});

describe('maskLabels (#91)', () => {
  it('masks labels named as secrets, basic-auth users, and URLs or hashes with a password', () => {
    const { shown, masked } = maskLabels({
      'traefik.http.middlewares.auth.basicauth.users': 'admin:$apr1$x$y',
      'app.database-url': 'postgres://app:pw@db/app',
      'app.api_key': 'k',
      'app.hash': '$2y$10$abcdefghijklmnopqrstuv',
      'lookout.self': 'true',
      'com.docker.compose.project': 'shop',
      'org.opencontainers.image.authors': 'someone',
      // A Traefik router that happens to be called "auth" (Authelia) is not a secret.
      'traefik.http.routers.auth.rule': 'Host(`auth.example.com`)',
    });
    expect(masked.sort()).toEqual([
      'app.api_key',
      'app.database-url',
      'app.hash',
      'traefik.http.middlewares.auth.basicauth.users',
    ]);
    expect(shown['lookout.self']).toBe('true');
    expect(shown['traefik.http.routers.auth.rule']).toBe('Host(`auth.example.com`)');
    expect(shown['app.api_key']).toBe(SECRET_MASK);
  });
});

describe('maskMounts (#91)', () => {
  it('masks a source with a secret-named segment, never the destination', () => {
    const mounts = [
      {
        type: 'bind',
        source: '/srv/secrets/db-token',
        destination: '/run/secrets/db',
        readOnly: true,
      },
      { type: 'volume', source: 'notes_uploads', destination: '/app/uploads', readOnly: false },
    ];
    expect(maskMounts(mounts)).toEqual({
      shown: [{ ...mounts[0], source: SECRET_MASK }, mounts[1]],
      masked: [0],
    });
  });
});

describe('publicDetail and secretValue (#91)', () => {
  const container = makeContainer({
    id: 'c1',
    command: ['--password', 'pw'],
    labels: { 'app.token': 't', plain: 'p' },
    mounts: [{ type: 'bind', source: '/secrets/x', destination: '/x', readOnly: true }],
    env: [{ name: 'A', value: 'env-value' }],
  });

  it('sends names only for the environment and masks the rest', () => {
    const detail = publicDetail(container);
    expect(JSON.stringify(detail)).not.toMatch(/"pw"|"t"|\/secrets\/x|env-value/);
    expect(detail.envNames).toEqual(['A']);
    expect(detail.masked).toEqual({ command: [1], entrypoint: [], mounts: [0] });
    expect(detail.maskedLabels).toEqual(['app.token']);
  });

  it('reveals only what was masked', () => {
    expect(secretValue(container, 'command', '1')).toBe('pw');
    expect(secretValue(container, 'command', '0')).toBeNull();
    expect(secretValue(container, 'label', 'app.token')).toBe('t');
    expect(secretValue(container, 'label', 'plain')).toBeNull();
    expect(secretValue(container, 'label', 'toString')).toBeNull();
    expect(secretValue(container, 'mount', '0')).toBe('/secrets/x');
    expect(secretValue(container, 'mount', '1')).toBeNull();
    expect(secretValue(container, 'entrypoint', '1e0')).toBeNull();
  });
});
