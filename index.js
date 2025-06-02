const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json());
app.use(cors());

// Global browser instance
let globalBrowser = null;
let globalPage = null;
let isLoggedIn = false;
let isWhatsAppReady = false;

// Enhanced environment detection
function detectEnvironment() {
  const indicators = {
    render: !!(process.env.RENDER || process.env.RENDER_SERVICE_ID),
    railway: !!process.env.RAILWAY_ENVIRONMENT,
    heroku: !!process.env.DYNO,
    vercel: !!process.env.VERCEL,
    production: process.env.NODE_ENV === 'production',
    hasPort: !!process.env.PORT
  };

  const isCloud = Object.values(indicators).some(Boolean);

  console.log('🔧 Environment Detection:', indicators);
  return { isCloud, ...indicators };
}

// Force Playwright installation for cloud environments

// Enhanced Playwright installation
async function installPlaywright() {
  try {
    console.log('🔍 Installing Playwright browsers...');
    const { execSync } = require('child_process');

    // Set environment variables for Render
    const renderEnv = {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: '/opt/render/.cache',
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '0',
      DEBIAN_FRONTEND: 'noninteractive'
    };

    const installCommands = [
      'PLAYWRIGHT_BROWSERS_PATH=/opt/render/.cache npx playwright install chromium',
      'npx playwright install chromium',
      'PLAYWRIGHT_BROWSERS_PATH=/opt/render/.cache npx playwright install chromium --force'
    ];

    let installSuccess = false;
    for (const command of installCommands) {
      try {
        console.log(`🔄 Trying: ${command}`);
        execSync(command, {
          stdio: 'inherit',
          timeout: 600000, // 10 minutes for Render
          env: renderEnv
        });
        console.log(`✅ Success with: ${command}`);
        installSuccess = true;
        break;
      } catch (cmdError) {
        console.log(`❌ Failed: ${command} - ${cmdError.message}`);
        continue;
      }
    }

    if (!installSuccess) {
      console.log('⚠️ All installation methods failed, attempting to continue...');
    }

    return installSuccess;
  } catch (installError) {
    console.error('❌ Browser installation failed:', installError.message);
    return false;
  }
}

// Enhanced browser launch options specifically for Render and cloud platforms
function getBrowserLaunchOptions(env) {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--memory-pressure-off'
  ];

  // Enhanced user agent that mimics a real Chrome browser
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const launchOptions = {
    headless: true,
    args: baseArgs
  };

  // Render-specific optimizations
  if (env.render) {
    launchOptions.args.push(
      '--single-process',
      '--memory-pressure-off',
      '--max_old_space_size=4096',
      '--disable-features=VizDisplayCompositor',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout'
    );
  }

  // Add viewport and other options
  launchOptions.viewport = { width: 1366, height: 768 };
  launchOptions.userAgent = userAgent;

  return launchOptions;
}

// Enhanced context options to better mimic real browser
function getContextOptions() {
  return {
    viewport: { width: 1366, height: 768 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    hasTouch: false,
    isMobile: false,
    permissions: ['notifications'],
    locale: 'en-US',
    timezoneId: 'America/New_York',
    geolocation: { longitude: -74.006, latitude: 40.7128 }, // New York coordinates
    colorScheme: 'light',
    reducedMotion: 'reduce',
    forcedColors: 'none',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    }
  };
}

