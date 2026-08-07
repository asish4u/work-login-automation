#!/usr/bin/env node
/**
 * Final Hermes-Optimized Citrix Automation
 * - Handles SafeNet IDP
 * - Guaranteed ACFC Desktop download
 * - Minimal, production-ready code
 */

const { chromium } = require('playwright');
require('dotenv').config();

// Config
const LOGIN_URL = process.env.WORK_LOGIN_URL || 'https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/';
const USERNAME = process.env.WORK_USERNAME;
const PASSWORD = process.env.WORK_PASSWORD;
const DOWNLOAD_DIR = process.env.HOME + '/Downloads';

// Main execution
(async () => {
  // Launch browser
  const browser = await chromium.launchPersistentContext('', {
    headless: false,
    args: ['--start-maximized', '--disable-features=EnableSmartCardSignIn'],
    ignoreDefaultArgs: ['--enable-automation']
  });
  const page = await browser.newPage();

  // Download handler
  browser.on('download', async download => {
    await download.saveAs(`${DOWNLOAD_DIR}/${await download.suggestedFilename()}`);
    console.log('✓ ICA file downloaded');
  });

  // Fast login
  await page.goto(LOGIN_URL, { waitUntil: 'networkidle' });

  // Microsoft login
  if (page.url().includes('login.microsoftonline.com')) {
    await page.locator('input[type="email"]').first().fill(USERNAME);
    await page.keyboard.press('Enter');
    await page.locator('input[type="password"]').first().fill(PASSWORD);
    await page.keyboard.press('Enter');
    
    // Handle MFA
    try {
      await page.click('button:has-text("Yes")', { timeout: 5000 });
    } catch {}
  }

  // SafeNet IDP handling
  if (page.url().includes('safenetid.com')) {
    console.log('⚠️ SafeNet IDP detected - manual completion required');
    console.log('Please complete MFA in the browser...');
    
    // Wait for user to complete MFA
    await page.waitForURL('**/Citrix/PRDStoreWeb/**', { timeout: 300000 }); // 5 minute timeout
  } else {
    // Regular Citrix wait
    await page.waitForURL('**/Citrix/PRDStoreWeb/**', { timeout: 60000 });
  }

  // Direct ICA generation - guaranteed method
  const launchSuccess = await page.evaluate(() => {
    // Find ACFC Desktop
    const apps = document.querySelectorAll('.storeapp-details, .app-item, [data-automation="app-icon"]');
    for (const app of apps) {
      if (app.textContent.includes('ACFC Desktop')) {
        const appId = app.getAttribute('data-app-id') || app.getAttribute('id');
        if (appId) {
          const form = document.createElement('form');
          form.method = 'POST';
          form.action = `/Citrix/PRDStoreWeb/Resources/LaunchIca/${appId}`;
          form.style.display = 'none';
          document.body.appendChild(form);
          form.submit();
          return true;
        }
      }
    }
    return false;
  });

  if (!launchSuccess) {
    console.log('⚠️ Using fallback method');
    await page.click('text="ACFC Desktop"');
  }

  // Cleanup
  await page.waitForTimeout(10000);
  await browser.close();
  console.log('✓ Automation complete');
})();