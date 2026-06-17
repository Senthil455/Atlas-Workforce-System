import { test, expect } from '@playwright/test';

test.describe('LMS Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', 'admin@atlas.io');
    await page.fill('input[type="password"]', 'ChangeMe123!');
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('navigate to LMS dashboard', async ({ page }) => {
    await page.goto('/dashboard/lms');
    await expect(page.locator('h1')).toContainText('Learning Management');
    await expect(page.getByText('Manage courses, certifications')).toBeVisible();
  });

  test('browse courses catalog', async ({ page }) => {
    await page.goto('/dashboard/lms/courses');
    await expect(page.locator('h1')).toContainText('Courses');

    const courseCards = page.locator('a[href*="/dashboard/lms/courses/"]');
    const count = await courseCards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('enroll in a course', async ({ page }) => {
    await page.goto('/dashboard/lms/courses');
    await expect(page.locator('h1')).toContainText('Courses');

    const enrollButton = page.locator('button:has-text("Enroll"), a:has-text("Enroll")').first();
    await enrollButton.waitFor({ state: 'visible', timeout: 5000 });
    await enrollButton.click();
    await expect(page.getByText(/enrolled|Enrolled|successfully/i)).toBeVisible();

    await page.goto('/dashboard/lms');
    await expect(page.locator('h1')).toContainText('Learning Management');
  });
});