// Initialize WhatsApp Web session with enhanced stealth
async function initializeWhatsApp() {
  try {
    console.log('🚀 Initializing WhatsApp Web session...');

    const env = detectEnvironment();
    console.log(`🔧 Environment: ${env.isCloud ? 'Cloud' : 'Local'}`);

    // Check if already initialized and logged in
    if (globalBrowser && globalPage && isLoggedIn) {
      console.log('✅ WhatsApp session already active and logged in');
      return { loggedIn: true, alreadyInitialized: true };
    }

    // Check if browser exists but need to verify login status
    if (globalBrowser && globalPage) {
      console.log('� Browser exists, checking current login status...');
      const currentLoginStatus = await checkLoginStatus();
      if (currentLoginStatus.loggedIn) {
        isLoggedIn = true;
        isWhatsAppReady = true;
        console.log('✅ Already logged in, skipping initialization');
        return { loggedIn: true, alreadyInitialized: true };
      }
    }

    // Force Playwright installation every time on cloud environments
    if (env.isCloud) {
      console.log('🔧 Force installing Playwright browsers on cloud...');
      const installSuccess = await installPlaywright();
      if (!installSuccess) {
        console.log('⚠️ Browser installation failed, but attempting to continue...');
      }
    }

    const launchOptions = getBrowserLaunchOptions(env);
    console.log('🚀 Launching browser...');
    
    globalBrowser = await chromium.launch(launchOptions);

    const contextOptions = getContextOptions();
    const context = await globalBrowser.newContext(contextOptions);

    globalPage = await context.newPage();

    // Enhanced stealth measures - this is crucial for avoiding detection
    await globalPage.addInitScript(() => {
      // Remove webdriver property
      delete Object.getPrototypeOf(navigator).webdriver;
      delete navigator.__proto__.webdriver;
      delete navigator.webdriver;

      // Override the plugins property to use a custom getter
      Object.defineProperty(navigator, 'plugins', {
        get: function() {
          return [
            {
              0: {
                type: "application/x-google-chrome-pdf",
                suffixes: "pdf",
                description: "Portable Document Format",
                enabledPlugin: Plugin
              },
              description: "Portable Document Format",
              filename: "internal-pdf-viewer",
              length: 1,
              name: "Chrome PDF Plugin"
            },
            {
              0: {
                type: "application/pdf",
                suffixes: "pdf",
                description: "",
                enabledPlugin: Plugin
              },
              description: "",
              filename: "mhjfbmdgcfjbbpaeojofohoefgiehjai",
              length: 1,
              name: "Chrome PDF Viewer"
            }
          ];
        }
      });

      // Override the languages property
      Object.defineProperty(navigator, 'languages', {
        get: function() {
          return ['en-US', 'en'];
        }
      });

      // Override the chrome property
      Object.defineProperty(window, 'chrome', {
        get: function() {
          return {
            runtime: {},
            loadTimes: function() {},
            csi: function() {},
            app: {}
          };
        }
      });

      // Override the permissions property
      const originalQuery = window.navigator.permissions.query;
      window.navigator.permissions.query = (parameters) => (
        parameters.name === 'notifications' ?
          Promise.resolve({ state: Notification.permission }) :
          originalQuery(parameters)
      );

      // Add missing window.chrome
      if (!window.chrome) {
        window.chrome = {};
      }

      if (!window.chrome.runtime) {
        window.chrome.runtime = {};
      }

      // Override screen properties
      Object.defineProperty(screen, 'availHeight', { get: () => 738 });
      Object.defineProperty(screen, 'availWidth', { get: () => 1366 });
      Object.defineProperty(screen, 'colorDepth', { get: () => 24 });
      Object.defineProperty(screen, 'height', { get: () => 768 });
      Object.defineProperty(screen, 'pixelDepth', { get: () => 24 });
      Object.defineProperty(screen, 'width', { get: () => 1366 });

      // Override Date to avoid timezone detection
      const originalDate = Date;
      function FakeDate(...args) {
        if (args.length === 0) {
          return new originalDate();
        }
        return new originalDate(...args);
      }
      FakeDate.prototype = originalDate.prototype;
      FakeDate.now = originalDate.now;
      FakeDate.parse = originalDate.parse;
      FakeDate.UTC = originalDate.UTC;
      window.Date = FakeDate;

      // Override canvas fingerprinting
      const getContext = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function(type) {
        if (type === '2d') {
          const context = getContext.call(this, type);
          const originalFillText = context.fillText;
          context.fillText = function(text, x, y, maxWidth) {
            return originalFillText.call(this, text, x, y, maxWidth);
          };
          return context;
        }
        return getContext.call(this, type);
      };
    });

    // Set additional headers to mimic real browser
    await globalPage.setExtraHTTPHeaders({
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    });

    console.log('🌐 Navigating to WhatsApp Web...');
    
    // Navigate with retry mechanism
    let navigationSuccess = false;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(`🔄 Navigation attempt ${attempt}/${maxRetries}`);
        
        await globalPage.goto('https://web.whatsapp.com/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });

        // Wait for page to stabilize
        await globalPage.waitForTimeout(5000);

        // Check if page loaded successfully
        const title = await globalPage.title();
        console.log(`📄 Page title: ${title}`);

        if (title.toLowerCase().includes('whatsapp')) {
          navigationSuccess = true;
          break;
        }
      } catch (navError) {
        console.log(`❌ Navigation attempt ${attempt} failed:`, navError.message);
        if (attempt < maxRetries) {
          await globalPage.waitForTimeout(5000);
        }
      }
    }

    if (!navigationSuccess) {
      throw new Error('Failed to navigate to WhatsApp Web after multiple attempts');
    }

    // Enhanced wait strategy for cloud environments
    const stabilizeTime = env.isCloud ? 20000 : 10000;
    console.log(`⏳ Waiting ${stabilizeTime}ms for page to stabilize...`);
    await globalPage.waitForTimeout(stabilizeTime);

    // Take initial screenshot for debugging
    await globalPage.screenshot({
      path: `initial-load-${Date.now()}.png`,
      fullPage: true
    });

    // Handle compatibility warnings
    await handleCompatibilityWarnings();

    // Check for any error messages
    await checkForErrorMessages();

    // Enhanced login detection
    const loginResult = await checkLoginStatus();

    if (loginResult.loggedIn) {
      isLoggedIn = true;
      console.log('✅ User is already logged in');
      return { loggedIn: true };
    }

    // Check if already logged in after page load
    const finalLoginCheck = await checkLoginStatus();
    if (finalLoginCheck.loggedIn) {
      isLoggedIn = true;
      isWhatsAppReady = true;
      console.log('✅ User is already logged in after page load');
      return { loggedIn: true };
    }

    // Enhanced QR code detection with multiple attempts
    let qrResult = null;
    const qrAttempts = 5;

    for (let attempt = 1; attempt <= qrAttempts; attempt++) {
      console.log(`🔍 QR code extraction attempt ${attempt}/${qrAttempts}`);

      // Check if user logged in during attempts
      const loginCheck = await checkLoginStatus();
      if (loginCheck.loggedIn) {
        isLoggedIn = true;
        isWhatsAppReady = true;
        console.log('✅ User logged in during QR extraction attempts');
        return { loggedIn: true };
      }

      qrResult = await extractQRCode();

      if (qrResult.success) {
        console.log('✅ QR code extracted successfully');
        break;
      }

      if (attempt < qrAttempts) {
        console.log('⏳ Waiting before next QR extraction attempt...');
        await globalPage.waitForTimeout(5000);

        // Try refreshing the page every 2 attempts
        if (attempt % 2 === 0) {
          console.log('🔄 Refreshing page for QR code...');
          await globalPage.reload({ waitUntil: 'domcontentloaded' });
          await globalPage.waitForTimeout(10000);
        }
      }
    }

    if (!qrResult || !qrResult.success) {
      throw new Error(qrResult?.error || 'Failed to extract QR code after multiple attempts');
    }

    console.log('✅ QR code extracted successfully');

    // Start monitoring for QR scan completion
    monitorQRScanCompletion();

    return {
      loggedIn: false,
      qrCode: qrResult.qrCode,
      metadata: qrResult.metadata
    };

  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error.message);
    await cleanup();
    throw error;
  }
}

