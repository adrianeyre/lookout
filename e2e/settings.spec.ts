import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { login } from './server.ts';

const MODES = ['Light', 'Dark'] as const;
const THEMES = ['Teal', 'Ocean', 'Violet', 'Rose', 'Forest', 'Slate'] as const;

test('the Menu opens Settings from the keyboard', async ({ page }) => {
  await login(page);
  const menu = page.getByRole('button', { name: 'Menu' });
  await menu.focus();
  await page.keyboard.press('Enter');
  // Widgets comes first, then Settings.
  await expect(page.getByRole('menuitem', { name: 'Widgets' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await expect(page.getByRole('menu')).toHaveCount(0);

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('radio', { name: /System/ })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Teal' })).toBeChecked();
});

test('the chosen mode and theme apply at once and survive a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await login(page);
  await page.goto('/settings');
  await page.getByRole('radio', { name: /Dark/ }).check();
  await page.getByRole('radio', { name: 'Violet' }).check();
  const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(await background()).toBe('rgb(13, 17, 23)');

  await page.reload();
  expect(await page.locator('html').getAttribute('data-mode')).toBe('dark');
  expect(await page.locator('html').getAttribute('data-theme')).toBe('violet');
  expect(await background()).toBe('rgb(13, 17, 23)');
  await expect(page.getByRole('radio', { name: 'Violet' })).toBeChecked();

  await page.getByRole('radio', { name: /System/ }).check();
  expect(await background()).toBe('rgb(246, 248, 250)');
});

// WCAG 2.2 AA on every mode and theme, on the Host and Settings pages.
for (const mode of MODES) {
  test(`every theme meets WCAG 2.2 AA in ${mode}`, async ({ page }) => {
    await login(page);
    for (const theme of THEMES) {
      await page.goto('/settings');
      await page.getByRole('radio', { name: new RegExp(`^${mode}`) }).check();
      await page.getByRole('radio', { name: theme }).check();
      for (const path of ['/settings', '/']) {
        if (path !== '/settings') await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        if (path === '/') await expect(page.getByTestId('memory-card')).toBeVisible();
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations.map(
            (v) => `${mode}/${theme} ${path}: ${v.id} ${JSON.stringify(v.nodes[0]?.target)}`,
          ),
        ).toEqual([]);
      }
    }
  });
}
