#!/usr/bin/env node

const { firefox } = require('playwright');
const path = require('path');
require('dotenv').config();

const loginUrl = process.env.WORK_LOGIN_URL || 'https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/';
const username = process.env.WORK_USERNAME;
const password = process.env.WORK_PASSWORD;

if (!username || !password) {
  console.error('ERROR: Set credentials in .env');
  process.exit(1);
}

console.log('Starting login automation...');

(async () => {
  const context = await firefox.launchPersistentContext(
    path.join(__dirname, 'user_data'),
    {
      headless: false,
      viewport: { width: 1400, height: 900 },
      firefoxUserPrefs: {
        'dom.webdriver.enabled': false,
        'useAutomationExtension': false
      }
    }
  );

  const page = await context.newPage();

  console.log('Loading Citrix...');
  await page.goto(loginUrl, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(5000);

  console.log('URL:', page.url().split('?')[0].slice(-40));

  let stage = 0;
  let lastUrl = '';

  while (true) {
    try {
      const url = page.url();
      
      if (url !== lastUrl) {
        console.log(`\n→ ${url.split('?')[0].slice(-50)}`);
        lastUrl = url;
      }

      // SUCCESS - Citrix Store
      if (url.includes('/Citrix/StoreWeb') || (url.includes('/Citrix/') && !url.includes('login') && !url.includes('saml') && !url.includes('microsoft') && !url.includes('safenet'))) {
        console.log('\n✅ SUCCESS: Logged into Citrix!');
        break;
      }

      // SAML redirect - wait for Microsoft
      if (url.includes('saml2') || url.includes('/saml/')) {
        console.log('.');
      }

      // 1. Email stage (Microsoft)
      if (stage === 0) {
        try {
          const emailInp = page.locator('input[name="loginfmt"], input[type="email"]').first();
          if (await emailInp.isVisible({ timeout: 3000 })) {
            console.log('📧 Email...');
            await emailInp.fill(username);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(5000);
            stage = 1;
            continue;
          }
        } catch (e) {}
      }

      // 2. Password stage
      if (stage <= 1) {
        try {
          const passInp = page.locator('input[name="passwd"]').first();
          if (await passInp.isVisible({ timeout: 3000 })) {
            console.log('🔐 Password...');
            await passInp.fill(password);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(8000);
            stage = 2;
            continue;
          }
        } catch (e) {}
      }

      // 3. Stay signed in
      if (stage <= 2) {
        try {
          const yesBtn = page.locator('input[value="Yes"]').first();
          if (await yesBtn.isVisible({ timeout: 2000 })) {
            console.log('✅ Yes...');
            await yesBtn.click();
            await page.waitForTimeout(3000);
            stage = 3;
            continue;
          }
        } catch (e) {}
      }

      // 4. MFA - multiple possible providers
      const mfaProviders = [
        { name: 'Microsoft', pattern: 'Authenticator' },
        { name: 'SafeNet', pattern: 'safenet' },
        { name: 'MobileIron', pattern: 'MobileIron' },
        { name: 'Duo', pattern: 'Duo' },
        { name: 'Okta', pattern: 'Okta' },
        { name: 'Verify', pattern: 'verification' }
      ];

      for (const mfa of mfaProviders) {
        const mfaEl = page.locator(`text=${mfa.pattern}`).first();
        if (await mfaEl.isVisible({ timeout: 1000 }).catch(() => false)) {
          console.log(`\n⚠️ MFA REQUIRED (${mfa.name})!`);
          console.log('=====================================');
          console.log('Complete MFA in browser or on phone');
          console.log('=====================================');
          
          // Wait for MFA completion
          for (let i = 0; i < 72; i++) { // 6 min max
            await page.waitForTimeout(5000);
            const curUrl = page.url();
            
            if (curUrl.includes('/Citrix/StoreWeb') || (curUrl.includes('/Citrix/') && !curUrl.includes('login') && !curUrl.includes('microsoft') && !curUrl.includes('safenet'))) {
              console.log('\n✅ SUCCESS! Citrix reached!');
              break;
            }
            
            if (!curUrl.includes('login.') && !curUrl.includes('saml') && !curUrl.includes('safenet') && !curUrl.includes('auth')) {
              console.log('\nGot:', curUrl.slice(-30));
              break;
            }
            
            if (i % 6 === 0) process.stdout.write('.');
          }
          stage = 4;
          break;
        }
      }
      
      if (stage === 4) break;

      await page.waitForTimeout(2000);
      
    } catch (e) {
      console.log('Error:', e.message);
      if (e.message.includes('closed')) break;
    }
  }

  console.log('\n--- Final URL:', page.url());
  console.log('✅ Done!');
  
})();