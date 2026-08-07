#!/usr/bin/env node
/**
 * Citrix Work Login Automation — canonical script
 *
 * Flow (matches the documented manual process):
 *   1. Open https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/
 *   2. Username page  -> fill your_email@domain.com -> Next
 *   3. Password page  -> fill password -> Sign in
 *   4. Verification page -> click "Continue"
 *   5. 2FA page -> WAIT (human types the code in the browser)
 *   6. Citrix StoreWeb -> click & download "ACFC Desktop" -> run .ica via Citrix Workspace
 *
 * Credentials are read from .env (WORK_USERNAME / WORK_PASSWORD / WORK_LOGIN_URL).
 * Secrets are never hardcoded and never committed.
 */

const { firefox } = require('playwright');
const path = require('path');
const fs = require('fs');
const { exec, execSync } = require('child_process');

const PID = process.pid;

// ── Single-instance guard (ATOMIC — no TOCTOU race) ──────────────────────
// Two concurrent runs share the same user_data profile and race each other's
// form submissions (one submits an EMPTY password, the other fills ~10s later
// and submits again). The check-then-write pattern has a race window: two
// launches within the same instant both see "no lock" and both proceed.
// We use fs.openSync(path, 'wx') — the 'x' makes creation exclusive/atomic at
// the OS level, so exactly one instance wins the lock; the loser exits. This
// makes a double-submit structurally impossible no matter how it's launched.
const LOCKFILE = path.join(__dirname, '.run.lock');
let lockFd = null;
try {
  lockFd = fs.openSync(LOCKFILE, 'wx'); // throws EEXIST if already present
  fs.writeSync(lockFd, String(PID));
} catch (e) {
  if (e && e.code === 'EEXIST') {
    const other = fs.readFileSync(LOCKFILE, 'utf8').trim();
    console.error(`[citrix][pid=${PID}] Another instance is already running (lock held by pid ${other}) — exiting to avoid a double-submit.`);
    process.exit(0);
  }
  console.error(`[citrix][pid=${PID}] WARN: could not acquire lock (${e && e.code}) — continuing.`);
}
process.on('exit', () => { try { if (lockFd !== null) fs.closeSync(lockFd); } catch (_) {} try { fs.unlinkSync(LOCKFILE); } catch (_) {} });
process.on('SIGINT', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
console.error(`[citrix][pid=${PID}] === session start, lock acquired (node ${process.version}) ===`);

// ── Cross-directory duplicate guard ──────────────────────────────────────
// The per-directory lockfile above blocks a second launch of THIS file. But a
// second copy launched from a DIFFERENT directory (different lockfile) would
// slip past it. Scan the process table for any OTHER `node login.js` and exit
// if one is already alive. (Checked AFTER the lockfile so the lock winner is
// the one that decides; the window is vanishingly small.)
try {
  const out = execSync('pgrep -f "node login.js" 2>/dev/null || true').toString().trim();
  const pids = out.split('\n').map(s => s.trim()).filter(Boolean).map(Number);
  if (pids.some(p => p !== PID)) {
    console.error(`[citrix][pid=${PID}] Another node login.js process is already running (pids: ${pids.filter(p => p !== PID).join(', ')}) — exiting.`);
    process.exit(0);
  }
} catch (_) { /* ignore — if we can't scan, proceed */ }
require('dotenv').config();

const LOGIN_URL = process.env.WORK_LOGIN_URL || 'https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/';
const USERNAME = process.env.WORK_USERNAME;
const PASSWORD = process.env.WORK_PASSWORD;
const DOWNLOAD_DIR = process.env.HOME + '/Downloads';
const MFA_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes to complete 2FA manually

if (!USERNAME || !PASSWORD) {
  console.error('ERROR: Set WORK_USERNAME and WORK_PASSWORD in .env (see .env.example).');
  process.exit(1);
}

const log = (...a) => console.log('[citrix][pid=' + PID + ']', ...a);

// Safe wait that no-ops if the page/context has already closed (e.g. after the
// .ica launches and Citrix Workspace takes over the browser).
async function safeWait(page, ms) {
  try { await page.waitForTimeout(ms); } catch (_) {}
}

(async () => {
  const T0 = Date.now();
  const T = () => ((Date.now() - T0) / 1000).toFixed(1) + 's';
  log('Starting login automation for', USERNAME, `(t=${T()})`);

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
    if (!suggested.toLowerCase().endsWith('.ica')) return;
    log('ICA download started:', suggested);
    icaFilePath = path.join(DOWNLOAD_DIR, suggested);
    await download.saveAs(icaFilePath);
    log('ICA saved to:', icaFilePath);
    launchCitrix(icaFilePath);
  });

  /**
   * Robust fill for Entra ID / ADFS fields.
   *
   * The PRIMARY method is Playwright's native `fill()` — it dispatches the
   * correct React input events and is effectively instant (no per-char delay).
   * We then READ BACK the value; Entra's field is React-controlled, so if the
   * value didn't stick we retry (Entra sometimes swallows the first fill while
   * the field is still binding). Keystroke typing is the last-resort fallback.
   * Returns true ONLY if the field genuinely ends up holding the value.
   */
  async function fillRobust(locator, value) {
    for (let attempt = 0; attempt < 8; attempt++) {
      try {
        await locator.click({ timeout: 2000 }).catch(() => {});
        await locator.fill(value, { timeout: 3000 });
      } catch (_) {}
      const current = await locator.inputValue({ timeout: 1500 }).catch(() => '');
      if (current === value) return true;
      // value didn't stick — clear and retry shortly
      try { await locator.fill('', { timeout: 1000 }).catch(() => {}); } catch (_) {}
      await page.waitForTimeout(300);
    }
    // Fallback: real keystrokes (slow but always registers in React state)
    try {
      await locator.click({ timeout: 2000 }).catch(() => {});
      await locator.fill('', { timeout: 1500 }).catch(() => {});
      await locator.pressSequentially(value, { delay: 15 });
      const current = await locator.inputValue({ timeout: 1500 }).catch(() => '');
      return current === value;
    } catch (_) {
      return false;
    }
  }

  function launchCitrix(ica) {
    const candidates = [
      '/Applications/Citrix Workspace.app',
      '/Applications/Citrix Receiver.app'
    ];
    for (const app of candidates) {
      if (fs.existsSync(app)) {
        log('Launching Citrix with', app);
        exec(`open "${app}" "${ica}"`, (err) => {
          if (err) log('Launch error:', err.message);
          else log('Citrix Workspace session launched!');
        });
        return;
      }
    }
    log('WARN: Citrix Workspace/Receiver not found. Open the .ica manually:', ica);
  }

  log('Loading StoreWeb...');
  await page.goto(LOGIN_URL, { timeout: 60000, waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);

  // State flags
  let emailSubmitted = false;
  let passwordSubmitted = false;
  let continued = false;
  let mfaCompleted = false;
  let citrixReached = false;
  const mfaStart = Date.now();

  const clickFirst = async (selectors, { nav = true } = {}) => {
    for (const sel of selectors) {
      const el = page.locator(sel).first();
      if (await el.isEnabled({ timeout: 1500 }).catch(() => false)) {
        if (nav) {
          await Promise.all([
            page.waitForNavigation({ timeout: 15000 }).catch(() => {}),
            el.click()
          ]);
        } else {
          await el.click();
        }
        return sel;
      }
    }
    return null;
  };

  for (let attempt = 0; attempt < 180; attempt++) {
    const url = page.url();
    log(`[${attempt}] ${url} (t=${T()})`);

    // 1. Email — fill username, then click Next / Sign in.
    //    IMPORTANT: Entra sometimes renders a COMBINED email+password page
    //    where the primary button (idSIButton9) is "Sign in" and submitting it
    //    with a blank password is exactly the "empty-first-submit" symptom. We
    //    therefore only click the primary button if there is NO password field
    //    present on this page (pure email page) OR the password field already
    //    holds a value. If a blank password field coexists, we fall through to
    //    step 2 to fill it FIRST, then submit from there.
    if (!emailSubmitted) {
      const emailSel = 'input[name="loginfmt"], input[name="UserName"], input[name="Email"], input[id="i0116"], input[type="email"]';
      let field = null;
      try {
        log('email: waiting for field (t=' + T() + ')');
        await page.waitForSelector(emailSel, { state: 'visible', timeout: 30000 });
        field = page.locator(emailSel).first();
      } catch (_) {}
      if (field) {
        const ok = await fillRobust(field, USERNAME);
        log(ok ? `Filled username (t=${T()})` : `WARN: username value not confirmed (t=${T()})`);
        // Is a password field present on this same page?
        const pwdOnPage = await page.locator('input[type="password"]').first().isVisible({ timeout: 800 }).catch(() => false);
        if (pwdOnPage) {
          // Combined page: do NOT click the primary button here. Let step 2 fill
          // the password and submit it (with the password confirmed). Mark email
          // done so step 2 can run, but do NOT trigger a submit now.
          log('email: password field present on same page — deferring submit to password step (t=' + T() + ')');
          emailSubmitted = true;
          continue;
        }
        const clicked = await clickFirst([
          'input[id="idSIButton9"]', 'button[id="idSIButton9"]',
          'button:has-text("Next")', 'button:has-text("Sign in")',
          'input[type="submit"]', 'button[type="submit"]'
        ]);
        log(clicked ? 'Clicked Next' : 'No Next — pressing Enter');
        if (!clicked) {
          await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.keyboard.press('Enter')]);
        }
        emailSubmitted = true;
        continue;
      }
    }

    // 2. Password — wait for the field, fill it (instant via Playwright fill()),
    //    and submit ONLY after the value is confirmed present in the field.
    //    Forensic: log the button text and the field value at click time so a
    //    double-submit (or an empty submit) is unmistakable in the log.
    if (emailSubmitted && !passwordSubmitted) {
      const passSel = 'input[name="passwd"], input[name="Password"], input[id="i0118"], input[type="password"]';
      let field = null;
      try {
        // visible is enough; Entra's field is interactive as soon as it paints.
        await page.waitForSelector(passSel, { state: 'visible', timeout: 30000 });
        field = page.locator(passSel).first();
      } catch (_) {}
      if (field) {
        log('password: field ready, filling (t=' + T() + ')');
        // fillRobust retries internally until the value truly sticks.
        let ok = false;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          ok = await fillRobust(field, PASSWORD);
          if (!ok) { log('WARN: password not retained, retrying (t=' + T() + ')'); await page.waitForTimeout(500); }
        }
        const verifyVal = await field.inputValue({ timeout: 2000 }).catch(() => '');
        const retained = verifyVal === PASSWORD;
        if (!retained) {
          log(`WARN: password not retained (got "${verifyVal}") — NOT submitting empty form (t=${T()})`);
          passwordSubmitted = true;
          continue;
        }
        // GUARANTEE: read back the value one more time immediately before click.
        const finalVal = await field.inputValue({ timeout: 2000 }).catch(() => '');
        log(`Filled password (retained, final="${finalVal.length} chars", t=${T()})`);
        const clicked = await clickFirst([
          'input[id="idSIButton9"]', 'button[id="idSIButton9"]',
          'button:has-text("Sign in")', 'button:has-text("Log in")',
          'input[type="submit"]', 'button[type="submit"]'
        ]);
        const btnText = clicked || '(Enter pressed)';
        log(`Clicked Sign in [button=${btnText}] with password present (t=${T()})`);
        if (!clicked) {
          await Promise.all([page.waitForNavigation({ timeout: 15000 }).catch(() => {}), page.keyboard.press('Enter')]);
        }
        passwordSubmitted = true;
        continue;
      }
    }

    // 3. "Stay signed in?" (only when no password field present)
    if (passwordSubmitted && !mfaCompleted) {
      const hasPwd = await page.locator('input[type="password"]').first().isVisible({ timeout: 500 }).catch(() => false);
      if (!hasPwd) {
        const clicked = await clickFirst([
          'input[id="idSIButton9"]', 'button[id="idSIButton9"]',
          'button:has-text("Yes")', 'button:has-text("Stay signed in")'
        ]);
        if (clicked) { log('Clicked Stay-signed-in =', clicked); await page.waitForTimeout(2000); continue; }
      }
    }

    // 4. Verification page -> click "Continue"
    const verifyIndicators = ['verification', 'proofup', 'mfa', 'authmethod', 'securityverification', 'factor', 'challenge'];
    const isVerify = verifyIndicators.some(i => url.toLowerCase().includes(i));
    if (isVerify && !continued) {
      log('Verification page detected — looking for "Continue"...');
      const clicked = await clickFirst([
        'button:has-text("Continue")', 'a:has-text("Continue")',
        'input[type="submit"]', 'button[type="submit"]'
      ], { nav: false });
      if (clicked) { log('Clicked Continue ->', clicked); continued = true; await page.waitForTimeout(3000); continue; }
    }

    // 5. 2FA — manual. Wait for human to enter code and land on StoreWeb.
    if (isVerify || url.toLowerCase().includes('mfa')) {
      if (!mfaCompleted) {
        log('');
        log('=== 2FA REQUIRED ===');
        log('Please enter your authentication code in the browser window.');
        log('Automation will resume automatically once Citrix StoreWeb loads.');
        log('');
        mfaCompleted = true;
      }
      if (Date.now() - mfaStart > MFA_TIMEOUT_MS) {
        log('TIMEOUT: 2FA not completed within 5 minutes. Exiting.');
        break;
      }
      await page.waitForTimeout(5000);
      continue;
    }

    // 6. Citrix StoreWeb reached
    if (url.includes('Citrix/PRDStoreWeb') || url.includes('Citrix/StoreWeb')) {
      if (!citrixReached) { log('SUCCESS: Citrix StoreWeb reached.'); citrixReached = true; }

      // Launch ACFC Desktop (downloads the .ica which auto-opens Citrix Workspace)
      const appSelectors = [
        'text="ACFC Desktop"', 'a:has-text("ACFC Desktop")', 'button:has-text("ACFC Desktop")',
        '[data-app-name*="ACFC" i]', '.app-item:has-text("ACFC")', '.store-app-icon:has-text("Desktop")'
      ];
      let launched = false;

      // Strategy 1: click the *clickable* element that contains the ACFC text.
      for (const sel of appSelectors) {
        try {
          const el = page.locator(sel).first();
          if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
            log('Found ACFC Desktop via', sel);
            // Prefer the nearest ancestor that actually handles the click
            // (the text node alone often isn't the launch handler).
            const clickable = el.locator('xpath=ancestor::a | xpath=ancestor::button | xpath=ancestor::*[contains(@class,"storeapp")] | xpath=ancestor::*[contains(@class,"app")]').last();
            const target = (await clickable.count()) ? clickable : el;
            await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => {}), target.click({ timeout: 5000 }).catch(() => el.click())]);
            launched = true;
            break;
          }
        } catch (_) {}
      }

      // Strategy 2: explicit Launch/Open buttons anywhere on the page.
      if (!launched) {
        for (const sel of ['button:has-text("Launch")', 'button:has-text("Open")', '.launch-button', 'button[title*="Launch" i]']) {
          try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 2000 }).catch(() => false)) {
              log('Clicking launch button', sel);
              await Promise.all([page.waitForEvent('download', { timeout: 30000 }).catch(() => {}), el.click()]);
              launched = true;
              break;
            }
          } catch (_) {}
        }
      }

      // Strategy 3: JS fallback — locate the ACFC Desktop tile and click it.
      if (!launched) {
        try {
          log('JS fallback: locating ACFC Desktop tile...');
          const found = await page.evaluate(() => {
            const nodes = Array.from(document.querySelectorAll('*'));
            const tile = nodes.find(n => /ACFC\s*Desktop/i.test(n.textContent || '') && n.children.length <= 3);
            if (!tile) return false;
            // Walk up to the clickable container
            let el = tile;
            while (el && !(el.tagName === 'A' || el.tagName === 'BUTTON' || /storeapp|app-?item|launch/i.test(el.className || ''))) {
              el = el.parentElement;
            }
            (el || tile).click();
            return true;
          });
          if (found) {
            await page.waitForEvent('download', { timeout: 30000 }).catch(() => {});
            log('JS fallback triggered launch');
            launched = true;
          }
        } catch (_) {}
      }

      // Strategy 4: direct StoreWeb LaunchIca endpoint (most reliable).
      // Citrix StoreWeb exposes /Resources/LaunchIca/<appKey> — POSTing to it
      // returns the .ica as a download, bypassing tile-render quirks.
      if (!launched) {
        try {
          log('Strategy 4: invoking StoreWeb LaunchIca endpoint...');
          const base = new URL(page.url()).origin + '/Citrix/PRDStoreWeb';
          // Try a few likely resource keys for the ACFC Desktop app.
          const keys = ['ACFCDesktop', 'ACFC_Desktop', 'ACFC-Desktop', 'Apps/ACFCDesktop'];
          let ok = false;
          for (const key of keys) {
            const [dl] = await Promise.all([
              page.waitForEvent('download', { timeout: 15000 }).catch(() => null),
              page.evaluate((u) => fetch(u, { method: 'POST', credentials: 'include', headers: { 'Accept': '*/*' } }), `${base}/Resources/LaunchIca/${key}`).catch(() => null)
            ]);
            if (dl) { ok = true; break; }
          }
          if (ok) { log('Strategy 4 triggered ICA download'); launched = true; }
          else {
            // Generic: click any resource link whose href contains LaunchIca
            const link = await page.$('a[href*="LaunchIca"], [data-url*="LaunchIca"]');
            if (link) {
              await Promise.all([page.waitForEvent('download', { timeout: 15000 }).catch(() => {}), link.click()]);
              launched = true;
              log('Strategy 4 (link) triggered ICA download');
            }
          }
        } catch (_) {}
      }

      if (icaFilePath) { log('DONE: ICA launched. Exiting.'); break; }
      if (!launched) { log('Waiting for ACFC Desktop to appear...'); await page.waitForTimeout(8000); }
      continue;
    }

    await safeWait(page, 2000);
    }

    log('Final URL:', page.url());
    await safeWait(page, 2000);
    await context.close().catch(() => {});
    log('Browser closed.');
})().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