// Check for error messages that might indicate detection
async function checkForErrorMessages() {
  try {
    const errorMessages = await globalPage.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      const errors = [];
      
      if (text.includes("can't scan")) {
        errors.push("Can't scan device detected");
      }
      if (text.includes("unsupported browser")) {
        errors.push("Unsupported browser detected");
      }
      if (text.includes("not supported")) {
        errors.push("Not supported message detected");
      }
      if (text.includes("update your browser")) {
        errors.push("Update browser message detected");
      }
      
      return errors;
    });

    if (errorMessages.length > 0) {
      console.log('⚠️ Error messages detected:', errorMessages);
      
      // Take screenshot for debugging
      await globalPage.screenshot({
        path: `error-detected-${Date.now()}.png`,
        fullPage: true
      });
      
      // Try to handle the error by refreshing
      console.log('🔄 Attempting to handle error by refreshing...');
      await globalPage.reload({ waitUntil: 'domcontentloaded' });
      await globalPage.waitForTimeout(10000);
    }
  } catch (error) {
    console.log('⚠️ Error checking for error messages:', error.message);
  }
}


// Enhanced login status check
async function checkLoginStatus() {
  try {
    console.log('🔍 Checking login status...');

    const env = detectEnvironment();
    const timeout = env.isCloud ? 30000 : 15000;

    // Check for loading states first
    const loadingSelectors = [
      'div:has-text("Loading chats")',
      'div:has-text("Loading...")',
      '[data-testid="startup-progress"]',
      '.progress-container',
      '.loading-screen'
    ];

    for (const selector of loadingSelectors) {
      try {
        const loadingElement = await globalPage.$(selector);
        if (loadingElement && await loadingElement.isVisible()) {
          console.log(`⏳ Found loading state: ${selector}`);
          await globalPage.waitForTimeout(15000);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    const loginSelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[title="Search or start new chat"]',
      'div[role="textbox"][data-tab="3"]',
      '[data-testid="side"]',
      '#side'
    ];

    for (const selector of loginSelectors) {
      try {
        const element = await globalPage.waitForSelector(selector, {
          timeout: 5000,
          state: 'visible'
        });

        if (element && await element.isVisible()) {
          console.log(`✅ Login detected with: ${selector}`);
          return { loggedIn: true };
        }
      } catch (e) {
        continue;
      }
    }

    return { loggedIn: false };
  } catch (error) {
    console.log('⚠️ Error checking login status:', error.message);
    return { loggedIn: false };
  }
}

// Enhanced QR code extraction with better error handling
async function extractQRCode() {
  try {
    console.log('🔍 Extracting QR code...');

    // Wait for QR code to fully load
    const env = detectEnvironment();
    const waitTime = env.isCloud ? 15000 : 8000;
    await globalPage.waitForTimeout(waitTime);

    // Take screenshot before QR extraction for debugging
    await globalPage.screenshot({
      path: `before-qr-extraction-${Date.now()}.png`,
      fullPage: true
    });

    const qrSelectors = [
      'canvas[aria-label*="QR"]',
      'canvas[aria-label*="Scan"]',
      '[data-testid="qr-code"] canvas',
      '[data-testid="qr-canvas"]',
      '.qr-wrapper canvas',
      '.landing-wrapper canvas',
      'canvas[role="img"]',
      'canvas'
    ];

    let qrElement = null;
    let usedSelector = '';

    // Log all canvas elements for debugging
    const allCanvases = await globalPage.$$('canvas');
    console.log(`🔍 Found ${allCanvases.length} canvas elements on page`);

    for (let i = 0; i < allCanvases.length; i++) {
      const canvas = allCanvases[i];
      try {
        const box = await canvas.boundingBox();
        const isVisible = await canvas.isVisible();
        console.log(`Canvas ${i}: visible=${isVisible}, box=${JSON.stringify(box)}`);
      } catch (e) {
        console.log(`Canvas ${i}: error getting info - ${e.message}`);
      }
    }

    for (const selector of qrSelectors) {
      try {
        const elements = await globalPage.$$(selector);
        console.log(`🔍 Selector "${selector}" found ${elements.length} elements`);

        for (const element of elements) {
          if (!await element.isVisible()) {
            console.log(`Element not visible for selector: ${selector}`);
            continue;
          }

          const box = await element.boundingBox();
          if (!box || box.width < 50 || box.height < 50) {
            console.log(`Element too small for selector: ${selector}, box:`, box);
            continue;
          }

          // Validate canvas has content
          const hasContent = await element.evaluate(canvas => {
            if (canvas.tagName.toLowerCase() !== 'canvas') return true;

            try {
              const ctx = canvas.getContext('2d');
              const imageData = ctx.getImageData(0, 0, Math.min(50, canvas.width), Math.min(50, canvas.height));
              const hasPixels = imageData.data.some((pixel, index) => index % 4 !== 3 && pixel > 30);
              return hasPixels;
            } catch (e) {
              console.log('Error checking canvas content:', e.message);
              return false;
            }
          });

          console.log(`Canvas content check for ${selector}: ${hasContent}`);

          if (hasContent) {
            qrElement = element;
            usedSelector = selector;
            console.log(`✅ Found valid QR canvas with selector: ${selector}`);
            break;
          }
        }

        if (qrElement) break;

      } catch (e) {
        console.log(`Error with selector ${selector}:`, e.message);
        continue;
      }
    }

    if (!qrElement) {
      // Debug screenshot
      await globalPage.screenshot({
        path: `debug-no-qr-${Date.now()}.png`,
        fullPage: true
      });

      // Try to get page content for debugging
      const pageText = await globalPage.evaluate(() => document.body.innerText);
      console.log('📄 Page text preview:', pageText.substring(0, 500));

      return {
        success: false,
        error: 'QR code element not found',
        debug: `Check debug-no-qr-${Date.now()}.png`
      };
    }

    // Extract QR code
    let qrDataUrl;
    const tagName = await qrElement.evaluate(el => el.tagName.toLowerCase());

    if (tagName === 'canvas') {
      // Wait for canvas to be fully rendered
      await globalPage.waitForTimeout(3000);

      qrDataUrl = await qrElement.evaluate(canvas => {
        try {
          return canvas.toDataURL('image/png');
        } catch (e) {
          console.log('Error converting canvas to data URL:', e.message);
          return null;
        }
      });
    }

    // Fallback to screenshot
    if (!qrDataUrl || qrDataUrl.length < 1000) {
      console.log('🔄 Using screenshot fallback for QR code');
      const screenshot = await qrElement.screenshot({ type: 'png' });
      qrDataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
    }

    // Validate QR code data
    if (!qrDataUrl || qrDataUrl.length < 1000) {
      return {
        success: false,
        error: 'QR code data too small or invalid'
      };
    }

    console.log(`✅ QR code extracted successfully, size: ${qrDataUrl.length} characters`);

    return {
      success: true,
      qrCode: qrDataUrl,
      metadata: {
        selector: usedSelector,
        elementType: tagName,
        timestamp: new Date().toISOString(),
        dataSize: qrDataUrl.length
      }
    };

  } catch (error) {
    console.error('❌ QR extraction failed:', error.message);
    
    // Take error screenshot
    try {
      await globalPage.screenshot({
        path: `qr-extraction-error-${Date.now()}.png`,
        fullPage: true
      });
    } catch (e) {
      console.log('Could not take error screenshot');
    }

    return {
      success: false,
      error: error.message
    };
  }
}

// Enhanced QR scan monitoring with better login detection
async function monitorQRScanCompletion() {
  try {
    console.log('🔍 Starting enhanced QR scan monitoring...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 300000 : 180000;
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      try {
        if (!globalPage) {
          clearInterval(checkInterval);
          return;
        }

        // Skip if already logged in
        if (isLoggedIn) {
          clearInterval(checkInterval);
          return;
        }

        console.log('🔍 Checking login status...');
        const loginResult = await checkLoginStatus();

        if (loginResult.loggedIn) {
          console.log('✅ Login detected with:', loginResult.foundSelector);
          console.log('✅ QR scan completed! User is now logged in');
          isLoggedIn = true;
          isWhatsAppReady = true;
          clearInterval(checkInterval);

          // Handle any post-login dialogs
          await handleDialogs();
          return;
        }

        // Check if QR code is still visible, refresh if needed
        const qrElements = await globalPage.$$('canvas[aria-label*="QR"], canvas[aria-label*="Scan"]');
        if (qrElements.length === 0) {
          console.log('🔄 QR code disappeared, refreshing page...');
          try {
            await globalPage.reload({ waitUntil: 'domcontentloaded' });
            await globalPage.waitForTimeout(8000);
          } catch (e) {
            console.log('⚠️ Error refreshing for QR:', e.message);
          }
        }

        if ((Date.now() - startTime) > maxWaitTime) {
          console.log('⏰ QR scan monitoring timeout reached');
          clearInterval(checkInterval);
          return;
        }

      } catch (error) {
        console.log('⚠️ Error during QR monitoring:', error.message);
      }
    }, 5000); // Check every 5 seconds for faster detection

  } catch (error) {
    console.error('❌ QR scan monitoring failed:', error.message);
  }
}

// Rest of the functions remain the same...
async function waitForWhatsAppReady() {
  try {
    console.log('⏳ Waiting for WhatsApp to be fully loaded...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 60000 : 30000;
    const startTime = Date.now();

    const readySelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="side"]',
      'div[id="side"]',
      '[data-testid="chat-list-search"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    while ((Date.now() - startTime) < maxWaitTime) {
      await handleDialogs();

      for (const selector of readySelectors) {
        try {
          const element = await globalPage.$(selector);
          if (element && await element.isVisible()) {
            console.log(`✅ WhatsApp ready - found: ${selector}`);
            await globalPage.waitForTimeout(5000);
            isWhatsAppReady = true;
            return true;
          }
        } catch (e) {
          continue;
        }
      }

      console.log('⏳ Still waiting for WhatsApp interface...');
      await globalPage.waitForTimeout(5000);
    }

    throw new Error(`WhatsApp interface not ready after ${maxWaitTime}ms`);

  } catch (error) {
    console.error('❌ Error waiting for WhatsApp to be ready:', error.message);
    throw error;
  }
}

