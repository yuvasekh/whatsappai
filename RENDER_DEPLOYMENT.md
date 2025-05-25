# Render Deployment Guide for WhatsApp API

## Problem
The error you're seeing indicates that Playwright browsers aren't properly installed on Render:
```
browserType.launch: Executable doesn't exist at /opt/render/.cache/ms-playwright/chromium-1169/chrome-linux/chrome
```

## Solutions Applied

### 1. Updated Browser Launch Configuration
- **Headless Mode**: Automatically detects production environment and runs in headless mode
- **Additional Args**: Added Chrome flags for better compatibility with cloud environments
- **Auto-Installation**: Added automatic browser installation check and install

### 2. Updated Package.json Scripts
- **postinstall**: Installs Playwright browsers after npm install
- **start**: Ensures browsers are installed before starting the app
- **--with-deps**: Installs system dependencies along with browsers

### 3. Added Dockerfile (Optional)
- Includes all system dependencies required for Playwright
- Pre-installs browsers during build process

### 4. Added render.yaml Configuration
- Optimized build and start commands for Render
- Sets proper environment variables
- Configures disk storage for browser cache

## Deployment Steps

### Option 1: Quick Fix (Recommended)
1. **Commit and push your changes** to your repository
2. **Redeploy on Render** - this will trigger the new build process
3. **Wait for deployment** - the new scripts will install browsers properly
4. **Test the /initialize endpoint** - it should now work

### Option 2: Manual Render Configuration
If Option 1 doesn't work, manually configure in Render dashboard:

1. **Build Command**: 
   ```
   npm install && npx playwright install --with-deps chromium
   ```

2. **Start Command**: 
   ```
   node index.js
   ```

3. **Environment Variables**:
   - `NODE_ENV` = `production`
   - `PLAYWRIGHT_BROWSERS_PATH` = `/opt/render/.cache/ms-playwright`

## Testing
After deployment, test these endpoints:
- `GET /health` - Check if server is running
- `POST /initialize` - Should now work without browser errors
- `GET /status` - Check WhatsApp session status

## Important Notes
- **Headless Mode**: In production, WhatsApp will run in headless mode (no visible browser)
- **QR Code**: You'll need to implement QR code extraction for headless scanning
- **Memory**: Ensure your Render plan has sufficient memory (at least 512MB recommended)

## If Issues Persist
1. Check Render logs for detailed error messages
2. Verify the build process completed successfully
3. Ensure all environment variables are set correctly
4. Consider upgrading to a higher Render plan for more resources
