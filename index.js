const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));
app.use(cors());

// Global state
let globalBrowser = null;
let globalPage = null;
let isLoggedIn = false;
let isWhatsAppReady = false;
let qrMonitoringIntervalId = null;


// Non-blocking screenshot helper function
async function takeScreenshot(filename, fullPage = true) {
  setImmediate(async () => {
    try {
      if (!globalPage || globalPage.isClosed()) {
        // console.log(`⚠️ Screenshot ${filename} skipped: no active page or page closed`);
        return;
      }

      const isPageNavigated = await globalPage.evaluate(() => typeof window !== 'undefined' && window.document).catch(() => false);
      if (!isPageNavigated) {
        // console.log(`⚠️ Screenshot ${filename} skipped: page context not valid`);
        return;
      }

      const screenshotDir = path.join(__dirname, 'screenshots');
      if (!fs.existsSync(screenshotDir)){
          fs.mkdirSync(screenshotDir, { recursive: true });
      }
      const screenshotPath = path.join(screenshotDir, `${filename}-${Date.now()}.png`);
      
      await globalPage.screenshot({
        path: screenshotPath,
        fullPage: fullPage,
        timeout: 10000 // Increased timeout
      });
      
      // console.log(`📸 Screenshot saved: ${path.basename(screenshotPath)}`);
    } catch (error) {
      if (!error.message.toLowerCase().includes('target closed') && !error.message.toLowerCase().includes('frame was detached')) {
        // console.warn(`⚠️ Screenshot ${filename} skipped:`, error.message.split('\n')[0]);
      }
    }
  });
}

// Environment detection
function detectEnvironment() {
  const indicators = {
    render: !!(process.env.RENDER || process.env.RENDER_SERVICE_ID),
    railway: !!process.env.RAILWAY_ENVIRONMENT,
    heroku: !!process.env.DYNO,
    vercel: !!process.env.VERCEL,
    production: process.env.NODE_ENV === 'production',
    hasPort: !!process.env.PORT,
    isCI: !!(process.env.CI || process.env.GITHUB_ACTIONS) // Added CI detection
  };

  const isCloud = indicators.render || indicators.railway || indicators.heroku || indicators.vercel || indicators.isCI;
  console.log('🔧 Environment Detection:', { ...indicators, isCloud });
  return { isCloud, ...indicators };
}

// Browser launch options
function getBrowserLaunchOptions(env) {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage', // Crucial for Docker/CI
    '--disable-gpu', // Often recommended for headless
    '--no-first-run',
    '--no-zygote', // Helps in some environments
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled', // Stealth
    // '--disable-web-security', // Use with caution, can have side effects
    // '--disable-features=VizDisplayCompositor' // Usually not needed unless specific rendering issues
  ];

  if (env.isCloud) { // Simplified cloud args
    baseArgs.push(
      '--single-process', // Reduces memory, but can be less stable for complex pages
      '--memory-pressure-off'
      // '--max_old_space_size=4096' // This is a Node.js flag, not Chromium. Manage memory via Playwright/OS.
    );
  }

  return {
    headless: true, // Always true for server
    args: baseArgs,
    viewport: { width: 1366, height: 768 },
    // executablePath: env.isCloud ? '/usr/bin/chromium-browser' : undefined, // If using system chromium
    timeout: env.isCloud ? 120000 : 60000, // Browser launch timeout
  };
}

