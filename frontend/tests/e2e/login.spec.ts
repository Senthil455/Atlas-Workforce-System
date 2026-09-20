import { test, expect } from '@playwright/test';

const E2E_USER = process.env.E2E_USER || 'admin@atlas.io';
const E2E_PASS = process.env.E2E_PASS || 'ChangeMe123!';

test('has title', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/Atlas/);
});

test('can log in', async ({ page }) => {
  await page.goto('/login');
  
  await page.fill('input[type="email"]', E2E_USER);
  await page.fill('input[type="password"]', E2E_PASS);
  
  await page.click('button[type="submit"]');
  
  await expect(page).toHaveURL(/.*dashboard/);
});
