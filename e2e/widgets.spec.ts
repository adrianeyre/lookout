import { createHash } from 'node:crypto';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { E2E_PORT, login, siteUrl } from './server.ts';

const widget = (page: Page, id: string) => page.locator(`[data-widget="${id}"]`);
const cell = (page: Page, id: string) =>
  widget(page, id).evaluate((el) => ({ column: el.style.gridColumn, row: el.style.gridRow }));

async function dragBar(page: Page, id: string, by: { x: number; y: number }, drop = true) {
  const bar = widget(page, id).locator('.widget__bar');
  const box = (await bar.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(start.x + (by.x * step) / 8, start.y + (by.y * step) / 8);
  }
  if (drop) await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await login(page);
  await expect(page.getByTestId('memory-card')).toBeVisible();
});

test('a Widget dragged by its bar lands where it is dropped, and stays there', async ({ page }) => {
  expect((await cell(page, 'host.disks')).column).toBe('9 / span 4');
  await dragBar(page, 'host.disks', { x: -800, y: 0 }, false);
  await expect(page.locator('.widget-placeholder')).toBeVisible();
  await page.mouse.up();
  await expect(page.locator('.widget-placeholder')).toHaveCount(0);
  expect((await cell(page, 'host.disks')).column).toBe('1 / span 4');

  await page.reload();
  await expect(page.getByTestId('memory-card')).toBeVisible();
  expect((await cell(page, 'host.disks')).column).toBe('1 / span 4');
});

test('Escape cancels a drag', async ({ page }) => {
  await dragBar(page, 'host.disks', { x: -800, y: 0 }, false);
  await page.keyboard.press('Escape');
  await page.mouse.up();
  expect((await cell(page, 'host.disks')).column).toBe('9 / span 4');
});

test('the Widgets a change moves glide to their new places', async ({ page }) => {
  await page.getByRole('button', { name: 'Move Overview' }).focus();
  await page.keyboard.press('ArrowDown');
  const gliding = await widget(page, 'host.memory').evaluate((el) => el.getAnimations().length);
  expect(gliding).toBeGreaterThan(0);
});

test('with reduced motion, nothing glides', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByRole('button', { name: 'Move Overview' }).focus();
  await page.keyboard.press('ArrowDown');
  const gliding = await widget(page, 'host.memory').evaluate((el) => el.getAnimations().length);
  expect(gliding).toBe(0);
});

test('a pinned Widget stays in view as the page scrolls', async ({ page }) => {
  await page.getByRole('button', { name: 'Pin CPU to the top' }).click();
  await page.mouse.wheel(0, 2000);
  await page.waitForTimeout(200);
  const top = await widget(page, 'host.cpu').evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(100);
});

test('on a phone, Widgets stack in order with no sideways scroll', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.locator('.widget__grip').first()).toBeHidden();
  const tops = await page
    .locator('.widget-zone[data-zone="main"] .widget')
    .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().top));
  expect(tops).toEqual([...tops].sort((a, b) => a - b));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});

/** The shop site's Site Stats page: a Hosted Site's ID is its URL's SHA-256, cut to 16. */
const shopStats = `/websites/${createHash('sha256').update(siteUrl(E2E_PORT)).digest('hex').slice(0, 16)}`;

for (const path of [
  '/',
  '/containers',
  '/containers/c0ffee000001',
  '/websites',
  shopStats,
  '/settings',
]) {
  test(`the Widgets on ${path} meet WCAG 2.2 AA`, async ({ page }) => {
    await page.goto(path);
    await expect(page.locator('.widget').first()).toBeVisible();
    await page.getByRole('button', { name: 'Menu' }).click();
    await page.getByRole('menuitem', { name: 'Widgets' }).click();
    await expect(page.getByRole('menu', { name: 'Widgets' })).toBeVisible();
    const results = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    expect(results.violations.map((v) => `${v.id} ${JSON.stringify(v.nodes[0]?.target)}`)).toEqual(
      [],
    );
  });
}

const tilt = (page: Page, id: string) =>
  widget(page, id).evaluate((el) => {
    const matrix = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return Math.round(((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI) * 10) / 10;
  });

test('a Widget being dragged tilts, and stands straight again once dropped', async ({ page }) => {
  await dragBar(page, 'host.memory', { x: -300, y: 40 }, false);
  expect(await tilt(page, 'host.memory')).toBe(1.5);
  await page.mouse.up();
  expect(await widget(page, 'host.memory').evaluate((el) => getComputedStyle(el).transform)).toBe(
    'none',
  );
});

const shaking = (page: Page, id: string) =>
  widget(page, id).evaluate(
    (el) =>
      el
        .getAnimations()
        .filter((animation) =>
          (animation.effect as KeyframeEffect)
            .getKeyframes()
            .some((frame) => String(frame.transform).includes('rotate')),
        ).length,
  );

test('the Widgets beside a dropped one shake', async ({ page }) => {
  await dragBar(page, 'host.overview', { x: 0, y: 380 });
  const others = ['host.cpu', 'host.memory', 'host.disks', 'host.diskIo', 'host.network'];
  const shaken = (await Promise.all(others.map((id) => shaking(page, id)))).filter((n) => n > 0);
  expect(shaken.length).toBeGreaterThan(0);
  expect(await shaking(page, 'host.overview')).toBe(0);
});

test('with reduced motion, nothing shakes', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await dragBar(page, 'host.overview', { x: 0, y: 380 });
  for (const id of ['host.cpu', 'host.memory', 'host.disks', 'host.diskIo', 'host.network']) {
    expect(await shaking(page, id), id).toBe(0);
  }
});

