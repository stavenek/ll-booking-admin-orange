// @ts-check
const { test, expect } = require("@playwright/test");

const API_HOST_RE = /execute-api\.eu-north-1\.amazonaws\.com/;

async function stubApi(page) {
  await page.route(API_HOST_RE, (route) => {
    const url = route.request().url();
    if (url.includes("/bookings")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }
    if (url.includes("/slots")) {
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
    }
    return route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
}

async function login(page) {
  await page.locator("#pwd").fill("test");
  await page.locator("#setPwdBtn").click();
  await expect(page.locator("#bookingsPanel")).toBeVisible();
}

test.describe("Daily Overview reload", () => {
  test.beforeEach(async ({ page }) => {
    await stubApi(page);
    await page.goto("/");
    await login(page);
  });

  test("clicking reload on Daily Overview keeps the daily panel and does not re-show the bookings panel", async ({ page }) => {
    await page.locator('.nav-tab[data-tab="daily"]').click();

    await expect(page.locator("#dailyPanel")).toBeVisible();
    await expect(page.locator("#bookingsPanel")).toBeHidden();

    await page.locator("#reloadDailyBtn").click();

    // After the in-flight refresh resolves, the daily panel must remain the
    // only visible section panel — the bookings panel must NOT pop back in.
    await expect(page.locator("#reloadDailyBtn")).not.toHaveClass(/loading/);
    await expect(page.locator("#dailyPanel")).toBeVisible();
    await expect(page.locator("#bookingsPanel")).toBeHidden();
  });
});
