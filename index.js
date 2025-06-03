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

// Non-blocking screenshot helper function
async function takeScreenshot(filename, fullPage = true) {
  // Don't block execution if screenshot fails
  setImmediate(async () => {
    try {
      if (!globalPage) {
        console.log('⚠️ Cannot take screenshot - no active page');
        return;
      }

      // Check if page is still valid
      const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
      if (!isPageValid) {
        console.log('⚠️ Cannot take screenshot - page context destroyed');
        return;
      }

      const screenshotPath = path.join(__dirname, `${filename}-${Date.now()}.png`);
      
      await globalPage.screenshot({
        path: screenshotPath,
        fullPage: fullPage,
        timeout: 5000 // Reduced timeout
      });
      
      console.log(`📸 Screenshot saved: ${path.basename(screenshotPath)}`);
    } catch (error) {
      // Don't log screenshot errors as they're not critical
      // console.log(`⚠️ Screenshot ${filename} skipped:`, error.message);
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
    hasPort: !!process.env.PORT
  };

  const isCloud = Object.values(indicators).some(Boolean);
  console.log('🔧 Environment Detection:', indicators);
  return { isCloud, ...indicators };
}

// Browser launch options
function getBrowserLaunchOptions(env) {
  const baseArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--no-first-run',
    '--disable-extensions',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--hide-scrollbars',
    '--mute-audio',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor'
  ];

  if (env.render || env.isCloud) {
    baseArgs.push(
      '--single-process',
      '--memory-pressure-off',
      '--max_old_space_size=4096'
    );
  }

  return {
    headless: true,
    args: baseArgs,
    viewport: { width: 1366, height: 768 }
  };
}

// Initialize WhatsApp Web session
async function initializeWhatsApp() {
  try {
    console.log('🚀 Initializing WhatsApp Web session...');

    const env = detectEnvironment();
    
    // Install browsers in cloud environments
    if (env.isCloud) {
      try {
        console.log('🔍 Installing Playwright browsers...');
        const { execSync } = require('child_process');
        execSync('npx playwright install chromium', {
          stdio: 'inherit',
          timeout: 300000
        });
        console.log('✅ Browser installation completed');
      } catch (installError) {
        console.log('⚠️ Browser installation failed, continuing anyway:', installError.message);
      }
    }

    const launchOptions = getBrowserLaunchOptions(env);
    
    console.log('🚀 Launching browser...');
    globalBrowser = await chromium.launch(launchOptions);

    const context = await globalBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      permissions: ['notifications'],
      locale: 'en-US',
      extraHTTPHeaders: {
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache'
      }
    });

    globalPage = await context.newPage();

    // Add stealth script
    await globalPage.addInitScript(() => {
      delete Object.getPrototypeOf(navigator).webdriver;
      delete navigator.__proto__.webdriver;
      delete navigator.webdriver;

      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });

      window.chrome = {
        runtime: {},
        loadTimes: function() {},
        csi: function() {},
        app: {}
      };
    });

    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for page to stabilize
    const stabilizeTime = env.isCloud ? 15000 : 8000;
    console.log(`⏳ Waiting ${stabilizeTime}ms for page to stabilize...`);
    await globalPage.waitForTimeout(stabilizeTime);

    // Take initial screenshot
    takeScreenshot('initial-load');

    // Handle any compatibility warnings
    await handleCompatibilityWarnings();

    // Check login status
    const loginResult = await checkLoginStatus();
    if (loginResult.loggedIn) {
      isLoggedIn = true;
      console.log('✅ User is already logged in');
      takeScreenshot('already-logged-in');
      return { loggedIn: true };
    }

    // Extract QR code
    const qrResult = await extractQRCode();
    if (!qrResult.success) {
      takeScreenshot('qr-extraction-failed');
      throw new Error(qrResult.error || 'Failed to extract QR code');
    }

    console.log('✅ QR code extracted successfully');
    takeScreenshot('qr-extracted');
    
    // Start monitoring for login
    monitorQRScanCompletion();

    return {
      loggedIn: false,
      qrCode: qrResult.qrCode,
      metadata: qrResult.metadata
    };

  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error.message);
    takeScreenshot('initialization-failed');
    await cleanup();
    throw error;
  }
}

