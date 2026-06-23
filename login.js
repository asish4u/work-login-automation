const { firefox, chromium } = require('playwright');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

(async () => {
  const browserType = process.env.BROWSER_TYPE || 'firefox';
  const loginUrl = process.env.WORK_LOGIN_URL || 'https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/';
  const username = process.env.WORK_USERNAME;
  const password = process.env.WORK_PASSWORD;

  if (!username || !password) {
    console.error('ERROR: WORK_USERNAME and WORK_PASSWORD must be defined in the .env file.');
    process.exit(1);
  }

  console.log(`Starting automation script with ${browserType}...`);
  console.log(`Targeting URL: ${loginUrl}`);

  // Path to persist browser profile data (keeps cookies/sessions between launches)
  const userDataDir = path.join(__dirname, 'user_data');

  let context;
  if (browserType.toLowerCase() === 'brave') {
    console.log('Launching stable system-installed Brave Browser...');
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    });
  } else if (browserType.toLowerCase() === 'chrome') {
    console.log('Launching stable system-installed Google Chrome...');
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chrome', // Launches standard stable Google Chrome on macOS
      headless: false,
      viewport: null,
      args: ['--start-maximized']
    });
  } else {
    console.log("Launching Firefox automation engine (with standard Firefox User Agent spoofing)...");
    context = await firefox.launchPersistentContext(userDataDir, {
      headless: false,
      viewport: null, // Open browser at default resolution
      // Override default Nightly user-agent to match standard stable Firefox on macOS to satisfy Citrix checks
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0',
      args: ['--start-maximized']
    });
  }

  const page = await context.newPage();

  // Set up download listener to capture Citrix .ica files and save/launch them natively on macOS
  page.on('download', async (download) => {
    const downloadPath = path.join('/Users/nayak/Downloads', download.suggestedFilename());
    console.log(`\n[Download Event] Intercepted file download: ${download.suggestedFilename()}`);
    console.log(`Saving file to: ${downloadPath}`);
    
    try {
      await download.saveAs(downloadPath);
      console.log(`File saved successfully to Downloads folder.`);
      
      // Auto-open .ica files using Citrix Workspace App on macOS
      if (downloadPath.endsWith('.ica')) {
        console.log(`Launching Citrix session using macOS 'open' command...`);
        exec(`open "${downloadPath}"`, (error) => {
          if (error) {
            console.error('Error auto-launching Citrix file:', error);
          } else {
            console.log('Citrix Workspace app launched successfully!');
          }
        });
      }
    } catch (err) {
      console.error('Failed to process and save download:', err);
    }
  });

  try {
    console.log('Navigating to Citrix login page...');
    await page.goto(loginUrl, { waitUntil: 'load', timeout: 60000 });

    // Note: Playwright contexts automatically manage tabs. Let's make sure we have exactly one page tab or manage properly.
    const pages = context.pages();
    if (pages.length > 1) {
      // Close initial blank page if it was created
      await pages[0].close();
    }

    console.log('Checking for login state...');

    // Wait a brief moment to let Citrix finish initial checks or redirects.
    await page.waitForTimeout(2000);

    // If already logged in, skip form interaction.
    // Check if username field is present. Adjust selector if it resides inside an iframe or uses Okta / Azure AD.
    let isLoginFormVisible = false;
    try {
      // Common email/username input selectors (e.g., standard input, Okta, Microsoft AD, Citrix login fields)
      await page.waitForSelector('input[type="email"], input[type="text"], input#username, input#user, input#LoginName', { timeout: 8000 });
      isLoginFormVisible = true;
    } catch (e) {
      console.log('Login form not immediately detected. You might already be logged in or page has fully loaded standard dashboard.');
    }

    if (isLoginFormVisible) {
      console.log('Logging in...');

      // Find the username field and type username
      const usernameInput = await page.locator('input[type="email"], input[type="text"], input#username, input#user, input#LoginName').first();
      await usernameInput.fill(username);

      // Look for a submit button / "Next" button.
      // Often, multi-step logins have a "Next", "Sign in", or submit button
      const nextButton = page.locator('input[type="submit"], button[type="submit"], button:has-text("Next"), button:has-text("Sign In"), input:has-text("Next")').first();
      
      if (await nextButton.count() > 0) {
        console.log('Clicking Next...');
        await nextButton.click();
      } else {
        // Fallback: hit Enter key if no explicit button is found
        console.log('No next button found, pressing Enter...');
        await usernameInput.press('Enter');
      }

      // Wait for the password field to be visible
      console.log('Waiting for password field to appear...');
      const passwordInput = page.locator('input[type="password"], input#password, input#Password').first();
      await passwordInput.waitFor({ state: 'visible', timeout: 15000 });
      
      console.log('Filling password...');
      await passwordInput.fill(password);

      // Locate submit button for password step
      const signInButton = page.locator('input[type="submit"], button[type="submit"], button:has-text("Sign In"), button:has-text("Log On"), input:has-text("Log On")').first();
      if (await signInButton.count() > 0) {
        console.log('Clicking Log On/Sign In...');
        await signInButton.click();
      } else {
        console.log('No explicit log on button, pressing Enter...');
        await passwordInput.press('Enter');
      }

      console.log('Waiting for Multi-Factor Authentication (MFA) step to load...');
      // Let standard redirect happen or wait for MFA page indicator
      await page.waitForTimeout(3000);
      
      console.log('------------------------------------------------------------');
      console.log('MFA / FINAL STEPS DETECTED.');
      console.log('Please complete the Multi-Factor Authentication prompt in the browser.');
      console.log('The script will monitor the page and automatically click "Continue" or post-login prompts.');
      console.log('------------------------------------------------------------');

      // Set up a loop/timeout to monitor for post-login prompts and click them sequentially.
      // We will look for elements containing "Continue", "Detect Receiver", "Already installed", or "Use light version".
      // The loop exits once the dashboard container or the ACFC Desktop icon is visible.
      const postLoginTimeout = 5 * 60 * 1000; // 5 minutes
      const startTime = Date.now();
      let reachedDashboard = false;

      while (Date.now() - startTime < postLoginTimeout) {
        try {
          // Check if we have reached the dashboard (app grid, search bar, or desktop title is visible)
          const dashboardSelectors = [
            '#store-grid',
            '#search-input',
            '.storefront-app',
            'text="ACFC Desktop"',
            ':has-text("ACFC Desktop")'
          ];
          
          for (const ds of dashboardSelectors) {
            const loc = page.locator(ds).first();
            if (await loc.isVisible()) {
              console.log('Citrix dashboard detected! Exiting post-login prompt monitor.');
              reachedDashboard = true;
              break;
            }
          }
          if (reachedDashboard) {
            break;
          }

          // Scan for and click any visible post-login/continue prompts
          const continueSelectors = [
            'button:has-text("Continue")',
            'a:has-text("Continue")',
            'input[value="Continue"]',
            'input[type="submit"]:has-text("Continue")',
            'a#downloadContainer_button', 
            'a:has-text("Detect Receiver")',
            'a:has-text("Already installed")',
            'a:has-text("Use light version")',
            '#protocolhandler-detect-alreadyinstalled',
            '#protocolhandler-welcome-continue'
          ];

          for (const selector of continueSelectors) {
            const locator = page.locator(selector).first();
            if (await locator.isVisible() && await locator.isEnabled()) {
              console.log(`Detected post-login prompt matching selector "${selector}". Clicking it...`);
              await locator.click();
              // Wait briefly to let the page react/transition
              await page.waitForTimeout(2000);
              break; // Break inner loop to scan fresh page state
            }
          }
        } catch (e) {
          // Ignore errors during check loop
        }
        await page.waitForTimeout(1000); // Poll every second
      }

      if (reachedDashboard) {
        console.log('Successfully completed post-login configuration screens.');
      } else {
        console.log('Post-login monitoring timed out or did not land on the dashboard.');
      }
    } else {
      console.log('Already logged in or login form not visible. Taking over existing browser session.');
    }

    console.log('\nWaiting for Citrix dashboard to load...');
    
    // Attempt to locate and click "ACFC Desktop"
    let desktopClicked = false;
    const searchSelectors = [
      'a:has-text("ACFC Desktop")',
      'div:has-text("ACFC Desktop")',
      'span:has-text("ACFC Desktop")',
      'text="ACFC Desktop"',
      '[title*="ACFC Desktop"]',
      '[aria-label*="ACFC Desktop"]'
    ];

    console.log('Searching for "ACFC Desktop" icon/button on dashboard...');
    const searchStartTime = Date.now();
    const searchTimeout = 30000; // 30 seconds

    while (Date.now() - searchStartTime < searchTimeout) {
      for (const selector of searchSelectors) {
        try {
          const locator = page.locator(selector).first();
          if (await locator.isVisible()) {
            console.log(`Found "ACFC Desktop" matching selector: ${selector}.`);
            try {
              // Attempt to trigger click directly in DOM to bypass hover/CSS-motion stability blocks
              await locator.evaluate(node => node.click());
              console.log('Triggered click via DOM element evaluation.');
            } catch (clickErr) {
              // Fallback to forced click
              await locator.click({ force: true });
              console.log('Triggered click via forced coordinates.');
            }
            desktopClicked = true;
            break;
          }
        } catch (e) {
          // ignore selector errors
        }
      }
      if (desktopClicked) {
        break;
      }
      await page.waitForTimeout(1000); // Poll every second
    }

    if (desktopClicked) {
      console.log('Successfully clicked "ACFC Desktop" card. Waiting for the Actions menu to appear...');
      
      // Wait for the "Open" action button/link to become visible and click it
      let openClicked = false;
      const openSelectors = [
        'a:has-text("Open")',
        'button:has-text("Open")',
        'span:has-text("Open")',
        'text="Open"',
        'a:text-is("Open")',
        '.detail-action a',
        '.detail-actions a'
      ];

      const openStartTime = Date.now();
      const openTimeout = 10000; // 10 seconds

      while (Date.now() - openStartTime < openTimeout) {
        for (const selector of openSelectors) {
          try {
            const locator = page.locator(selector).first();
            if (await locator.isVisible() && await locator.isEnabled()) {
              console.log(`Found "Open" action matching selector: ${selector}. Clicking it...`);
              try {
                await locator.evaluate(node => node.click());
                console.log('Triggered click on Open action via DOM.');
              } catch (clickErr) {
                await locator.click({ force: true });
                console.log('Triggered click on Open action via forced coordinates.');
              }
              openClicked = true;
              break;
            }
          } catch (e) {
            // ignore selector errors
          }
        }
        if (openClicked) {
          break;
        }
        await page.waitForTimeout(500); // Check every half second
      }

      if (openClicked) {
        console.log('Successfully clicked "Open"! The Citrix file should download and launch automatically.');
      } else {
        console.log('Could not find or click the "Open" action automatically. Please click it manually in the browser.');
      }
    } else {
      console.log('Could not find or click "ACFC Desktop" automatically. You can click it manually in the browser.');
    }

  } catch (error) {
    console.error('An error occurred during automation:', error);
  }

  // Keep script running and browser open indefinitely so user can take over
  console.log('Automation complete. Browser is now in manual mode.');
  console.log('You can close the terminal window or press Ctrl+C to terminate the runner when finished.');

  // Keep process alive
  await new Promise(() => {});
})();
