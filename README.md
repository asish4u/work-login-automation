# Citrix Work Login Automation

This project automates the login process for a Citrix StoreWeb environment with multi-stage corporate authentication.

## Features
- **Multi-Stage Auth Handling**: Handles Email $\rightarrow$ Password $\rightarrow$ Stay Signed In $\rightarrow$ MFA flow.
- **Smart Card Bypass**: Automatically detects and clicks "Use password instead" when smart card prompts appear.
- **MFA Support**: Detects Microsoft Authenticator and SafeNet MFA prompts and waits for manual approval.
- **Firefox Integration**: Uses Firefox with specific user prefs to avoid bot detection.
- **ICA File Automation**: Automatically handles the download and opening of `.ica` files to launch Citrix sessions.

## Setup
1. Install dependencies: `npm install`
2. Create a `.env` file with your credentials:
   ```env
   WORK_USERNAME=your_email@domain.com
   WORK_PASSWORD=your_password
   WORK_LOGIN_URL=https://citrix.yourdomain.com/Citrix/PRDStoreWeb/
   BROWSER_TYPE=firefox
   ```
3. Run the automation: `node login.js`