test('a Widget dropped far below the others leaves no blank row or hole', async ({ page }) => {
  await dragBar(page, 'host.cpu', { x: 0, y: 2000 });
  const layout = await page.evaluate(
    () =>
      (
        JSON.parse(localStorage.getItem('lookout.grid.host')!) as {
          widgets: Record<
            string,
            { x: number; y: number; h: number; zone: string; hidden: boolean }
          >;
        }
      ).widgets,
  );
  const shown = Object.values(layout).filter((w) => w.zone === 'main' && !w.hidden);
  const bottom = Math.max(...shown.map((w) => w.y + w.h));
  for (let row = 0; row < bottom; row++) {
    expect(
      shown.some((w) => w.y <= row && row < w.y + w.h),
      `row ${row}`,
    ).toBe(true);
  }
  // And as drawn, once the Widgets have glided into place: no band without a Widget in it.
  await page.waitForFunction(() => document.getAnimations().length === 0);
  const gaps = await page.locator('.widget-zone[data-zone="main"] .widget').evaluateAll((els) => {
    const spans = els
      .map((el) => el.getBoundingClientRect())
      .map((r) => [r.top, r.bottom] as const)
      .sort((a, b) => a[0] - b[0]);
    let reach = spans[0]![1];
    let widest = 0;
    for (const [top, bottom] of spans.slice(1)) {
      widest = Math.max(widest, top - reach);
      reach = Math.max(reach, bottom);
    }
    return widest;
  });
  // Each frame reaches down to the one under it, so only the gap between them is left.
  expect(gaps).toBeLessThanOrEqual(13);
});

async function dragCorner(page: Page, id: string, by: { x: number; y: number }) {
  const corner = widget(page, id).locator('.widget__resize');
  // In the middle of the window, clear of the sticky footer, once the page has settled after
  // the last change (a taller Grid makes the browser adjust the scroll a frame later).
  await corner.evaluate((el) => el.scrollIntoView({ block: 'center', behavior: 'instant' }));
  // Pressed in the same instant as the scroll, the corner is not yet where it is drawn.
  await page.waitForTimeout(150);
  const box = (await corner.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 8; step++) {
    await page.mouse.move(start.x + (by.x * step) / 8, start.y + (by.y * step) / 8);
  }
  await page.mouse.up();
}

const rows = async (page: Page, id: string) =>
  Number(/span (\d+)/.exec((await cell(page, id)).row)![1]);

test('a Widget made much taller can be made smaller again', async ({ page }) => {
  const start = await rows(page, 'host.cpu');
  await dragCorner(page, 'host.cpu', { x: 0, y: 600 });
  const tall = await rows(page, 'host.cpu');
  expect(tall).toBeGreaterThan(start + 10);

  await dragCorner(page, 'host.cpu', { x: 0, y: -500 });
  const smaller = await rows(page, 'host.cpu');
  expect(smaller).toBeLessThan(tall - 8);

  // Even shorter than its content, which then scrolls inside it.
  await dragCorner(page, 'host.cpu', { x: 0, y: -400 });
  expect(await rows(page, 'host.cpu')).toBeLessThan(start);
  const scrolls = await widget(page, 'host.cpu')
    .locator('.widget__body')
    .evaluate((el) => el.scrollHeight > el.clientHeight);
  expect(scrolls).toBe(true);
});

test('the Menu’s Widgets side menu shows, hides and resets the Widgets', async ({ page }) => {
  await page.getByRole('button', { name: 'Menu' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Widgets' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const side = page.getByRole('menu', { name: 'Widgets' });
  await expect(side.getByRole('menuitemcheckbox', { name: 'Overview' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(widget(page, 'host.overview')).toHaveCount(0);
  await expect(side.getByRole('menuitemcheckbox', { name: 'Overview' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(widget(page, 'host.overview')).toHaveCount(1);
});

test('on a phone, the Widgets side menu opens in place, on screen', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: 'Widgets' }).click();
  const side = page.getByRole('menu', { name: 'Widgets' });
  await expect(side).toBeVisible();
  const box = (await side.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
});
