# Citrix Work Login Automation

Automates the corporate multi-stage login to the **AmeriHealth Caritas** Citrix
StoreWeb environment and launches the **ACFC Desktop** session, using
[Playwright](https://playwright.dev/) (Firefox) for reliability and low bot
detection.

## Why Playwright + Firefox

- **Best fit for this flow**: the login is a Microsoft Entra ID (Azure AD) SAML
  handshake → Citrix StoreWeb, ending in a `.ica` download that opens Citrix
  Workspace. Playwright drives real browsers, handles downloads natively, and
  `launchPersistentContext` keeps cookies/session state between runs.
- **Firefox** is used over Chromium because it's less aggressively fingerprinted
  by corporate SSO pages, and we disable `dom.webdriver.enabled` to reduce
  automation detection.

## What the automation does (step-by-step)

1. Opens `https://citrix.amerihealthcaritas.com/Citrix/PRDStoreWeb/`
2. **Username page** → types `anayak1@amerihealthcaritas.com` → clicks **Next**
3. **Password page** → types the password (robust fill that falls back to
   char-by-char typing + DOM value injection if the field ignores `fill()`) →
   clicks **Sign in**
4. **"Stay signed in?" prompt** (if shown) → clicks **Yes** / **Stay signed in**
5. **Verification page** → clicks **Continue**
6. **2FA page** → *pauses and waits* — you manually enter the authentication
   code in the browser window. The script resumes automatically once Citrix
   StoreWeb loads (5-minute timeout).
7. **Citrix StoreWeb** → finds **ACFC Desktop**, clicks it → the `.ica` file
   downloads → the script opens it with **Citrix Workspace** (or Citrix
   Receiver), launching the virtual desktop.

## Setup

```bash
# 1. Install dependencies
npm install

# 2. Install the Firefox browser binary for Playwright (one-time)
npx playwright install firefox

# 3. Create your .env from the template
cp .env.example .env
#    then edit .env and set WORK_PASSWORD (USERNAME is already filled in)
```

> **Security:** `.env`, `user_data/`, `node_modules/`, and `*.html`/`*.log`
> are git-ignored. Your password is **never** committed or hardcoded.

## Run

```bash
node login.js
```

A visible Firefox window opens. Watch it progress through the steps; when the
**2FA** step prints `=== 2FA REQUIRED ===`, switch to the browser, approve the
prompt / enter the code, and the automation finishes on its own.

To stop early, just close the browser window or press `Ctrl+C` in the terminal.

## Files

| File | Purpose |
|------|---------|
| `login.js` | The automation (entry point). |
| `.env.example` | Template for credentials (copy to `.env`). |
| `package.json` | Dependencies (`playwright`, `dotenv`). |
| `user_data/` | Persistent Firefox profile (session cookies). Git-ignored. |

## Troubleshooting

- **Password field not populated:** the script auto-retries with char-by-char
  typing and DOM injection, and re-verifies the value before submitting. If it
  still fails, the `WARN` line in the log tells you — make sure the `.env`
  password is correct and there are no extra spaces.
- **2FA never completes:** you have 5 minutes; the script times out otherwise.
- **Citrix Workspace not found:** install Citrix Workspace from
  <https://www.citrix.com/downloads/workspace-app/>. The script also falls back
  to Citrix Receiver.
- **ACFC Desktop not found on the page:** the script waits and retries; if your
  tenant labels it differently, adjust the `appSelectors` list in `login.js`.

## Repository

`https://github.com/asish4u/work-login-automation`