// Handle compatibility warnings
async function handleCompatibilityWarnings() {
  try {
    console.log('🔍 Checking for compatibility warnings...');
    await globalPage.waitForTimeout(5000);

    // Check if page context is still valid
    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      console.log('⚠️ Page context destroyed during compatibility check');
      return;
    }

    const pageContent = await globalPage.evaluate(() => {
      return document.body.innerText.toLowerCase();
    }).catch(() => '');

    if (pageContent.includes('chrome') || 
        pageContent.includes('browser') || 
        pageContent.includes('supported') ||
        pageContent.includes("can't scan")) {
      
      console.log('⚠️ Compatibility warning detected');
      takeScreenshot('compatibility-warning');

      const continueSelectors = [
        'button[data-testid="continue-button"]',
        'button:has-text("Continue")',
        'button:has-text("CONTINUE")',
        'button:has-text("Use WhatsApp Web")',
        'button[type="button"]'
      ];

      let buttonClicked = false;
      for (const selector of continueSelectors) {
        try {
          const buttons = await globalPage.$$(selector);
          for (const button of buttons) {
            if (await button.isVisible()) {
              const buttonText = await button.textContent();
              console.log(`🔍 Found button: "${buttonText}"`);
              
              await button.click();
              console.log(`✅ Clicked button: "${buttonText}"`);
              await globalPage.waitForTimeout(5000);
              takeScreenshot('after-continue-click');
              buttonClicked = true;
              break;
            }
          }
          if (buttonClicked) break;
        } catch (e) {
          continue;
        }
      }

      if (!buttonClicked) {
        console.log('⚠️ No continue button found, refreshing page...');
        takeScreenshot('no-continue-button');
        await globalPage.reload({ waitUntil: 'domcontentloaded' });
        await globalPage.waitForTimeout(10000);
        takeScreenshot('after-refresh');
      }
    }
  } catch (error) {
    console.log('⚠️ Error handling compatibility warnings:', error.message);
    takeScreenshot('compatibility-error');
  }
}

// Check login status with better error handling
async function checkLoginStatus() {
  try {
    console.log('🔍 Checking login status...');

    // Check if page context is still valid
    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      console.log('⚠️ Page context destroyed during login check');
      return { loggedIn: false };
    }

    const loginSelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="side"]',
      'div[id="side"]',
      '[data-testid="chat-list-search"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    for (const selector of loginSelectors) {
      try {
        const element = await globalPage.waitForSelector(selector, {
          timeout: 3000,
          state: 'visible'
        });

        if (element && await element.isVisible()) {
          console.log(`✅ Login detected with: ${selector}`);
          takeScreenshot('login-detected');
          return { loggedIn: true };
        }
      } catch (e) {
        continue;
      }
    }

    takeScreenshot('login-not-detected');
    return { loggedIn: false };
  } catch (error) {
    console.log('⚠️ Error checking login status:', error.message);
    return { loggedIn: false };
  }
}