// Initialize WhatsApp Web session
async function initializeWhatsApp() {
  try {
    if (globalBrowser && isLoggedIn) {
        console.log('✅ WhatsApp session already active and logged in.');
        if (!isWhatsAppReady) await waitForWhatsAppReady(); // Ensure ready state
        return { loggedIn: true };
    }
    
    // If browser exists but not logged in, clean up page/context for a fresh attempt.
    if (globalBrowser && !isLoggedIn) {
      console.log('🔄 Re-initializing WhatsApp session on existing browser (not logged in)...');
      if (globalPage && !globalPage.isClosed()) {
        try {
          await globalPage.close({ runBeforeUnload: true }); // Try to run unload handlers
        } catch (e) {
          console.warn('⚠️ Could not close existing page during re-initialization:', e.message);
        }
      }
      globalPage = null;
      // Optionally, could close and recreate context if page closure isn't enough:
      // const contexts = globalBrowser.contexts();
      // if (contexts.length > 0) await contexts[0].close();
    } else if (globalBrowser) { // Browser exists, but state might be messy (e.g. after error)
        console.log('🧹 Existing browser found. Performing full cleanup before new initialization.');
        await cleanup(); // Full cleanup ensures a clean slate
    }

    console.log('🚀 Initializing WhatsApp Web session...');
    const env = detectEnvironment();
    
    if (!globalBrowser) {
      if (env.isCloud && !fs.existsSync(path.join(__dirname, 'pw-browsers'))) { // Check if already installed
        try {
          console.log('🔍 Installing Playwright browsers for cloud environment...');
          const { execSync } = require('child_process');
          // Specify a cache path within the project directory if persistent storage is limited
          // execSync('npx playwright install --with-deps chromium', { 
          execSync('PLAYWRIGHT_BROWSERS_PATH=./pw-browsers npx playwright install --with-deps chromium', { 
            stdio: 'inherit',
            timeout: env.isCloud ? 600000 : 300000 // Longer timeout for installs
          });
          console.log('✅ Browser installation completed');
        } catch (installError) {
          console.error('❌ Browser installation failed:', installError.message);
          throw new Error(`Browser installation failed: ${installError.message}`);
        }
      }
      const launchOptions = getBrowserLaunchOptions(env);
      console.log('🚀 Launching browser with options:', launchOptions);
      globalBrowser = await chromium.launch(launchOptions);
      globalBrowser.on('disconnected', () => {
        console.error('❌ Browser disconnected unexpectedly!');
        cleanup(); // Perform cleanup if browser disconnects
      });
    }

    // Create context if it doesn't exist or if we are re-initializing
    let context = globalBrowser.contexts()[0];
    if (!context) {
        context = await globalBrowser.newContext({
            viewport: { width: 1366, height: 768 },
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            permissions: ['notifications'], // Minimal necessary permissions
            locale: 'en-US',
            storageState: undefined, // Ensures no previous session cookies interfere unless explicitly loaded
            javaScriptEnabled: true,
            bypassCSP: true, // Can help with some loading issues, use judiciously
            extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9', // WhatsApp often checks this
            'Cache-Control': 'no-cache, no-store, must-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
            }
        });
    }
    

    if (!globalPage || globalPage.isClosed()) {
        globalPage = await context.newPage();
        // Add stealth script (essential)
        await globalPage.addInitScript(() => {
            delete Object.getPrototypeOf(navigator).webdriver;
            delete navigator.__proto__.webdriver; // For older Chrome versions
            delete (window.navigator || navigator).webdriver; // General case
    
            Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3] }); // Mimic some plugins
            Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
    
            // Mimic Chrome runtime
            window.chrome = window.chrome || {};
            window.chrome.runtime = window.chrome.runtime || {};
        });
    }
    
    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', {
      waitUntil: 'networkidle', // More reliable for complex apps
      timeout: env.isCloud ? 120000 : 90000 // Increased navigation timeout
    });

    const stabilizeTime = env.isCloud ? 20000 : 10000; // Increased stabilization time
    console.log(`⏳ Waiting ${stabilizeTime}ms for page to stabilize...`);
    await globalPage.waitForTimeout(stabilizeTime);
    takeScreenshot('initial-load');

    await handleCompatibilityWarnings();

    const loginResult = await checkLoginStatus();
    if (loginResult.loggedIn) {
      isLoggedIn = true;
      isWhatsAppReady = false; 
      console.log('✅ User is already logged in. Verifying WhatsApp readiness...');
      takeScreenshot('already-logged-in');
      await waitForWhatsAppReady();
      return { loggedIn: true };
    }

    let qrResult = await extractQRCode();
    if (!qrResult.success) {
      takeScreenshot('qr-extraction-failed-initial');
      console.log('⚠️ Initial QR extraction failed. Attempting reload and retry...');
      await globalPage.reload({ waitUntil: 'networkidle', timeout: env.isCloud ? 90000 : 60000 });
      await globalPage.waitForTimeout(env.isCloud ? 20000 : 15000); // Wait after reload
      await handleCompatibilityWarnings();
      qrResult = await extractQRCode(); // Assign to the same variable

      if (!qrResult.success) {
        takeScreenshot('qr-extraction-failed-after-retry');
        throw new Error(qrResult.error || 'Failed to extract QR code after retry');
      }
      console.log('✅ QR code extracted successfully after retry');
      takeScreenshot('qr-extracted-after-retry');
    } else {
      console.log('✅ QR code extracted successfully on first attempt');
      takeScreenshot('qr-extracted');
    }
    
    monitorQRScanCompletion(); // Start monitoring AFTER successful extraction

    return {
      loggedIn: false,
      qrCode: qrResult.qrCode,
      metadata: qrResult.metadata
    };

  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error.message, error.stack);
    takeScreenshot('initialization-failed');
    // If browser launch itself failed or browser is not usable, perform full cleanup.
    if (!globalBrowser || (globalBrowser && !globalBrowser.isConnected())) {
        await cleanup();
    } else if (globalPage && globalPage.isClosed()){
        globalPage = null; // Ensure page is nullified if closed
    }
    throw error; // Re-throw for the route handler
  }
}

// Handle compatibility warnings
async function handleCompatibilityWarnings() {
  try {
    if (!globalPage || globalPage.isClosed()) return;
    console.log('🔍 Checking for compatibility warnings or update dialogs...');
    await globalPage.waitForTimeout(3000); // Brief wait for dialogs to appear

    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      console.log('⚠️ Page context destroyed during compatibility check');
      return;
    }
    
    // Common "Update WhatsApp" or "Browser not supported" dialogs
    // These selectors might need updating if WhatsApp changes its UI
    const warningSelectors = [
        'div[role="button"]:has-text("Update WhatsApp")',
        'div[role="button"]:has-text("UPDATE NOW")',
        'button:has-text("Use Here")', // For "WhatsApp is open on another computer"
        'button:has-text("OK")', // Generic OK button for info dialogs
        'div[data-testid="popup-controls"] button:has-text("OK")'
    ];

    for (const selector of warningSelectors) {
        try {
            const button = await globalPage.locator(selector).first(); // Use locator for auto-waiting
            if (await button.isVisible({timeout: 2000})) {
                const buttonText = await button.textContent();
                console.log(`⚠️ Found dialog button: "${buttonText}". Attempting to click.`);
                await button.click({timeout: 5000});
                await globalPage.waitForTimeout(3000); // Wait for dialog to close
                takeScreenshot(`dialog-clicked-${selector.replace(/[^a-zA-Z0-9]/g, '_')}`);
                console.log(`✅ Clicked dialog button: "${buttonText}"`);
                return; // Assume one dialog at a time
            }
        } catch (e) {
            // Button not found or not visible, continue
        }
    }

    // Original compatibility check based on page content (less reliable but a fallback)
    const pageContent = await globalPage.evaluate(() => document.body.innerText?.toLowerCase() || '').catch(() => '');
    if (pageContent.includes('update whatsapp') || pageContent.includes('browser not supported') || pageContent.includes("can't scan")) {
      console.log('⚠️ Text-based compatibility/update warning detected on page.');
      takeScreenshot('text-compatibility-warning');
      // Add logic here if specific actions are needed beyond the button clicks above
    }

  } catch (error) {
    console.warn('⚠️ Error handling compatibility warnings/dialogs:', error.message);
    takeScreenshot('compatibility-error');
  }
}

