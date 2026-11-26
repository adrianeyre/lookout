import { describe, expect, it } from 'vitest';
import { containerPath, routeFor } from './router.ts';

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
  });

  it('round-trips a Container path', () => {
    expect(routeFor(containerPath('my.app_1'))).toEqual({ name: 'container', id: 'my.app_1' });
  });
});