// Extract QR code with better error handling
async function extractQRCode() {
  try {
    console.log('🔍 Extracting QR code...');
    
    const env = detectEnvironment();
    const waitTime = env.isCloud ? 12000 : 6000;
    await globalPage.waitForTimeout(waitTime);

    // Check if page context is still valid
    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      console.log('⚠️ Page context destroyed during QR extraction');
      return { success: false, error: 'Page context destroyed' };
    }

    takeScreenshot('before-qr-extraction');

    const qrSelectors = [
      'canvas[aria-label*="QR"]',
      'canvas[aria-label*="Scan"]',
      '[data-testid="qr-code"] canvas',
      '[data-testid="qr-canvas"]',
      'canvas'
    ];

    let qrElement = null;
    let usedSelector = '';

    // Log all canvas elements for debugging
    const allCanvases = await globalPage.$$('canvas').catch(() => []);
    console.log(`🔍 Found ${allCanvases.length} canvas elements on page`);

    for (const selector of qrSelectors) {
      try {
        const elements = await globalPage.$$(selector);
        console.log(`🔍 Selector "${selector}" found ${elements.length} elements`);

        for (const element of elements) {
          if (!await element.isVisible()) continue;

          const box = await element.boundingBox();
          if (!box || box.width < 50 || box.height < 50) continue;

          // Check if canvas has content
          const hasContent = await element.evaluate(canvas => {
            if (canvas.tagName.toLowerCase() !== 'canvas') return true;

            try {
              const ctx = canvas.getContext('2d');
              const imageData = ctx.getImageData(0, 0, Math.min(50, canvas.width), Math.min(50, canvas.height));
              return imageData.data.some((pixel, index) => index % 4 !== 3 && pixel > 30);
            } catch (e) {
              return false;
            }
          }).catch(() => false);

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
      takeScreenshot('qr-element-not-found');
      
      // Get page content for debugging
      const pageText = await globalPage.evaluate(() => document.body.innerText).catch(() => 'Could not get page text');
      console.log('📄 Page text preview:', pageText.substring(0, 500));

      return {
        success: false,
        error: 'QR code element not found'
      };
    }

    // Extract QR code data
    await globalPage.waitForTimeout(3000);
    
    const qrDataUrl = await qrElement.evaluate(canvas => {
      try {
        return canvas.toDataURL('image/png');
      } catch (e) {
        return null;
      }
    }).catch(() => null);

    // Fallback to screenshot if canvas method fails
    if (!qrDataUrl || qrDataUrl.length < 1000) {
      console.log('🔄 Using screenshot fallback for QR code');
      try {
        const screenshot = await qrElement.screenshot({ type: 'png' });
        const fallbackDataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
        
        takeScreenshot('qr-fallback-used');
        
        return {
          success: true,
          qrCode: fallbackDataUrl,
          metadata: {
            selector: usedSelector,
            method: 'screenshot',
            timestamp: new Date().toISOString()
          }
        };
      } catch (screenshotError) {
        console.log('❌ Screenshot fallback also failed:', screenshotError.message);
        return {
          success: false,
          error: 'Both canvas and screenshot methods failed'
        };
      }
    }

    console.log(`✅ QR code extracted successfully, size: ${qrDataUrl.length} characters`);
    takeScreenshot('qr-extraction-success');

    return {
      success: true,
      qrCode: qrDataUrl,
      metadata: {
        selector: usedSelector,
        method: 'canvas',
        timestamp: new Date().toISOString(),
        dataSize: qrDataUrl.length
      }
    };

  } catch (error) {
    console.error('❌ QR extraction failed:', error.message);
    takeScreenshot('qr-extraction-error');
    return {
      success: false,
      error: error.message
    };
  }
}

// Monitor QR scan completion with better error handling
function monitorQRScanCompletion() {
  console.log('🔍 Starting QR scan monitoring...');

  const env = detectEnvironment();
  const maxWaitTime = env.isCloud ? 300000 : 180000;
  const qrRefreshInterval = 120000; // Refresh QR every 2 minutes
  let startTime = Date.now();
  let lastQRRefresh = Date.now();

  const checkInterval = setInterval(async () => {
    try {
      if (!globalPage || isLoggedIn) {
        clearInterval(checkInterval);
        return;
      }

      // Check if page context is still valid
      const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
      if (!isPageValid) {
        console.log('⚠️ Page context destroyed during monitoring, stopping...');
        clearInterval(checkInterval);
        return;
      }

      const currentTime = Date.now();
      console.log('🔍 Checking login status...');
      
      const loginResult = await checkLoginStatus();
      if (loginResult.loggedIn) {
        console.log('✅ QR scan completed! User is now logged in');
        isLoggedIn = true;
        isWhatsAppReady = true;
        takeScreenshot('qr-scan-completed');
        clearInterval(checkInterval);
        return;
      }

      // Auto-refresh QR code to prevent timeout
      if ((currentTime - lastQRRefresh) > qrRefreshInterval) {
        console.log('🔄 Auto-refreshing page for fresh QR code...');
        try {
          takeScreenshot('before-auto-refresh');
          await globalPage.reload({ waitUntil: 'domcontentloaded' });
          await globalPage.waitForTimeout(15000);
          await handleCompatibilityWarnings();
          takeScreenshot('after-auto-refresh');
          lastQRRefresh = currentTime;
          console.log('✅ Page refreshed successfully');
        } catch (e) {
          console.log('⚠️ Error refreshing for QR:', e.message);
        }
      }

      // Check if QR code is still visible (with error handling)
      try {
        const qrElements = await globalPage.$$('canvas[aria-label*="QR"], canvas[aria-label*="Scan"]');
        if (qrElements.length === 0) {
          console.log('🔄 QR code not visible, refreshing page...');
          takeScreenshot('qr-disappeared');
          await globalPage.reload({ waitUntil: 'domcontentloaded' });
          await globalPage.waitForTimeout(15000);
          await handleCompatibilityWarnings();
          takeScreenshot('after-qr-refresh');
          lastQRRefresh = currentTime;
        }
      } catch (e) {
        console.log('⚠️ Error checking QR visibility:', e.message);
      }

      // Reset timer if max wait time reached
      if ((currentTime - startTime) > maxWaitTime) {
        console.log('⏰ QR scan monitoring timeout reached, continuing...');
        takeScreenshot('monitoring-timeout');
        // Reset timer to continue monitoring
        startTime = Date.now();
        lastQRRefresh = Date.now();
      }

    } catch (error) {
      console.log('⚠️ Error during QR monitoring:', error.message);
    }
  }, 10000); // Check every 10 seconds
}

// Wait for WhatsApp to be ready with better error handling
async function waitForWhatsAppReady() {
  try {
    console.log('⏳ Waiting for WhatsApp to be fully loaded...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 45000 : 25000;
    const startTime = Date.now();

    const readySelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="side"]',
      'div[id="side"]',
      '[data-testid="chat-list-search"]'
    ];

    while ((Date.now() - startTime) < maxWaitTime) {
      // Check if page context is still valid
      const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
      if (!isPageValid) {
        console.log('⚠️ Page context destroyed while waiting for WhatsApp');
        throw new Error('Page context destroyed');
      }

      for (const selector of readySelectors) {
        try {
          const element = await globalPage.$(selector);
          if (element && await element.isVisible()) {
            console.log(`✅ WhatsApp ready - found: ${selector}`);
            await globalPage.waitForTimeout(3000);
            takeScreenshot('whatsapp-ready');
            isWhatsAppReady = true;
            return true;
          }
        } catch (e) {
          continue;
        }
      }

      console.log('⏳ Still waiting for WhatsApp interface...');
      await globalPage.waitForTimeout(3000);
    }

    takeScreenshot('whatsapp-not-ready');
    throw new Error(`WhatsApp interface not ready after ${maxWaitTime}ms`);

  } catch (error) {
    console.error('❌ Error waiting for WhatsApp to be ready:', error.message);
    takeScreenshot('whatsapp-ready-error');
    throw error;
  }
}

