import { test, expect } from '@playwright/test';

const E2E_USER = process.env.E2E_USER || 'admin@atlas.io';
const E2E_PASS = process.env.E2E_PASS || 'ChangeMe123!';

test.describe('ATS Workflow', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/login');
    await page.fill('input[type="email"]', E2E_USER);
    await page.fill('input[type="password"]', E2E_PASS);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/.*dashboard/);
  });

  test('navigate to ATS dashboard', async ({ page }) => {
    await page.goto('/dashboard/ats');
    await expect(page.locator('h1')).toContainText('ATS Dashboard');
    await expect(page.getByText('Applicant tracking overview')).toBeVisible();
  });

  test('create a job posting', async ({ page }) => {
    await page.goto('/dashboard/ats/jobs');
    await expect(page.locator('h1')).toContainText('Jobs');

    await page.click('button:has-text("Create Job")');
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.fill('#title', 'Senior Software Engineer');
    await page.selectOption('#department', 'Engineering');
    await page.fill('#location', 'San Francisco, CA');
    await page.selectOption('#type', 'full-time');
    await page.fill('#salaryMin', '150000');
    await page.fill('#salaryMax', '220000');
    await page.fill('textarea[id="description"]', 'We are looking for a Senior Software Engineer to join our platform team.');
    await page.fill('textarea[id="requirements"]', '5+ years experience, TypeScript, React, Node.js');

    await page.click('button[type="submit"]:has-text("Create Job")');

    await expect(page.getByText('Job created successfully')).toBeVisible();
  });

  test('publish a job and view in listings', async ({ page }) => {
    await page.goto('/dashboard/ats/jobs');

    await page.click('button:has-text("Create Job")');
    await page.fill('#title', 'DevOps Engineer');
    await page.selectOption('#department', 'Engineering');
    await page.fill('#location', 'Remote');
    await page.selectOption('#type', 'full-time');
    await page.fill('textarea[id="description"]', 'Infrastructure and DevOps role.');
    await page.click('button[type="submit"]:has-text("Create Job")');
    await expect(page.getByText('Job created successfully')).toBeVisible();

    await page.goto('/dashboard/ats/jobs');
    await expect(page.getByText('DevOps Engineer')).toBeVisible();
  });
});
