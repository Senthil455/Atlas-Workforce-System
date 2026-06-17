import { test, expect } from '@playwright/test';

test.describe('Compliance Dashboard', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@atlas.io');
    await page.fill('input[type="password"]', 'ChangeMe123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('navigate to compliance dashboard', async ({ page }) => {
    await page.goto('/dashboard/compliance');
    await expect(page.locator('h1')).toContainText(/compliance|Compliance/i);
  });

  test('view audit logs section', async ({ page }) => {
    await page.goto('/dashboard/compliance');
    await expect(page.locator('h1')).toContainText(/compliance|Compliance/i);

    const auditLink = page.locator('a:has-text("Audit"), button:has-text("Audit")').first();
    await auditLink.waitFor({ state: 'visible', timeout: 5000 });
    await auditLink.click();
    await expect(page).toHaveURL(/.*audit.*/i);
  });

  test('check compliance policies', async ({ page }) => {
    await page.goto('/dashboard/compliance');

    const policiesLink = page.locator(
      'a:has-text("Policy"), a:has-text("Policies"), button:has-text("Policy"), button:has-text("Policies")'
    ).first();
    await policiesLink.waitFor({ state: 'visible', timeout: 5000 });
    await policiesLink.click();
    await expect(page).toHaveURL(/.*policies.*|.*policy.*/i);
  });
});