// Check login status
async function checkLoginStatus() {
  try {
    if (!globalPage || globalPage.isClosed()) return { loggedIn: false };
    // console.log('🔍 Checking login status...'); // Can be verbose, uncomment if needed

    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      console.log('⚠️ Page context destroyed during login check');
      return { loggedIn: false };
    }

    // Prioritize selectors that indicate a fully loaded, logged-in interface
    const loginSelectors = [
      '[data-testid="chat-list-search-container"]', // Search bar in chat list
      '[data-testid="chat-list"] [role="listitem"]', // Actual chat items
      '[data-testid="side"]', // Main side panel
      'div[id="side"] header [data-testid="menu-bar-menu"]', // Menu button in header
      'div[role="textbox"][data-tab="3"][aria-label="Search input textbox"]' // A specific search input
    ];

    for (const selector of loginSelectors) {
      try {
        // Using locator for auto-waiting and better reliability
        const element = globalPage.locator(selector).first();
        if (await element.isVisible({ timeout: 2000 })) { // Short timeout, just checking existence
          // console.log(`✅ Login detected with: ${selector}`);
          // takeScreenshot('login-detected'); // Can be too frequent
          return { loggedIn: true };
        }
      } catch (e) {
        // Element not found or not visible, continue
      }
    }
    // takeScreenshot('login-not-detected'); // Can be too frequent
    return { loggedIn: false };
  } catch (error) {
    console.warn('⚠️ Error checking login status:', error.message);
    return { loggedIn: false };
  }
}

// Extract QR code
async function extractQRCode() {
  try {
    if (!globalPage || globalPage.isClosed()) return { success: false, error: 'Page closed or not available' };
    console.log('🔍 Extracting QR code...');
    
    const env = detectEnvironment();
    const qrWrapperSelector = '[data-testid="qrcode"], div[data-ref][aria-details="link-device"], div[data-testid="link-device-qr-code-container"]';
    try {
        await globalPage.waitForSelector(qrWrapperSelector, { state: 'visible', timeout: env.isCloud ? 45000 : 25000 });
        console.log('✅ QR code wrapper element is visible.');
    } catch (e) {
        takeScreenshot('qr-wrapper-not-visible');
        const pageText = await globalPage.evaluate(() => document.body.innerText?.substring(0, 200) || "No body text").catch(() => 'Could not get page text');
        console.warn(`⚠️ QR code wrapper (${qrWrapperSelector}) not visible in time. Page text: "${pageText}"`);
        return { success: false, error: `QR code wrapper not visible. Potential issue: ${pageText.substring(0,100)}`};
    }

    await globalPage.waitForTimeout(env.isCloud ? 5000 : 3000); // Allow canvas to render fully after wrapper visible

    takeScreenshot('before-qr-extraction');

    const qrSelectors = [
      'canvas[aria-label="Scan me"]',
      'canvas[aria-label*="QR code"]', // More generic for i18n
      '[data-testid="qr-code"] canvas',
      '[data-testid="qr-canvas"]',
      'div[data-ref] canvas',
      'canvas' 
    ];

    let qrElement = null;
    let usedSelector = '';

    const allCanvases = await globalPage.locator('canvas').count().catch(() => 0);
    console.log(`🔍 Found ${allCanvases} canvas elements on page (via locator count).`);
    if (allCanvases === 0) {
        takeScreenshot('no-canvases-found');
        return { success: false, error: 'No canvas elements found on the page for QR code.' };
    }

    for (const selector of qrSelectors) {
      try {
        const elements = globalPage.locator(selector);
        const count = await elements.count();
        // console.log(`🔍 Locator "${selector}" found ${count} elements.`);
        for (let i = 0; i < count; i++) {
            const elementHandle = elements.nth(i);
            if (!await elementHandle.isVisible({timeout: 1000}).catch(() => false)) continue;

            const box = await elementHandle.boundingBox({timeout: 1000}).catch(() => null);
            if (!box || box.width < 50 || box.height < 50) continue;

            const hasContent = await elementHandle.evaluate(canvas => {
                if (canvas.tagName.toLowerCase() !== 'canvas') return true;
                try {
                    const ctx = canvas.getContext('2d');
                    if (!ctx) return false;
                    const imageData = ctx.getImageData(0, 0, Math.min(20, canvas.width), Math.min(20, canvas.height));
                    let opaqueOrNonWhitePixels = 0;
                    for (let j = 0; j < imageData.data.length; j += 4) {
                        if (imageData.data[j+3] > 128 && (imageData.data[j] < 250 || imageData.data[j+1] < 250 || imageData.data[j+2] < 250)) {
                            opaqueOrNonWhitePixels++;
                        }
                    }
                    return opaqueOrNonWhitePixels > (imageData.data.length / 4 / 5); // At least 20% of checked pixels are drawn
                } catch (e) { return false; }
            }).catch(() => false);

            if (hasContent) {
                qrElement = elementHandle;
                usedSelector = selector;
                console.log(`✅ Found valid QR canvas with selector: "${selector}", dimensions: ${box.width.toFixed(0)}x${box.height.toFixed(0)}`);
                break;
            }
        }
        if (qrElement) break;
      } catch (e) { /* console.warn(`Error with selector "${selector}":`, e.message); */ continue; }
    }

    if (!qrElement) {
      takeScreenshot('qr-element-not-found');
      const pageText = await globalPage.evaluate(() => document.body.innerText?.substring(0, 500) || "No body text").catch(() => 'Could not get page text');
      console.log('📄 Page text preview (QR element not found):', pageText.substring(0, 200));
      return { success: false, error: 'QR code canvas element not found or not rendered properly.' };
    }

    await globalPage.waitForTimeout(1000); // Small pause before data extraction
    
    const qrDataUrl = await qrElement.evaluate(canvas => {
      try { return canvas.toDataURL('image/png'); } catch (e) { return null; }
    }).catch(() => null);

    if (!qrDataUrl || qrDataUrl.length < 1000) {
      console.log(`🔄 QR data from canvas.toDataURL is invalid/short (len: ${qrDataUrl?.length}). Using screenshot fallback.`);
      takeScreenshot('qr-canvas-todataurl-failed');
      try {
        await qrElement.scrollIntoViewIfNeeded({timeout: 2000}).catch(e => console.warn("Could not scroll QR for screenshot:", e.message));
        const screenshotBuffer = await qrElement.screenshot({ type: 'png', timeout: 10000 });
        if (!screenshotBuffer || screenshotBuffer.length < 500) {
            takeScreenshot('qr-screenshot-fallback-failed-empty');
            return { success: false, error: 'QR screenshot fallback produced empty or too small image data.' };
        }
        const fallbackDataUrl = `data:image/png;base64,${screenshotBuffer.toString('base64')}`;
        console.log(`✅ QR code extracted via screenshot fallback, data size: ${fallbackDataUrl.length}`);
        takeScreenshot('qr-fallback-used');
        return { success: true, qrCode: fallbackDataUrl, metadata: { selector: usedSelector, method: 'screenshot', timestamp: new Date().toISOString() }};
      } catch (screenshotError) {
        console.error('❌ Screenshot fallback for QR also failed:', screenshotError.message);
        takeScreenshot('qr-screenshot-error');
        return { success: false, error: `QR screenshot fallback failed: ${screenshotError.message}` };
      }
    }

    console.log(`✅ QR code extracted successfully via canvas.toDataURL, data size: ${qrDataUrl.length}`);
    takeScreenshot('qr-extraction-success');
    return { success: true, qrCode: qrDataUrl, metadata: { selector: usedSelector, method: 'canvas', timestamp: new Date().toISOString(), dataSize: qrDataUrl.length }};

  } catch (error) {
    console.error('❌ Overall QR extraction process failed:', error.message, error.stack);
    takeScreenshot('qr-extraction-critical-error');
    if (globalPage && !globalPage.isClosed()) console.error('Current page URL during QR extraction error:', globalPage.url());
    return { success: false, error: `Critical error in extractQRCode: ${error.message}` };
  }
}

