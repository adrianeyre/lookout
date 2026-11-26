import { describe, expect, it } from 'vitest';
import { containerPath, routeFor, sitePath } from './router.ts';

describe('routeFor', () => {
  it('maps every page', () => {
    expect(routeFor('/')).toEqual({ name: 'host' });
    expect(routeFor('/containers/')).toEqual({ name: 'containers' });
    expect(routeFor('/login')).toEqual({ name: 'login' });
    expect(routeFor('/websites')).toEqual({ name: 'websites' });
    expect(routeFor('/settings')).toEqual({ name: 'settings' });
    expect(routeFor('/containers/abc123')).toEqual({ name: 'container', id: 'abc123' });
    expect(routeFor('/nope')).toBeNull();
    expect(routeFor('/containers/a/b')).toBeNull();
    expect(routeFor('/websites/0123456789abcdef')).toEqual({
      name: 'site',
      id: '0123456789abcdef',
    });
    expect(routeFor('/websites/a/b')).toBeNull();
    expect(routeFor('/websites/%zz')).toBeNull();
  });

  it('round-trips a Site Stats path', () => {
    expect(sitePath('0123456789abcdef')).toBe('/websites/0123456789abcdef');
    expect(routeFor(sitePath('a b'))).toEqual({ name: 'site', id: 'a b' });
  });

  it('round-trips a Container path', () => {
    expect(routeFor(containerPath('my.app_1'))).toEqual({ name: 'container', id: 'my.app_1' });
  });
});
