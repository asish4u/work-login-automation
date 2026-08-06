#!/usr/bin/env node
const { firefox } = require('playwright');
const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
require('dotenv').config();

const LOGIN_URL = process.env.WORK_LOGIN_URL || 'https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/';
const USERNAME = process.env.WORK_USERNAME;
const PASSWORD = process.env.WORK_PASSWORD;

if (!USERNAME || !PASSWORD) {
  console.error('ERROR: Set WORK_USERNAME and WORK_PASSWORD in .env');
  process.exit(1);
}

console.log('Starting login automation...');

(async () => {
  const userDataDir = path.join(__dirname, 'user_data');
  const context = await firefox.launchPersistentContext(userDataDir, {
    headless: false,
    viewport: { width: 1400, height: 900 },
    firefoxUserPrefs: {
      'dom.webdriver.enabled': false,
      'useAutomationExtension': false
    }
  });
  const page = await context.newPage();

  let icaFilePath = null;
  context.on('download', async (download) => {
    const suggested = download.suggestedFilename();
    if (suggested.endsWith('.ica') || suggested.endsWith('.ics')) {
      console.log('\n[DOWNLOAD] File download started: ' + suggested);
      icaFilePath = path.join('/Users/nayak/Downloads', suggested);
      await download.saveAs(icaFilePath);
      console.log('[DOWNLOAD] File saved to: ' + icaFilePath);
      const workspacePaths = ['/Applications/Citrix Workspace.app', '/Applications/Citrix Receiver.app'];
      for (const appPath of workspacePaths) {
        if (fs.existsSync(appPath)) {
          console.log('[LAUNCH] Launching Citrix with: ' + appPath);
          exec('open "' + appPath + '" "' + icaFilePath + '"', (err) => {
            if (err) console.log('Launch error:', err.message);
            else console.log('[LAUNCH] Citrix session launched!');
          });
          return;
        }
      }
      console.log('[WARN] Citrix Workspace/Receiver not found. Please launch manually.');
    }
  });

  console.log('Loading Citrix...');
  await page.goto(LOGIN_URL, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  // State tracking
  let emailSubmitted = false;
  let passwordSubmitted = false;
  let mfaCompleted = false;
  let citrixReached = false;

  for (let attempt = 0; attempt < 120; attempt++) {
    await page.waitForTimeout(2000);
    const url = page.url();
    console.log('\n[' + attempt + '] URL: ' + url);

    // 1. Email page (SAML/ADFS/Microsoft) - submit username
    // Microsoft uses input[name="loginfmt"]; ADFS uses input[name="UserName"]
    const emailSelectors = [
      'input[name="loginfmt"]',
      'input[name="UserName"]',
      'input[name="Email"]',
      'input[id="i0116"]',
      'input[type="email"]'
    ];
    let emailField = null;
    for (const selector of emailSelectors) {
      const input = page.locator(selector).first();
      if (await input.isEnabled({ timeout: 1000 }).catch(() => false)) {
        emailField = input;
        break;
      }
    }
    if (emailField) {
      console.log('[STEP] Email page detected, filling...');
      await emailField.fill(USERNAME);
      await page.keyboard.press('Enter');
      emailSubmitted = true;
      await page.waitForTimeout(3000);
      continue;
    }

    // 2. Password page - submit password (after email submitted)
    // Microsoft uses input[name="passwd"]; ADFS uses input[name="Password"]
    const passSelectors = [
      'input[name="passwd"]',
      'input[name="Password"]',
      'input[id="i0118"]',
      'input[type="password"]'
    ];
    let passField = null;
    for (const selector of passSelectors) {
      const input = page.locator(selector).first();
      if (await input.isEnabled({ timeout: 1000 }).catch(() => false)) {
        passField = input;
        break;
      }
    }
    if (passField) {
      console.log('[STEP] Password page detected, filling...');
      await passField.fill(PASSWORD);
      await page.keyboard.press('Enter');
      passwordSubmitted = true;
      await page.waitForTimeout(5000);
      continue;
    }

    // 3. "Stay signed in" page - ONLY after password submitted
    const staySelectors = [
      'input[id="idSIButton9"]',
      'button:has-text("Yes")',
      'button:has-text("Stay signed in")'
    ];
    let stayField = null;
    for (const selector of staySelectors) {
      const btn = page.locator(selector).first();
      if (await btn.isEnabled({ timeout: 1000 }).catch(() => false)) {
        stayField = btn;
        break;
      }
    }
    if (passwordSubmitted && stayField) {
      console.log('[STEP] Stay signed in page, clicking Yes...');
      await stayField.click();
      await page.waitForTimeout(3000);
      continue;
    }

    // 4. MFA/Verification page - manual intervention
    const mfaIndicators = ['mfa', 'verification', 'authmethod', 'MFAREQUIRED', 'factor', 'challenge'];
    const isMfaPage = mfaIndicators.some(indicator => url.includes(indicator));
    if (isMfaPage && !mfaCompleted) {
      console.log('\n[MFA] =====================================');
      console.log('   MFA/Verification page detected');
      console.log('   Complete MFA in browser (phone/app)');
      console.log('   =====================================\n');
      mfaCompleted = true;
    }
    if (isMfaPage) {
      await page.waitForTimeout(5000);
      continue;
    }

    // 5. Citrix LogonPoint page (tmindex.html) - may need click
    if (url.includes('LogonPoint/tmindex.html')) {
      console.log('[STEP] Citrix tmindex.html - looking for login button...');
      const loginBtn = page.locator('button:has-text("Log On"), button:has-text("Login"), button:has-text("Sign In"), a:has-text("Log On"), input[type="submit"], [href*="saml"]').first();
      if (await loginBtn.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log('Clicking login button...');
        await loginBtn.click();
        await page.waitForTimeout(5000);
      }
      continue;
    }

    // 6. Citrix StoreWeb - success, look for ACFC Desktop
    if (url.includes('Citrix/PRDStoreWeb') || url.includes('Citrix/StoreWeb')) {
      if (!citrixReached) {
        console.log('\n[SUCCESS] Citrix StoreWeb reached!');
        citrixReached = true;
      }
      console.log('[STEP] Looking for ACFC Desktop to launch...');

      const appSelectors = [
        'text="ACFC Desktop"',
        'text="ACFC"',
        'text="Desktop"',
        '[data-app-name*="ACFC" i]',
        '[data-app-name*="Desktop" i]',
        '.app-item:has-text("ACFC")',
        '.app-item:has-text("Desktop")',
        'button:has-text("ACFC Desktop")',
        'a:has-text("ACFC Desktop")',
        '.store-app-icon:has-text("Desktop")'
      ];

      let launched = false;
      for (const selector of appSelectors) {
        try {
          const app = page.locator(selector).first();
          if (await app.isVisible({ timeout: 2000 }).catch(() => false)) {
            console.log('Found app: ' + selector);
            const [download] = await Promise.all([
              page.waitForEvent('download', { timeout: 30000 }),
              app.click()
            ]);
            launched = true;
            break;
          }
        } catch (e) { }
      }

      // Fallback: click any Launch button
      if (!launched) {
        const launchBtns = [
          'button:has-text("Launch")',
          'button:has-text("Open")',
          '[data-automation="launch-button"]',
          'button[title*="Launch" i]',
          '.launch-button',
          'button:has-text("Desktop")',
          '.app-card button',
          '.store-app-icon button'
        ];
        for (const selector of launchBtns) {
          try {
            const btn = page.locator(selector).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
              console.log('Clicking launch button: ' + selector);
              const [download] = await Promise.all([
                page.waitForEvent('download', { timeout: 30000 }),
                btn.click()
              ]);
              launched = true;
              break;
            }
          } catch (e) { }
        }
      }

      if (!launched) {
        console.log('[WAIT] No app clicked, waiting for any download...');
        await page.waitForTimeout(10000);
      }

      if (icaFilePath) {
        await page.waitForTimeout(3000);
        console.log('\n[DONE] Automation complete!');
        break;
      }
      continue;
    }

    console.log('[WAIT] Waiting...');
  }

  console.log('\n--- Final URL:', page.url());
  await page.waitForTimeout(2000);
  await context.close();
})();