// Monitor QR scan completion
function monitorQRScanCompletion() {
  if (qrMonitoringIntervalId) {
    clearInterval(qrMonitoringIntervalId);
    qrMonitoringIntervalId = null;
  }
  console.log('🔍 Starting QR scan monitoring...');

  const env = detectEnvironment();
  const maxTotalScanTime = env.isCloud ? 360000 : 240000; // 6 min cloud, 4 min local overall
  const qrRefreshInterval = env.isCloud ? 90000 : 60000; // 1.5 min cloud, 1 min local for QR expiry
  let monitoringStartTime = Date.now();
  let lastQRRefreshAttemptTime = Date.now();
  let qrRefreshInProgress = false;

  qrMonitoringIntervalId = setInterval(async () => {
    try {
      if (!globalBrowser || !globalPage || globalPage.isClosed()) {
        console.log('⚠️ Browser/Page not available. Stopping QR scan monitoring.');
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        return;
      }
      if (isLoggedIn) {
        // console.log('✅ Already logged in. Stopping QR scan monitoring.'); // Can be verbose
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        return;
      }

      const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
      if (!isPageValid) {
        console.log('⚠️ Page context destroyed during monitoring, stopping...');
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        return;
      }

      const currentTime = Date.now();
      const loginResult = await checkLoginStatus();
      if (loginResult.loggedIn) {
        console.log('✅🎉 QR scan completed! User is now logged in.');
        isLoggedIn = true;
        takeScreenshot('qr-scan-completed');
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        waitForWhatsAppReady().catch(err => console.error("Error ensuring WhatsApp readiness post-login:", err.message));
        return;
      }

      const timeSinceLastRefresh = currentTime - lastQRRefreshAttemptTime;
      let qrCurrentlyVisible = false;
      try {
        const qrCanvas = globalPage.locator('canvas[aria-label*="Scan me"], canvas[aria-label*="QR code"]').first();
        qrCurrentlyVisible = await qrCanvas.isVisible({timeout: 1000});
      } catch (e) { /* assume not visible */ }

      if (!qrRefreshInProgress && (!qrCurrentlyVisible || timeSinceLastRefresh > qrRefreshInterval)) {
        qrRefreshInProgress = true;
        console.log(`🔄 ${!qrCurrentlyVisible ? 'QR not visible' : 'QR refresh interval reached'}. Attempting to refresh QR code...`);
        takeScreenshot('before-qr-auto-refresh');
        try {
          await globalPage.reload({ waitUntil: 'networkidle', timeout: env.isCloud ? 90000 : 60000 });
          await globalPage.waitForTimeout(env.isCloud ? 20000 : 10000);
          await handleCompatibilityWarnings();
          
          const newQrResult = await extractQRCode();
          if (newQrResult.success) {
            console.log('✅ QR code refreshed and re-extracted successfully during monitoring.');
            takeScreenshot('after-qr-auto-refresh-success');
            // TODO: Notify client if new QR code is available (e.g., via WebSocket or an endpoint)
          } else {
            console.warn('⚠️ Failed to re-extract QR code after auto-refresh:', newQrResult.error);
            takeScreenshot('after-qr-auto-refresh-failed');
          }
          lastQRRefreshAttemptTime = currentTime; // Update time even if extraction failed to avoid rapid retries
        } catch (e) {
          console.error('⚠️ Error during automatic QR refresh process:', e.message);
          takeScreenshot('qr-auto-refresh-error');
          lastQRRefreshAttemptTime = currentTime; // Update time to prevent loop
        } finally {
          qrRefreshInProgress = false;
        }
      }

      if ((currentTime - monitoringStartTime) > maxTotalScanTime) {
        console.log('⏰ Maximum QR scan monitoring time reached. User may need to re-initiate.');
        takeScreenshot('monitoring-max-timeout');
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        // Consider triggering a full cleanup or specific error state
        // isLoggedIn = false; // Ensure state reflects failure
        // await cleanup(); // Or just close the page and let user re-init
      }

    } catch (error) {
      console.error('⚠️ Critical error during QR monitoring loop:', error.message, error.stack);
      if (error.message.includes('Target closed') || error.message.includes('Session closed') || error.message.includes('frame was detached')) {
        console.error("🚨 Page/Session closed unexpectedly. Stopping QR monitoring.");
        clearInterval(qrMonitoringIntervalId); qrMonitoringIntervalId = null;
        isLoggedIn = false; isWhatsAppReady = false;
        // globalPage might be unusable, don't try to operate on it further here.
      }
    }
  }, 15000); // Check every 15 seconds
}