async function navigateToChat(mobile) {
  try {
    console.log(`📞 Navigating to chat: ${mobile}`);

    if (!isWhatsAppReady) {
      console.log('⏳ WhatsApp not ready yet, waiting...');
      await waitForWhatsAppReady();
    }

    await handleDialogs();

    const cleanNumber = mobile.replace(/[^\d]/g, '');
    const waUrl = `https://web.whatsapp.com/send?phone=${cleanNumber}`;
    
    console.log(`🌐 Navigating to: ${waUrl}`);
    
    await globalPage.goto(waUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await globalPage.waitForTimeout(5000);
    await handleDialogs();

    const chatSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[data-testid="compose-input"]',
      'footer[data-testid="compose"]',
      '[data-testid="compose-box-input"]'
    ];

    let chatFound = false;
    let workingSelector = null;
    
    for (const selector of chatSelectors) {
      try {
        await globalPage.waitForSelector(selector, {
          timeout: 20000,
          state: 'visible'
        });
        
        const element = await globalPage.$(selector);
        if (element) {
          const isVisible = await element.isVisible();
          const isEnabled = await element.isEnabled();
          
          if (isVisible && isEnabled) {
            chatFound = true;
            workingSelector = selector;
            console.log(`✅ Chat interface loaded with selector: ${selector}`);
            break;
          }
        }
      } catch (e) {
        continue;
      }
    }

    if (!chatFound) {
      await globalPage.screenshot({
        path: `debug-chat-not-found-${cleanNumber}-${Date.now()}.png`,
        fullPage: true
      });
      throw new Error('Chat interface not found after navigation');
    }

    await globalPage.waitForTimeout(3000);

    if (workingSelector) {
      try {
        await globalPage.click(workingSelector);
        console.log('🎯 Chat input focused and ready');
      } catch (e) {
        console.log('⚠️ Could not focus chat input, but proceeding...');
      }
    }

    console.log(`✅ Successfully navigated to chat: ${mobile}`);
    return true;

  } catch (error) {
    console.error(`❌ Failed to navigate to chat ${mobile}:`, error.message);

    try {
      await globalPage.screenshot({
        path: `debug-nav-fail-${mobile.replace(/[^\d]/g, '')}-${Date.now()}.png`,
        fullPage: true,
      });
    } catch (e) {
      console.log('Could not take debug screenshot');
    }

    throw error;
  }
}