// Handle dialogs that might appear
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

// Navigate to specific chat with better error handling
async function navigateToChat(mobile) {
  try {
    console.log(`📞 Navigating to chat: ${mobile}`);

    if (!isWhatsAppReady) {
      console.log('⏳ WhatsApp not ready yet, waiting...');
      await waitForWhatsAppReady();
    }

    // Handle any dialogs first
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
    takeScreenshot(`navigate-to-${cleanNumber}`);

    const chatSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
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
        if (element && await element.isVisible()) {
          chatFound = true;
          workingSelector = selector;
          console.log(`✅ Chat interface loaded with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!chatFound) {
      takeScreenshot(`chat-not-found-${cleanNumber}`);
      throw new Error('Chat interface not found after navigation');
    }

    await globalPage.waitForTimeout(2000);
    takeScreenshot(`chat-loaded-${cleanNumber}`);

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
    takeScreenshot(`nav-error-${mobile.replace(/[^\d]/g, '')}`);
    throw error;
  }
}

// Send combined message with better error handling
async function sendCombinedMessage(mobile, message = '', mediaUrl = '', caption = '', mediaType = 'auto') {
  try {
    console.log(`📤 Sending combined message to ${mobile}:`, {
      hasMessage: !!message,
      hasMedia: !!mediaUrl,
      hasCaption: !!caption,
      mediaType
    });

    await navigateToChat(mobile);

    const messageSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      '[data-testid="compose-box-input"]'
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
      takeScreenshot(`message-box-not-found-${mobile.replace(/[^\d]/g, '')}`);
      throw new Error('Message input box not found');
    }

    await messageBox.click();
    await globalPage.waitForTimeout(500);

    // Clear existing content
    try {
      await messageBox.selectText();
      await globalPage.keyboard.press('Delete');
    } catch (e) {
      // If selectText fails, try alternative clearing method
      try {
        await messageBox.fill('');
      } catch (fillError) {
        // Try keyboard shortcut
        await globalPage.keyboard.press('Control+A');
        await globalPage.keyboard.press('Delete');
      }
    }
    await globalPage.waitForTimeout(500);

    // Prepare combined content
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

    takeScreenshot(`before-send-${mobile.replace(/[^\d]/g, '')}`);
    
    // Type the message with proper delay
    await messageBox.type(combinedContent, { delay: 50 });
    await globalPage.waitForTimeout(2000);

    // Send the message
    await globalPage.keyboard.press('Enter');
    await globalPage.waitForTimeout(3000);

    takeScreenshot(`after-send-${mobile.replace(/[^\d]/g, '')}`);

    console.log(`✅ Combined message sent to ${mobile}`);
    return {
      success: true,
      mobile,
      message: 'Combined message sent successfully',
      content: { mediaUrl, caption, message, mediaType },
      timestamp: new Date().toISOString()
    };

  } catch (error) {
    console.error(`❌ Failed to send combined message to ${mobile}:`, error.message);
    takeScreenshot(`send-error-${mobile.replace(/[^\d]/g, '')}`);
    return { 
      success: false, 
      mobile, 
      error: error.message,
      timestamp: new Date().toISOString()
    };
  }
}

// Cleanup function
async function cleanup() {
  try {
    if (globalBrowser) {
      takeScreenshot('before-cleanup');
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
        message: 'WhatsApp session already active',
        loggedIn: true
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

    // Validate input
    if (!whatsapp || !Array.isArray(whatsapp) || whatsapp.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected array of WhatsApp messages in "whatsapp" field.'
      });
    }

    // Check session
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

    // Check if logged in
    if (!isLoggedIn) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not logged in. Please scan QR code first.',
        debug: {
          browserActive: !!globalBrowser,
          pageActive: !!globalPage,
          isLoggedIn: isLoggedIn
        }
      });
    }

    console.log(`📤 Processing ${whatsapp.length} messages...`);

    const results = [];

    for (let i = 0; i < whatsapp.length; i++) {
      const item = whatsapp[i];
      const { id, mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = item;
      const mediaUrl = filePath || link;

      // Validate individual message
      if (!mobile) {
        results.push({
          id,
          success: false,
          mobile: mobile || 'unknown',
          error: 'Mobile number is required'
        });
        continue;
      }

      if (!message && !mediaUrl) {
        results.push({
          id,
          success: false,
          mobile,
          error: 'Either message or media (filePath/link) is required'
        });
        continue;
      }

      console.log(`📤 Processing message ${i + 1}/${whatsapp.length} for ${mobile}:`, {
        hasMessage: !!message,
        hasMedia: !!mediaUrl,
        caption: caption || 'none',
        mediaType
      });

      const result = await sendCombinedMessage(mobile, message, mediaUrl, caption, mediaType);
      results.push({
        id,
        ...result
      });

      // Wait between messages (except for the last one)
      if (i < whatsapp.length - 1) {
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
      results,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Bulk messaging error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/send-message', async (req, res) => {
  try {
    const { mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = req.body;
    const mediaUrl = filePath || link;

    if (!mobile || (!message && !mediaUrl)) {
      return res.status(400).json({
        success: false,
        error: 'Mobile number and either message or media (filePath/link) are required'
      });
    }

    if (!globalPage || !globalBrowser) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    if (!isLoggedIn) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not logged in. Please scan QR code first.'
      });
    }

    console.log(`📤 Processing single message for ${mobile}`);

    const result = await sendCombinedMessage(mobile, message, mediaUrl, caption, mediaType);

    res.json({
      success: result.success,
      message: result.message,
      error: result.error,
      mobile: result.mobile,
      content: result.content,
      timestamp: result.timestamp
    });

  } catch (error) {
    console.error('❌ Send message error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

app.post('/refresh-qr', async (req, res) => {
  try {
    if (!globalPage) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized'
      });
    }

    if (isLoggedIn) {
      return res.json({
        success: true,
        message: 'Already logged in, no QR refresh needed'
      });
    }

    console.log('🔄 Manual QR refresh requested...');
    takeScreenshot('before-manual-refresh');
    
    await globalPage.reload({ waitUntil: 'domcontentloaded' });
    await globalPage.waitForTimeout(15000);
    await handleCompatibilityWarnings();

    // Extract fresh QR code
    const qrResult = await extractQRCode();

    if (qrResult.success) {
      takeScreenshot('manual-refresh-success');
      res.json({
        success: true,
        message: 'QR code refreshed successfully',
        qrCode: qrResult.qrCode,
        metadata: qrResult.metadata
      });
    } else {
      takeScreenshot('manual-refresh-failed');
      res.status(500).json({
        success: false,
        error: qrResult.error || 'Failed to extract fresh QR code'
      });
    }
  } catch (error) {
    console.error('QR refresh error:', error.message);
    takeScreenshot('manual-refresh-error');
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Screenshot viewing endpoints
app.get('/screenshots', (req, res) => {
  try {
    const screenshotDir = __dirname;
    
    if (!fs.existsSync(screenshotDir)) {
      return res.json({
        success: true,
        screenshots: [],
        count: 0
      });
    }

    const files = fs.readdirSync(screenshotDir)
      .filter(file => file.endsWith('.png'))
      .map(file => {
        const filePath = path.join(screenshotDir, file);
        const stats = fs.statSync(filePath);
        return {
          filename: file,
          url: `/screenshot/${file}`,
          size: stats.size,
          created: stats.birthtime,
          modified: stats.mtime
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({
      success: true,
      screenshots: files,
      count: files.length
    });
  } catch (error) {
    console.error('Error listing screenshots:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to list screenshots'
    });
  }
});

app.get('/screenshot/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Screenshot not found' });
    }

    if (!filename.match(/\.(png|jpg|jpeg)$/i)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Take manual screenshot endpoint
app.post('/take-screenshot', async (req, res) => {
  try {
    const { name = 'manual-screenshot' } = req.body;
    
    if (!globalPage) {
      return res.status(400).json({
        success: false,
        error: 'No active WhatsApp session'
      });
    }

    // Check if page context is valid
    const isPageValid = await globalPage.evaluate(() => true).catch(() => false);
    if (!isPageValid) {
      return res.status(400).json({
        success: false,
        error: 'Page context is not valid'
      });
    }

    try {
      const screenshotPath = path.join(__dirname, `${name}-${Date.now()}.png`);
      await globalPage.screenshot({
        path: screenshotPath,
        fullPage: true,
        timeout: 5000
      });
      
      const filename = path.basename(screenshotPath);
      console.log(`📸 Manual screenshot saved: ${filename}`);
      
      res.json({
        success: true,
        message: 'Screenshot taken successfully',
        filename: filename,
        url: `/screenshot/${filename}`
      });
    } catch (screenshotError) {
      res.status(500).json({
        success: false,
        error: `Failed to take screenshot: ${screenshotError.message}`
      });
    }
  } catch (error) {
    console.error('Manual screenshot error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

app.get('/status', (req, res) => {
  res.json({
    success: true,
    status: {
      browserActive: !!globalBrowser,
      pageActive: !!globalPage,
      loggedIn: isLoggedIn,
      whatsappReady: isWhatsAppReady,
      timestamp: new Date().toISOString()
    }
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    browserActive: !!globalBrowser,
    loggedIn: isLoggedIn
  });
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

app.post('/close', async (req, res) => {
  try {
    await cleanup();
    res.json({
      success: true,
      message: 'WhatsApp session closed successfully'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({
    success: false,
    error: 'Internal server error'
  });
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await cleanup();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 Shutting down gracefully...');
  await cleanup();
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced WhatsApp API Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Initialize WhatsApp: POST http://localhost:${PORT}/initialize`);
  console.log(`📤 Send bulk messages: POST http://localhost:${PORT}/send-messages`);
  console.log(`📤 Send single message: POST http://localhost:${PORT}/send-message`);
  console.log(`🔄 Refresh QR: POST http://localhost:${PORT}/refresh-qr`);
  console.log(`📊 Status: GET http://localhost:${PORT}/status`);
  console.log(`📸 View screenshots: GET http://localhost:${PORT}/screenshots`);
  console.log(`📷 Take screenshot: POST http://localhost:${PORT}/take-screenshot`);
});

console.log('✅ WhatsApp API Server initialized and ready!');

module.exports = app;