// Wait for WhatsApp to be ready
async function waitForWhatsAppReady() {
  try {
    if (!globalPage || globalPage.isClosed()) throw new Error('Page not available for WhatsApp readiness check.');
    console.log('⏳ Waiting for WhatsApp to be fully loaded and interactive...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 60000 : 45000; // Increased wait time
    const startTime = Date.now();

    // Selectors indicating a fully loaded and interactive UI
    const readySelectors = [
      '[data-testid="chat-list-search-container"]', // Search bar
      '[data-testid="header-cmds"]', // Header command buttons (status, new chat, menu)
      'div[id="pane-side"]', // The main side pane containing chats
      // This selector checks for the "intro" screen when no chat is selected, or a chat header
      'div[data-testid="conversation-header"], div[data-testid="intro-title"]',
    ];

    // Also, wait for "loading chats" or "organizing messages" spinners to disappear
    const loadingSpinnerSelectors = [
        'div[data-testid="startup-loading-screen"]',
        'progress', // Generic progress bar sometimes used
        // Look for text like "Loading chats", "Organizing messages" etc.
        // This is language-dependent, so be careful or use more robust selectors if possible
        'div:has-text("Loading your chats")', 
        'div:has-text("Organizing messages")'
    ];


    while ((Date.now() - startTime) < maxWaitTime) {
      const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
      if (!isPageValid) throw new Error('Page context destroyed while waiting for WhatsApp readiness.');

      let allReadyElementsVisible = true;
      for (const selector of readySelectors) {
        try {
          if (!await globalPage.locator(selector).first().isVisible({timeout: 1000})) {
            allReadyElementsVisible = false;
            break;
          }
        } catch (e) { allReadyElementsVisible = false; break; }
      }

      let spinnersGone = true;
      for (const selector of loadingSpinnerSelectors) {
          try {
              if (await globalPage.locator(selector).first().isVisible({timeout: 500})) {
                  spinnersGone = false;
                  break;
              }
          } catch (e) { /* spinner not found, good */ }
      }


      if (allReadyElementsVisible && spinnersGone) {
        console.log(`✅ WhatsApp is ready! (Found key elements and no spinners)`);
        await globalPage.waitForTimeout(3000); // Extra stabilization
        takeScreenshot('whatsapp-ready');
        isWhatsAppReady = true;
        return true;
      }
      // console.log('⏳ Still waiting for WhatsApp interface... Key elements visible:', allReadyElementsVisible, 'Spinners gone:', spinnersGone);
      await globalPage.waitForTimeout(2000);
    }

    takeScreenshot('whatsapp-not-ready-timeout');
    throw new Error(`WhatsApp interface not ready after ${maxWaitTime / 1000}s`);

  } catch (error) {
    console.error('❌ Error waiting for WhatsApp to be ready:', error.message);
    takeScreenshot('whatsapp-ready-error');
    isWhatsAppReady = false; // Ensure state reflects this
    throw error;
  }
}

// Handle dialogs
async function handleDialogs() {
  if (!globalPage || globalPage.isClosed()) return;
  // This function is largely covered by handleCompatibilityWarnings now.
  // It can be kept for very generic dialogs if needed.
  // console.log("📋 Checking for generic dialogs...");
  try {
    const genericOkButton = globalPage.locator('button:has-text("OK"), button:has-text("GOT IT")').first();
    if (await genericOkButton.isVisible({timeout:1000})) {
        console.log("📋 Found generic OK/Got it dialog. Clicking.");
        await genericOkButton.click({timeout: 3000});
        await globalPage.waitForTimeout(1000);
    }
  } catch(e) { /* no generic dialog */ }
}

// Navigate to specific chat
async function navigateToChat(mobile) {
  try {
    if (!globalPage || globalPage.isClosed()) throw new Error("Page not available for chat navigation.");
    console.log(`📞 Navigating to chat: ${mobile}`);

    if (!isWhatsAppReady) {
      console.log('⏳ WhatsApp not ready yet, waiting before navigating to chat...');
      await waitForWhatsAppReady();
    }

    await handleDialogs(); // Handle any unexpected popups

    const cleanNumber = mobile.replace(/[^\d]/g, '');
    const waUrl = `https://web.whatsapp.com/send?phone=${cleanNumber}&text&app_absent=0`; // Added app_absent=0
    
    console.log(`🌐 Navigating directly to: ${waUrl}`);
    await globalPage.goto(waUrl, { waitUntil: 'networkidle', timeout: 45000 });
    await globalPage.waitForTimeout(3000); // Wait for potential redirects or UI updates

    takeScreenshot(`navigate-to-${cleanNumber}-start`);
    await handleDialogs(); // Handle dialogs like "Phone number shared via URL"

    // Wait for chat input box to be ready or "number not on WhatsApp" message
    const chatInputSelector = 'div[role="textbox"][data-testid="conversation-compose-box-input"]';
    const invalidNumberSelector = 'div[data-testid="popup-contents"]'; // Common popup for invalid numbers

    try {
        // Wait for either the chat input (success) or an invalid number popup (failure)
        await globalPage.waitForSelector(`${chatInputSelector}, ${invalidNumberSelector}`, {
            state: 'visible',
            timeout: 25000
        });

        // Check if invalid number popup is visible
        const invalidPopup = globalPage.locator(invalidNumberSelector);
        if (await invalidPopup.isVisible()) {
            const popupText = await invalidPopup.innerText();
            if (popupText.toLowerCase().includes("isn't on whatsapp") || popupText.toLowerCase().includes("phone number is incorrect")) {
                takeScreenshot(`chat-not-found-invalid-${cleanNumber}`);
                throw new Error(`Phone number ${mobile} is not on WhatsApp or is incorrect. Popup: ${popupText.substring(0,100)}`);
            }
        }
        
        // If no invalid popup, wait specifically for chat input
        const chatInputElement = globalPage.locator(chatInputSelector);
        await chatInputElement.waitFor({ state: 'visible', timeout: 10000 }); // Already waited generally, now specific
        await chatInputElement.focus({timeout: 5000});
        console.log('✅ Chat input focused and ready.');
        takeScreenshot(`chat-loaded-${cleanNumber}`);
        return true;

    } catch (e) {
        takeScreenshot(`chat-not-found-timeout-${cleanNumber}`);
        const pageUrl = globalPage.url();
        console.error(`❌ Failed to find chat interface for ${mobile}. Current URL: ${pageUrl}. Error: ${e.message}`);
        throw new Error(`Chat interface for ${mobile} not found after navigation. Potential issue or invalid number.`);
    }

  } catch (error) {
    console.error(`❌ Failed to navigate to chat ${mobile}:`, error.message);
    takeScreenshot(`nav-error-${mobile.replace(/[^\d]/g, '')}`);
    throw error;
  }
}

// Send combined message
async function sendCombinedMessage(mobile, message = '', mediaUrl = '', caption = '', mediaType = 'auto') {
  try {
    if (!globalPage || globalPage.isClosed()) return { success: false, mobile, error: "Page not available for sending message."};
    console.log(`📤 Preparing to send to ${mobile}: msg?${!!message}, media?${!!mediaUrl}, cap?${!!caption}`);

    await navigateToChat(mobile); // This will throw if chat cannot be opened

    const messageBoxSelector = 'div[role="textbox"][data-testid="conversation-compose-box-input"]';
    const messageBox = globalPage.locator(messageBoxSelector);
    await messageBox.waitFor({ state: 'visible', timeout: 10000 });

    // Clear existing content carefully
    await messageBox.click({timeout: 3000}); // Focus
    await globalPage.waitForTimeout(200);
    // Method 1: Fill with empty (often best for rich text editors)
    try { await messageBox.fill(''); }
    catch (e1) {
        console.warn("Clear with fill('') failed:", e1.message.split('\n')[0]);
        // Method 2: Keyboard clear
        await messageBox.focus({timeout:1000});
        const selectAllKey = process.platform === 'darwin' ? 'Meta+A' : 'Control+A';
        await globalPage.keyboard.press(selectAllKey);
        await globalPage.waitForTimeout(100);
        await globalPage.keyboard.press('Backspace');
    }
    await globalPage.waitForTimeout(300); // Wait after clear

    let combinedContent = '';
    if (mediaUrl) combinedContent += mediaUrl; // Paste URL first
    if (caption) combinedContent += (combinedContent ? '\n' : '') + caption;
    if (message) combinedContent += (combinedContent ? '\n' : '') + message;

    if (!combinedContent.trim()) {
      throw new Error('No content (message, media, or caption) to send.');
    }

    console.log(`📝 Typing combined content (length: ${combinedContent.length})...`);
    takeScreenshot(`before-send-${mobile.replace(/[^\d]/g, '')}`);
    
    // Typing in chunks can be more reliable for long messages or links
    const chunks = combinedContent.match(/.{1,100}/g) || []; // Split into 100 char chunks
    for (const chunk of chunks) {
        await messageBox.type(chunk, { delay: 30 + Math.random() * 20 }); // Human-like delay
    }
    await globalPage.waitForTimeout(mediaUrl ? 2000 : 500); // Longer wait if media URL for preview

    // Send
    const sendButtonSelector = 'button[data-testid="compose-btn-send"], button[aria-label="Send"]';
    const sendButton = globalPage.locator(sendButtonSelector);
    
    if (await sendButton.isVisible({timeout: 5000})) {
        await sendButton.click({timeout: 5000});
        console.log('✅ Message sent using send button.');
    } else {
        console.log(' Send button not visible, pressing Enter.');
        await messageBox.press('Enter');
    }
    
    await globalPage.waitForTimeout(3000); // Wait for message to appear sent

    takeScreenshot(`after-send-${mobile.replace(/[^\d]/g, '')}`);
    console.log(`✅ Combined message process completed for ${mobile}.`);
    return { success: true, mobile, message: 'Combined message sent successfully.', content: { mediaUrl, caption, message, mediaType }, timestamp: new Date().toISOString() };

  } catch (error) {
    console.error(`❌ Failed to send combined message to ${mobile}:`, error.message, error.stack);
    takeScreenshot(`send-error-${mobile.replace(/[^\d]/g, '')}`);
    return { success: false, mobile, error: error.message, timestamp: new Date().toISOString() };
  }
}

// Cleanup function
async function cleanup() {
  console.log('🧹 Initiating cleanup...');
  if (qrMonitoringIntervalId) {
    clearInterval(qrMonitoringIntervalId);
    qrMonitoringIntervalId = null;
    console.log(' QR monitoring stopped.');
  }
  try {
    if (globalPage && !globalPage.isClosed()) {
      // takeScreenshot('before-page-close'); // Might fail if browser is already closing
      // await globalPage.close({ runBeforeUnload: true }).catch(e => console.warn("Error closing page:", e.message));
      // console.log(' Page closed.');
    }
  } catch(e) { /* ignore */ }

  try {
    if (globalBrowser && globalBrowser.isConnected()) {
      takeScreenshot('before-browser-close'); // Take screenshot before closing
      await globalBrowser.close();
      console.log('✅ Browser closed.');
    }
  } catch (error) {
    console.warn('⚠️ Error closing browser during cleanup:', error.message);
  } finally {
    globalBrowser = null;
    globalPage = null;
    isLoggedIn = false;
    isWhatsAppReady = false;
    console.log('🧹 Global state reset. Cleanup complete.');
  }
}

// --- API Routes ---
app.post('/initialize', async (req, res) => {
  try {
    const result = await initializeWhatsApp();
    res.json({
      success: true,
      message: result.loggedIn ? 'WhatsApp session already active and logged in.' : 'WhatsApp initialization process started.',
      qrCode: result.qrCode || null,
      loggedIn: result.loggedIn || false,
      metadata: result.metadata || null
    });
  } catch (error) {
    console.error('Initialize endpoint error:', error.message);
    res.status(500).json({ success: false, error: error.message, details: error.stack });
  }
});

app.post('/send-messages', async (req, res) => {
  try {
    const { whatsapp } = req.body;
    if (!whatsapp || !Array.isArray(whatsapp) || whatsapp.length === 0) {
      return res.status(400).json({ success: false, error: 'Invalid "whatsapp" array in request body.' });
    }
    if (!globalBrowser || !globalPage || !isLoggedIn || !isWhatsAppReady) {
      return res.status(400).json({ success: false, error: 'WhatsApp not ready. Ensure session is initialized, logged in, and ready.', status: { isLoggedIn, isWhatsAppReady } });
    }

    console.log(`📤 Processing ${whatsapp.length} messages in bulk...`);
    const results = [];
    for (let i = 0; i < whatsapp.length; i++) {
      const item = whatsapp[i];
      const { id, mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = item;
      const mediaUrl = filePath || link;

      if (!mobile || (!message.trim() && !mediaUrl.trim())) {
        results.push({ id, success: false, mobile: mobile || 'unknown', error: 'Mobile number and (message or media) are required.' });
        continue;
      }
      const result = await sendCombinedMessage(mobile, message, mediaUrl, caption, mediaType);
      results.push({ id, ...result });
      if (i < whatsapp.length - 1) {
        const delay = 2000 + Math.random() * 2000; // 2-4 sec delay
        console.log(`⏳ Waiting ${delay.toFixed(0)}ms before next message...`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
    const successful = results.filter(r => r.success).length;
    res.json({ success: true, summary: { total: whatsapp.length, successful, failed: results.length - successful }, results, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('❌ Bulk messaging error:', error.message, error.stack);
    res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
  }
});

app.post('/send-message', async (req, res) => {
    try {
        const { mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = req.body;
        const mediaUrl = filePath || link;

        if (!mobile || (!message.trim() && !mediaUrl.trim())) {
            return res.status(400).json({ success: false, error: 'Mobile number and either message or media (filePath/link) are required' });
        }
        if (!globalBrowser || !globalPage || !isLoggedIn || !isWhatsAppReady) {
            return res.status(400).json({ success: false, error: 'WhatsApp not ready. Ensure session is initialized, logged in, and ready.', status: { isLoggedIn, isWhatsAppReady } });
        }
        console.log(`📤 Processing single message for ${mobile}`);
        const result = await sendCombinedMessage(mobile, message, mediaUrl, caption, mediaType);
        res.json(result); // Send the whole result object
    } catch (error) {
        console.error('❌ Send message error:', error.message, error.stack);
        res.status(500).json({ success: false, error: error.message, timestamp: new Date().toISOString() });
    }
});


app.post('/refresh-qr', async (req, res) => {
  try {
    if (!globalBrowser || !globalPage || globalPage.isClosed()) {
      return res.status(400).json({ success: false, error: 'WhatsApp session not initialized or page closed.' });
    }
    if (isLoggedIn) {
      return res.json({ success: true, message: 'Already logged in, no QR refresh needed.' });
    }

    console.log('🔄 Manual QR refresh requested...');
    takeScreenshot('before-manual-refresh');
    
    const env = detectEnvironment();
    await globalPage.goto('https://web.whatsapp.com/', { waitUntil: 'networkidle', timeout: env.isCloud ? 90000: 60000 });
    await globalPage.waitForTimeout(env.isCloud ? 20000 : 10000);
    await handleCompatibilityWarnings();

    const qrResult = await extractQRCode();
    if (qrResult.success) {
      takeScreenshot('manual-refresh-success');
      if (!isLoggedIn) monitorQRScanCompletion(); // Ensure monitoring is active
      res.json({ success: true, message: 'QR code refreshed successfully.', qrCode: qrResult.qrCode, metadata: qrResult.metadata });
    } else {
      takeScreenshot('manual-refresh-failed');
      res.status(500).json({ success: false, error: qrResult.error || 'Failed to extract fresh QR code during manual refresh.' });
    }
  } catch (error) {
    console.error('Manual QR refresh endpoint error:', error.message, error.stack);
    takeScreenshot('manual-refresh-error');
    if (globalPage && globalPage.isClosed()) {
        console.error("Page was closed during manual QR refresh. Session might be dead.");
    }
    res.status(500).json({ success: false, error: `Error during QR refresh: ${error.message}` });
  }
});

app.get('/screenshots', (req, res) => {
  try {
    const screenshotDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotDir)) {
      return res.json({ success: true, screenshots: [], count: 0 });
    }
    const files = fs.readdirSync(screenshotDir)
      .filter(file => file.endsWith('.png'))
      .map(file => {
        const filePath = path.join(screenshotDir, file);
        try {
            const stats = fs.statSync(filePath);
            return { filename: file, url: `/screenshot/${file}`, size: stats.size, created: stats.birthtime };
        } catch (e) { return null; } // File might be deleted between readdir and stat
      })
      .filter(file => file !== null)
      .sort((a, b) => new Date(b.created) - new Date(a.created));
    res.json({ success: true, screenshots: files.slice(0, 100), count: files.length }); // Limit to 100 recent
  } catch (error) {
    console.error('Error listing screenshots:', error);
    res.status(500).json({ success: false, error: 'Failed to list screenshots' });
  }
});

app.get('/screenshot/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    // Basic path traversal prevention
    if (filename.includes('..')) return res.status(400).json({ error: 'Invalid filename' });
    const filePath = path.join(__dirname, 'screenshots', filename);

    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Screenshot not found' });
    if (!filename.match(/\.png$/i)) return res.status(400).json({ error: 'Invalid file type' });
    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/take-screenshot', async (req, res) => {
    try {
        const { name = 'manual-screenshot' } = req.body;
        if (!globalPage || globalPage.isClosed()) {
            return res.status(400).json({ success: false, error: 'No active WhatsApp page to screenshot.' });
        }
        const screenshotDir = path.join(__dirname, 'screenshots');
        if (!fs.existsSync(screenshotDir)) fs.mkdirSync(screenshotDir, { recursive: true });
        const screenshotPath = path.join(screenshotDir, `${name.replace(/[^a-zA-Z0-9_-]/g, '')}-${Date.now()}.png`);
        
        await globalPage.screenshot({ path: screenshotPath, fullPage: true, timeout: 10000 });
        const filename = path.basename(screenshotPath);
        console.log(`📸 Manual screenshot saved: ${filename}`);
        res.json({ success: true, message: 'Screenshot taken.', filename, url: `/screenshot/${filename}` });
    } catch (error) {
        console.error('Manual screenshot error:', error.message);
        res.status(500).json({ success: false, error: `Failed to take screenshot: ${error.message}` });
    }
});

app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: {
      browserActive: !!(globalBrowser && globalBrowser.isConnected()),
      pageActive: !!(globalPage && !globalPage.isClosed()),
      isLoggedIn,
      isWhatsAppReady,
      qrMonitoringActive: !!qrMonitoringIntervalId,
      timestamp: new Date().toISOString()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString(), loggedIn: isLoggedIn, browserActive: !!globalBrowser });
});

app.post('/close', async (req, res) => {
  try {
    await cleanup();
    res.json({ success: true, message: 'WhatsApp session closed and resources cleaned up.' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});


// SMSGURUJI API - Keep as is if used
app.get('/get-whatsapp-list', async (req, res) => {
  const { userid, secret, method = 'list_whatsapp_l' } = req.query;
  if (!userid || !secret) {
    return res.status(400).json({ success: false, message: 'Missing userid or secret' });
  }
  try {
    const response = await axios.get('http://smsguruji.com/wa/api/wa.php', {
      params: { method, userid, secret }
    });
    res.json(response.data);
  } catch (error) {
    console.error('Error calling smsguruji API:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch WhatsApp list' });
  }
});


// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error in Express:', error.stack);
  res.status(500).json({ success: false, error: 'Internal server error', details: error.message });
});

// Graceful shutdown
const signals = ['SIGINT', 'SIGTERM', 'SIGQUIT'];
signals.forEach(signal => {
  process.on(signal, async () => {
    console.log(`\n🛑 Received ${signal}. Shutting down gracefully...`);
    await cleanup();
    console.log("Graceful shutdown complete.");
    process.exit(0);
  });
});

// Static serving for a potential frontend
app.use(express.static(path.join(__dirname, 'build')));
app.get('/', (req, res) => { // Serve index.html for the root path
  res.sendFile(path.join(__dirname, 'build', 'index.html'), err => {
      if (err && err.status === 404) { // If index.html not found, send simple message
          res.status(200).send('WhatsApp API Server is running. No frontend build found.');
      } else if (err) {
          res.status(500).send('Error serving frontend.');
      }
  });
});


app.listen(PORT, () => {
  console.log(`🚀 Enhanced WhatsApp API Server running on port ${PORT}`);
  // ... (other console logs from original code)
});

console.log('✅ WhatsApp API Server initialized and ready for requests!');

module.exports = app;