async function handleDialogs() {
  try {
    const dialogSelectors = [
      'button[data-testid="continue-button"]',
      'button:has-text("Continue")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      '[data-testid="popup-panel-ok-button"]',
      '[role="button"]:has-text("OK")',
      'button[aria-label="Close"]',
      'div[data-testid="modal"] button'
    ];

    for (const selector of dialogSelectors) {
      try {
        const button = await globalPage.$(selector);
        if (button && await button.isVisible()) {
          console.log(`📋 Handling dialog: ${selector}`);
          await button.click();
          await globalPage.waitForTimeout(2000);
          break;
        }
      } catch (e) {
        continue;
      }
    }
  } catch (error) {
    console.log('⚠️ Error handling dialogs:', error.message);
  }
}

async function sendCombinedMessage(mobile, message = '', mediaUrl = '', caption = '') {
  try {
    console.log(`📤 Sending combined message to ${mobile}:`, {
      hasMessage: !!message,
      hasMedia: !!mediaUrl,
      hasCaption: !!caption
    });

    await navigateToChat(mobile);
    await handleDialogs();

    const messageSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]'
    ];

    let messageBox = null;
    for (const selector of messageSelectors) {
      try {
        messageBox = await globalPage.$(selector);
        if (messageBox && await messageBox.isVisible()) {
          console.log(`✅ Found message box: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!messageBox) {
      throw new Error('Message input box not found');
    }

    await messageBox.click();
    await globalPage.waitForTimeout(500);
    await messageBox.selectText();
    await globalPage.keyboard.press('Delete');
    await globalPage.waitForTimeout(500);

    let combinedContent = '';

    if (mediaUrl) {
      combinedContent += mediaUrl;
    }

    if (caption) {
      combinedContent += combinedContent ? `\n${caption}` : caption;
    }

    if (message) {
      combinedContent += combinedContent ? `\n${message}` : message;
    }

    if (!combinedContent) {
      throw new Error('No content to send');
    }

    console.log(`📝 Combined content to send:\n${combinedContent}`);

    // Type the combined content using multiple methods for reliability
    let typingSuccess = false;

    // Method 1: Direct typing with shorter timeout
    try {
      await messageBox.type(combinedContent, { delay: 30, timeout: 15000 });
      typingSuccess = true;
      console.log('✅ Direct typing successful');
    } catch (typeError) {
      console.log('⚠️ Direct typing failed, trying alternative method...');

      // Method 2: Focus and use keyboard
      try {
        await messageBox.focus();
        await globalPage.keyboard.type(combinedContent, { delay: 30 });
        typingSuccess = true;
        console.log('✅ Keyboard typing successful');
      } catch (keyboardError) {
        console.log('⚠️ Keyboard typing failed, trying clipboard method...');

        // Method 3: Use clipboard
        try {
          await globalPage.evaluate((text) => {
            navigator.clipboard.writeText(text);
          }, combinedContent);

          await messageBox.focus();
          await globalPage.keyboard.press('Control+V');
          typingSuccess = true;
          console.log('✅ Clipboard typing successful');
        } catch (clipboardError) {
          console.log('❌ All typing methods failed');
        }
      }
    }

    if (!typingSuccess) {
      throw new Error('Failed to type message content');
    }

    await globalPage.waitForTimeout(2000);

    // Send the message
    await globalPage.keyboard.press('Enter');
    await globalPage.waitForTimeout(3000);

    console.log(`✅ Combined message sent to ${mobile}`);
    return {
      success: true,
      mobile,
      message: 'Combined message sent successfully',
      content: { mediaUrl, caption, message }
    };

  } catch (error) {
    console.error(`❌ Failed to send combined message to ${mobile}:`, error.message);

    try {
      await globalPage.screenshot({
        path: `debug-combined-send-fail-${Date.now()}.png`,
        fullPage: true
      });
    } catch (e) {
      console.log('Could not take debug screenshot');
    }

    return { success: false, mobile, error: error.message };
  }
}

async function cleanup() {
  try {
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
      isLoggedIn = false;
      isWhatsAppReady = false;
      console.log('🧹 Browser cleaned up');
    }
  } catch (error) {
    console.log('⚠️ Error during cleanup:', error.message);
  }
}

// API Routes
app.post('/initialize', async (req, res) => {
  try {
    if (isLoggedIn && globalBrowser) {
      return res.json({
        success: true,
        message: 'WhatsApp session already active'
      });
    }

    const result = await initializeWhatsApp();

    res.json({
      success: true,
      message: 'WhatsApp session initialized successfully',
      qrCode: result.qrCode || null,
      loggedIn: result.loggedIn || false,
      metadata: result.metadata || null
    });
  } catch (error) {
    console.error('Initialize endpoint error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.post('/send-messages', async (req, res) => {
  try {
    const { whatsapp } = req.body;

    if (!whatsapp || !Array.isArray(whatsapp) || whatsapp.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected array of WhatsApp messages.'
      });
    }

    if (!globalPage || !globalBrowser) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.',
        debug: {
          browserActive: !!globalBrowser,
          pageActive: !!globalPage,
          isLoggedIn: isLoggedIn
        }
      });
    }

    console.log(`📤 Processing ${whatsapp.length} messages...`);

    const results = [];

    for (const item of whatsapp) {
      const { id, mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = item;

      const mediaUrl = filePath || link;

      if (!mobile || (!message && !mediaUrl)) {
        results.push({
          id,
          success: false,
          mobile,
          error: 'Mobile number and either message or media (filePath/link) are required'
        });
        continue;
      }

      console.log(`📤 Processing message for ${mobile}:`, {
        hasMessage: !!message,
        hasMedia: !!mediaUrl,
        caption: caption || 'none'
      });

      const result = await sendCombinedMessage(mobile, message, mediaUrl, caption);
      results.push({
        id,
        ...result
      });

      if (whatsapp.indexOf(item) < whatsapp.length - 1) {
        console.log('⏳ Waiting 3 seconds before next message...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }

    const successful = results.filter(r => r.success).length;
    const failed = results.filter(r => !r.success).length;

    console.log(`🎉 Bulk messaging completed: ${successful} successful, ${failed} failed`);

    res.json({
      success: true,
      summary: {
        total: whatsapp.length,
        successful,
        failed
      },
      results
    });

  } catch (error) {
    console.error('❌ Bulk messaging error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});



app.get('/debug-files/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    if (!filename.match(/\.(png|jpg|jpeg)$/i)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/screenshots', (req, res) => {
  try {
    const serverDir = __dirname;

    const readDirectory = (dirPath) => {
      try {
        if (!fs.existsSync(dirPath)) {
          return [];
        }
        return fs.readdirSync(dirPath).filter(file =>
          file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')
        );
      } catch (err) {
        console.log(`Error reading directory ${dirPath}:`, err.message);
        return [];
      }
    };

    const serverFiles = readDirectory(serverDir);
    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const screenshots = serverFiles.map(file => ({
      filename: file,
      location: 'server',
      url: `${baseUrl}/debug-files/${file}`,
      size: fs.existsSync(path.join(serverDir, file)) ? fs.statSync(path.join(serverDir, file)).size : 0,
      modified: fs.existsSync(path.join(serverDir, file)) ? fs.statSync(path.join(serverDir, file)).mtime : null
    }));

    screenshots.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({
      success: true,
      count: screenshots.length,
      screenshots,
      directories: {
        server: serverDir
      }
    });
  } catch (error) {
    console.error('Error listing screenshots:', error);
    res.status(500).json({
      success: false,
      error: 'Unable to read screenshot directories.',
      details: error.message
    });
  }
});
app.get('/get-whatsapp-list', async (req, res) => {
  const { userid, secret, method = 'list_whatsapp_l' } = req.query;
  console.log(req.query);

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


app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: {
      browserActive: !!globalBrowser,
      pageActive: !!globalPage,
      loggedIn: isLoggedIn,
      timestamp: new Date().toISOString()
    }
  });
});

app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (globalBrowser) {
    await globalBrowser.close();
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  if (globalBrowser) {
    await globalBrowser.close();
  }
  process.exit(0);
});

app.use(express.static(path.join(__dirname, 'build')));

app.get('', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🚀 Enhanced WhatsApp API Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Initialize WhatsApp: POST http://localhost:${PORT}/initialize`);
  console.log(`📤 Send bulk messages: POST http://localhost:${PORT}/send-messages`);
});

module.exports = app;