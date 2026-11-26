import { expect, test } from '@playwright/test';
import { login } from './server.ts';

const MODALS = [
  'Credits',
  'Privacy policy',
  'Terms and conditions',
  'Cookie policy',
  'Accessibility',
];

for (const width of [360, 1280]) {
  test(`no footer modal scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await login(page);
    for (const name of MODALS) {
      await page.getByRole('button', { name, exact: true }).click();
      const body = page.locator('dialog[open] .modal__body');
      await expect(body).toBeVisible();
      const overflow = await body.evaluate((el) => {
        // Text hidden for all but screen readers is clipped on purpose, so it never shows.
        const clipped = (node: Element) => {
          for (let at: Element | null = node; at; at = at.parentElement) {
            if (getComputedStyle(at).clipPath !== 'none') return true;
          }
          return false;
        };
        const wider = [...el.querySelectorAll<HTMLElement>('*')].filter(
          (child) =>
            !clipped(child) && child.clientWidth > 1 && child.scrollWidth > child.clientWidth + 1,
        );
        return { body: el.scrollWidth - el.clientWidth, wider: wider.map((c) => c.className) };
      });
      expect(overflow, name).toEqual({ body: 0, wider: [] });
      await page.keyboard.press('Escape');
    }
  });
}

test('Credits shows the telescope logo in a circle', async ({ page }) => {
  await login(page);
  await page.getByRole('button', { name: 'Credits' }).click();
  const logo = page.locator('dialog[open] .creator__logo img');
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  expect(
    await page
      .locator('dialog[open] .creator__logo')
      .evaluate((el) => getComputedStyle(el).borderRadius),
  ).toBe('50%');
});
