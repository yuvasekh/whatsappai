const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
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

// Initialize WhatsApp Web session
async function initializeWhatsApp() {
  try {
    console.log('🚀 Initializing WhatsApp Web session...');

    const env = detectEnvironment();
    console.log(`🔧 Environment: ${env.isCloud ? 'Cloud' : 'Local'}`);

    // Force browser installation in cloud environments
    if (env.isCloud) {
      try {
        console.log('🔍 Installing Playwright browsers...');
        const { execSync } = require('child_process');

        // Try multiple installation approaches
        const installCommands = [
          'npx playwright install-deps chromium',
          'npx playwright install chromium',
          'npm run force-install',
          'npm run install-browser'
        ];

        let installSuccess = false;
        for (const command of installCommands) {
          try {
            console.log(`🔄 Trying: ${command}`);
            execSync(command, {
              stdio: 'inherit',
              timeout: 180000
            });
            console.log(`✅ Success with: ${command}`);
            installSuccess = true;
            break;
          } catch (cmdError) {
            console.log(`❌ Failed: ${command} - ${cmdError.message}`);
            continue;
          }
        }

        if (installSuccess) {
          console.log('✅ Playwright browsers installed successfully');
        } else {
          console.log('⚠️ All installation methods failed, attempting to continue...');
        }
      } catch (installError) {
        console.error('❌ Browser installation failed:', installError.message);
      }
    }

    // Enhanced launch options for cloud environments
    const launchOptions = {
      headless: true,
      args: [
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
        '--no-zygote',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,VizDisplayCompositor',
        '--disable-ipc-flooding-protection',
        '--disable-blink-features=AutomationControlled',
        '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      ]
    };

    // Additional cloud-specific args
    if (env.render) {
      launchOptions.args.push(
        '--single-process',
        '--memory-pressure-off',
        '--max_old_space_size=4096'
      );
    }

    console.log('🚀 Launching browser...');
    globalBrowser = await chromium.launch(launchOptions);

    const context = await globalBrowser.newContext({
      viewport: { width: 1366, height: 768 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      deviceScaleFactor: 1,
      hasTouch: false,
      isMobile: false,
      permissions: ['notifications'],  // Grant notifications permission
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });

    globalPage = await context.newPage();

    // Enhanced stealth measures
    await globalPage.addInitScript(() => {
      // Remove webdriver property
      delete Object.getPrototypeOf(navigator).webdriver;

      // Override plugins
      Object.defineProperty(navigator, 'plugins', {
        get: () => [{
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        }],
      });

      // Override languages
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en'],
      });

      // Override chrome property
      Object.defineProperty(window, 'chrome', {
        get: () => ({
          runtime: {},
          loadTimes: function() {},
          csi: function() {},
          app: {}
        }),
      });
    });

    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', {
      waitUntil: 'networkidle',
      timeout: 60000
    });

    // Enhanced wait strategy for cloud environments
    const stabilizeTime = env.isCloud ? 15000 : 5000;
    console.log(`⏳ Waiting ${stabilizeTime}ms for page to stabilize...`);
    await globalPage.waitForTimeout(stabilizeTime);

    // Handle compatibility warnings
    await handleCompatibilityWarnings();

    // Enhanced login detection
    const loginResult = await checkLoginStatus();

    if (loginResult.loggedIn) {
      isLoggedIn = true;
      console.log('✅ User is already logged in');
      return { loggedIn: true };
    }

    // Enhanced QR code detection
    const qrResult = await extractQRCode();

    if (!qrResult.success) {
      throw new Error(qrResult.error || 'Failed to extract QR code');
    }

    console.log('✅ QR code extracted successfully');
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

// Enhanced compatibility warning handler
async function handleCompatibilityWarnings() {
  try {
    console.log('🔍 Checking for compatibility warnings...');

    // Wait for potential warnings to appear
    await globalPage.waitForTimeout(3000);

    const warnings = await globalPage.evaluate(() => {
      const text = document.body.innerText.toLowerCase();
      return {
        hasWarning: text.includes('chrome') || text.includes('browser') || text.includes('supported'),
        bodyText: document.body.innerText.substring(0, 200)
      };
    });

    if (warnings.hasWarning) {
      console.log('⚠️ Compatibility warning detected:', warnings.bodyText);

      const continueSelectors = [
        'button[data-testid="continue-button"]',
        'button:has-text("Continue")',
        'button:has-text("CONTINUE")',
        'button:has-text("Use WhatsApp Web")',
        'button[type="button"]',
        '[role="button"]:has-text("Continue")',
        'a[href*="web.whatsapp.com"]'
      ];

      for (const selector of continueSelectors) {
        try {
          const button = await globalPage.$(selector);
          if (button && await button.isVisible()) {
            await button.click();
            console.log(`✅ Clicked continue with: ${selector}`);
            await globalPage.waitForTimeout(5000);
            return;
          }
        } catch (e) {
          continue;
        }
      }
    }
  } catch (error) {
    console.log('⚠️ Error handling compatibility warnings:', error.message);
  }
}

// Enhanced login status check
async function checkLoginStatus() {
  try {
    console.log('🔍 Checking login status...');

    // Wait longer in cloud environments
    const env = detectEnvironment();
    const timeout = env.isCloud ? 20000 : 10000;

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
          timeout: 3000,
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

// Enhanced QR code extraction
async function extractQRCode() {
  try {
    console.log('🔍 Extracting QR code...');

    // Wait for QR code to fully load
    const env = detectEnvironment();
    const waitTime = env.isCloud ? 10000 : 5000;
    await globalPage.waitForTimeout(waitTime);

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

    for (const selector of qrSelectors) {
      try {
        const elements = await globalPage.$$(selector);

        for (const element of elements) {
          if (!await element.isVisible()) continue;

          const box = await element.boundingBox();
          if (!box || box.width < 100 || box.height < 100) continue;

          // Validate canvas has content
          const hasContent = await element.evaluate(canvas => {
            if (canvas.tagName.toLowerCase() !== 'canvas') return true;

            try {
              const ctx = canvas.getContext('2d');
              const imageData = ctx.getImageData(0, 0, Math.min(100, canvas.width), Math.min(100, canvas.height));
              return imageData.data.some((pixel, index) => index % 4 !== 3 && pixel > 50);
            } catch (e) {
              return false;
            }
          });

          if (hasContent) {
            qrElement = element;
            usedSelector = selector;
            break;
          }
        }

        if (qrElement) break;

      } catch (e) {
        continue;
      }
    }

    if (!qrElement) {
      // Debug screenshot
      await globalPage.screenshot({
        path: 'debug-no-qr.png',
        fullPage: true
      });

      return {
        success: false,
        error: 'QR code element not found',
        debug: 'Check debug-no-qr.png'
      };
    }

    // Extract QR code
    let qrDataUrl;
    const tagName = await qrElement.evaluate(el => el.tagName.toLowerCase());

    if (tagName === 'canvas') {
      // Wait for canvas to be fully rendered
      await globalPage.waitForTimeout(2000);

      qrDataUrl = await qrElement.evaluate(canvas => {
        try {
          return canvas.toDataURL('image/png');
        } catch (e) {
          return null;
        }
      });
    }

    // Fallback to screenshot
    if (!qrDataUrl || qrDataUrl.length < 1000) {
      const screenshot = await qrElement.screenshot({ type: 'png' });
      qrDataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
    }

    return {
      success: true,
      qrCode: qrDataUrl,
      metadata: {
        selector: usedSelector,
        elementType: tagName,
        timestamp: new Date().toISOString()
      }
    };

  } catch (error) {
    console.error('❌ QR extraction failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

// Enhanced wait for WhatsApp ready
async function waitForWhatsAppReady() {
  try {
    console.log('⏳ Waiting for WhatsApp to be fully loaded...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 45000 : 30000;
    const startTime = Date.now();

    const readySelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="side"]',
      'div[id="side"]',
      '[data-testid="chat-list-search"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    while ((Date.now() - startTime) < maxWaitTime) {
      // Handle any dialogs first
      await handleDialogs();

      for (const selector of readySelectors) {
        try {
          const element = await globalPage.$(selector);
          if (element && await element.isVisible()) {
            console.log(`✅ WhatsApp ready - found: ${selector}`);

            // Additional stability wait
            await globalPage.waitForTimeout(5000);
            return true;
          }
        } catch (e) {
          continue;
        }
      }

      console.log('⏳ Still waiting for WhatsApp interface...');
      await globalPage.waitForTimeout(3000);
    }

    throw new Error(`WhatsApp interface not ready after ${maxWaitTime}ms`);

  } catch (error) {
    console.error('❌ Error waiting for WhatsApp to be ready:', error.message);
    throw error;
  }
}

// Enhanced navigate to chat
async function navigateToChat(mobile) {
  try {
    console.log(`📞 Navigating to chat: ${mobile}`);

    await waitForWhatsAppReady();
    await handleDialogs();

    const env = detectEnvironment();
    const timeout = env.isCloud ? 30000 : 15000;

    // Enhanced search selectors
    const searchSelectors = [
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      'div[role="textbox"][data-tab="3"]',
      '[title="Search or start new chat"]',
      '[placeholder*="Search"]',
      'div[contenteditable="true"]'
    ];

    let searchBox = null;

    for (const selector of searchSelectors) {
      try {
        searchBox = await globalPage.waitForSelector(selector, {
          timeout: 5000,
          state: 'visible'
        });

        if (searchBox && await searchBox.isVisible()) {
          console.log(`✅ Found search box: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!searchBox) {
      await globalPage.screenshot({
        path: 'debug-no-search.png',
        fullPage: true
      });
      throw new Error('Search box not found');
    }

    // Enhanced search interaction
    await searchBox.click();
    await globalPage.waitForTimeout(1000);

    // Clear and enter phone number
    await globalPage.keyboard.selectAll();
    await globalPage.keyboard.press('Delete');
    await globalPage.waitForTimeout(500);

    const formattedMobile = mobile.startsWith('+') ? mobile : `+${mobile}`;
    console.log(`📱 Searching for: ${formattedMobile}`);

    // Type slowly for better reliability
    await searchBox.type(formattedMobile, { delay: 100 });
    await globalPage.waitForTimeout(2000);

    // Press Enter multiple ways
    try {
      await globalPage.keyboard.press('Enter');
    } catch (e) {
      try {
        await searchBox.press('Enter');
      } catch (e2) {
        console.log('⚠️ Could not press Enter');
      }
    }

    // Wait for chat to load
    await globalPage.waitForTimeout(5000);

    // Verify chat is loaded
    const chatVerificationSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]'
    ];

    let chatLoaded = false;
    for (const selector of chatVerificationSelectors) {
      try {
        const element = await globalPage.$(selector);
        if (element && await element.isVisible()) {
          chatLoaded = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!chatLoaded) {
      throw new Error('Chat did not load properly');
    }

    console.log(`✅ Successfully navigated to chat: ${mobile}`);
    return true;

  } catch (error) {
    console.error(`❌ Failed to navigate to chat ${mobile}:`, error.message);
    throw error;
  }
}

// Enhanced dialog handler
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

// Enhanced send text message
async function sendTextMessage(mobile, message) {
  try {
    console.log(`📤 Sending text message to ${mobile}`);

    await handleDialogs();
    await navigateToChat(mobile);
    await handleDialogs();

    const env = detectEnvironment();
    const timeout = env.isCloud ? 20000 : 10000;

    // Enhanced message input selectors
    const messageSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]',
      'div[data-testid="compose-input"]'
    ];

    let messageBox = null;

    for (const selector of messageSelectors) {
      try {
        messageBox = await globalPage.waitForSelector(selector, {
          timeout: 5000,
          state: 'visible'
        });

        if (messageBox && await messageBox.isVisible()) {
          console.log(`✅ Found message box: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!messageBox) {
      await globalPage.screenshot({
        path: 'debug-no-message-box.png',
        fullPage: true
      });
      throw new Error('Message input box not found');
    }

    // Enhanced message sending
    await messageBox.click();
    await globalPage.waitForTimeout(1000);

    // Clear any existing content
    await globalPage.keyboard.selectAll();
    await globalPage.keyboard.press('Delete');
    await globalPage.waitForTimeout(500);

    // Type message with delay for reliability
    await messageBox.type(message, { delay: 50 });
    await globalPage.waitForTimeout(1000);

    // Send message with multiple attempts
    let messageSent = false;
    const sendAttempts = [
      () => globalPage.keyboard.press('Enter'),
      () => messageBox.press('Enter'),
      () => globalPage.keyboard.press('NumpadEnter')
    ];

    for (const attempt of sendAttempts) {
      try {
        await attempt();
        await globalPage.waitForTimeout(2000);

        // Verify message was sent by checking if input is cleared
        const inputValue = await messageBox.evaluate(el => el.textContent || el.value || '');
        if (!inputValue.trim()) {
          messageSent = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!messageSent) {
      // Try clicking send button as fallback
      try {
        const sendButton = await globalPage.$('[data-testid="send"]');
        if (sendButton && await sendButton.isVisible()) {
          await sendButton.click();
          messageSent = true;
        }
      } catch (e) {
        console.log('⚠️ Send button not found');
      }
    }

    if (!messageSent) {
      throw new Error('Message could not be sent');
    }

    console.log(`✅ Text message sent to ${mobile}`);
    await globalPage.waitForTimeout(3000);

    return { success: true, mobile, message: 'Text message sent successfully' };

  } catch (error) {
    console.error(`❌ Failed to send text message to ${mobile}:`, error.message);

    // Take debug screenshot
    try {
      await globalPage.screenshot({
        path: `debug-send-fail-${Date.now()}.png`,
        fullPage: true
      });
    } catch (e) {
      console.log('Could not take debug screenshot');
    }

    return { success: false, mobile, error: error.message };
  }
}

// Send message function (unchanged from your original)
async function sendMessage(mobile, message = '', filePath = '', caption = '', mediaType = 'auto') {
  try {
    const results = [];

    if (message) {
      const textResult = await sendTextMessage(mobile, message);
      results.push(textResult);
    }

    const allSuccessful = results.every(r => r.success);
    const combinedMessage = results.map(r => r.message).join('; ');
    const combinedError = results.filter(r => !r.success).map(r => r.error).join('; ');

    return {
      success: allSuccessful,
      mobile,
      message: allSuccessful ? combinedMessage : combinedError,
      details: results
    };

  } catch (error) {
    console.error(`❌ Failed to send message to ${mobile}:`, error.message);
    return { success: false, mobile, error: error.message };
  }
}

// Cleanup function
async function cleanup() {
  try {
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
      isLoggedIn = false;
      console.log('🧹 Browser cleaned up');
    }
  } catch (error) {
    console.log('⚠️ Error during cleanup:', error.message);
  }
}

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    browserActive: !!globalBrowser,
    loggedIn: isLoggedIn
  });
});

// Initialize WhatsApp session
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
// Static screenshot file endpoint (for debug files)
app.get('/debug-screenshot', (req, res) => {
  const screenshotPath = path.join(__dirname, 'debug-whatsapp-full.png');
  res.sendFile(screenshotPath);
});
// Get QR Code endpoint
app.get('/qr-code', async (req, res) => {
  try {
    if (isLoggedIn) {
      return res.json({
        success: false,
        message: 'Already logged in, no QR code needed'
      });
    }

    if (!globalPage) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    // Try to get fresh QR code using multiple selectors
    try {
      const qrSelectors = [
        'canvas[aria-label*="Scan this QR code to link a device"]',
        '[data-testid="qr-code"]',
        'canvas[aria-label*="QR"]',
        'canvas[aria-label*="Scan"]',
        'img[alt*="QR"]',
        'img[alt*="Scan"]',
        'canvas[role="img"]',
        'div[data-testid="qr-code"] canvas',
        'div[data-testid="qr-code"] img'
      ];

      let qrElement = null;
      let usedSelector = '';

      // Try each selector
      for (const selector of qrSelectors) {
        try {
          qrElement = await globalPage.$(selector);
          if (qrElement) {
            usedSelector = selector;
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (qrElement) {
        let qrDataUrl = null;
        const tagName = await qrElement.evaluate(node => node.tagName);

        if (tagName === 'CANVAS') {
          qrDataUrl = await qrElement.evaluate(canvas => canvas.toDataURL());
        } else if (tagName === 'IMG') {
          qrDataUrl = await qrElement.getAttribute('src');
        }

        if (qrDataUrl && (qrDataUrl.startsWith('data:image') || qrDataUrl.startsWith('http'))) {
          return res.json({
            success: true,
            qrCode: qrDataUrl,
            message: `QR code extracted successfully using selector: ${usedSelector}`
          });
        }
      }

      // If QR code not found, try refreshing the page
      console.log('⚠️ QR code not found, attempting page refresh...');
      try {
        await globalPage.reload({ waitUntil: 'networkidle' });
        await globalPage.waitForTimeout(3000);

        // Try again after refresh
        for (const selector of qrSelectors) {
          try {
            qrElement = await globalPage.$(selector);
            if (qrElement) {
              usedSelector = selector;
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (qrElement) {
          let qrDataUrl = null;
          const tagName = await qrElement.evaluate(node => node.tagName);

          if (tagName === 'CANVAS') {
            qrDataUrl = await qrElement.evaluate(canvas => canvas.toDataURL());
          } else if (tagName === 'IMG') {
            qrDataUrl = await qrElement.getAttribute('src');
          }

          if (qrDataUrl && (qrDataUrl.startsWith('data:image') || qrDataUrl.startsWith('http'))) {
            return res.json({
              success: true,
              qrCode: qrDataUrl,
              message: `QR code extracted after page refresh using selector: ${usedSelector}`
            });
          }
        }
      } catch (refreshError) {
        console.log('❌ Page refresh failed:', refreshError.message);
      }

      return res.status(404).json({
        success: false,
        message: 'QR code not found even after page refresh. It may have expired or you may already be logged in.',
        suggestion: 'Try calling /initialize again to restart the session'
      });

    } catch (error) {
      return res.status(500).json({
        success: false,
        message: 'Failed to extract QR code: ' + error.message
      });
    }

  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Force refresh WhatsApp Web page
app.post('/refresh', async (req, res) => {
  try {
    if (!globalPage) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    console.log('🔄 Force refreshing WhatsApp Web page...');

    // Reload the page
    await globalPage.reload({ waitUntil: 'networkidle' });
    await globalPage.waitForTimeout(5000);

    // Check if we're still on WhatsApp Web
    const currentUrl = await globalPage.url();
    if (!currentUrl.includes('web.whatsapp.com')) {
      return res.status(400).json({
        success: false,
        message: 'Page navigation failed. Current URL: ' + currentUrl
      });
    }

    res.json({
      success: true,
      message: 'WhatsApp Web page refreshed successfully',
      url: currentUrl,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Page refresh failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get page screenshot for debugging
app.get('/screenshot', async (req, res) => {
  try {
    // Check if browser and page are still valid
    if (!globalBrowser || !globalPage) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp session not initialized. Please call /initialize first.',
        browserActive: !!globalBrowser,
        pageActive: !!globalPage
      });
    }

    // Check if page is still connected
    try {
      await globalPage.evaluate(() => window.location.href);
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: 'Browser page is disconnected. Please reinitialize the session.',
        error: error.message
      });
    }

    console.log('📸 Taking page screenshot for debugging...');

    // Take full page screenshot
    const screenshot = await globalPage.screenshot({
      type: 'png',
      fullPage: true,
      encoding: 'base64'
    });

    // Get page info for context
    const pageInfo = await globalPage.evaluate(() => {
      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body.innerText?.substring(0, 500),
        canvasCount: document.querySelectorAll('canvas').length,
        imgCount: document.querySelectorAll('img').length,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        }
      };
    });

    res.json({
      success: true,
      screenshot: `data:image/png;base64,${screenshot}`,
      pageInfo: pageInfo,
      message: 'Screenshot captured successfully',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ Screenshot failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get detailed page analysis for debugging
app.get('/debug-page', async (req, res) => {
  try {
    if (!globalPage) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    console.log('🔍 Running detailed page analysis...');

    // Get comprehensive page analysis
    const analysis = await globalPage.evaluate(() => {
      // Get all canvas elements with detailed info
      const canvases = Array.from(document.querySelectorAll('canvas')).map((canvas, index) => ({
        index,
        ariaLabel: canvas.getAttribute('aria-label'),
        className: canvas.className,
        id: canvas.id,
        role: canvas.getAttribute('role'),
        width: canvas.width,
        height: canvas.height,
        offsetWidth: canvas.offsetWidth,
        offsetHeight: canvas.offsetHeight,
        visible: canvas.offsetParent !== null,
        display: window.getComputedStyle(canvas).display,
        opacity: window.getComputedStyle(canvas).opacity,
        parentElement: canvas.parentElement?.tagName,
        parentClass: canvas.parentElement?.className,
        boundingRect: canvas.getBoundingClientRect()
      }));

      // Get all images
      const images = Array.from(document.querySelectorAll('img')).map((img, index) => ({
        index,
        src: img.src?.substring(0, 100),
        alt: img.alt,
        className: img.className,
        id: img.id,
        width: img.width,
        height: img.height,
        visible: img.offsetParent !== null,
        boundingRect: img.getBoundingClientRect()
      }));

      // Get elements with data-testid
      const testIdElements = Array.from(document.querySelectorAll('[data-testid]')).map(el => ({
        testId: el.getAttribute('data-testid'),
        tagName: el.tagName,
        className: el.className,
        textContent: el.textContent?.substring(0, 100),
        visible: el.offsetParent !== null
      }));

      // Look for QR-related text
      const qrRelatedText = Array.from(document.querySelectorAll('*'))
        .filter(el => el.textContent && (
          el.textContent.toLowerCase().includes('qr') ||
          el.textContent.toLowerCase().includes('scan') ||
          el.textContent.toLowerCase().includes('code') ||
          el.textContent.toLowerCase().includes('whatsapp')
        ))
        .map(el => ({
          tagName: el.tagName,
          textContent: el.textContent?.substring(0, 200),
          className: el.className,
          id: el.id
        }))
        .slice(0, 20); // Limit results

      return {
        url: window.location.href,
        title: document.title,
        bodyText: document.body.innerText?.substring(0, 1000),
        canvases,
        images,
        testIdElements,
        qrRelatedText,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight
        },
        userAgent: navigator.userAgent,
        timestamp: new Date().toISOString()
      };
    });

    // Take a screenshot too
    const screenshot = await globalPage.screenshot({
      type: 'png',
      fullPage: true,
      encoding: 'base64'
    });

    res.json({
      success: true,
      analysis,
      screenshot: `data:image/png;base64,${screenshot}`,
      message: 'Page analysis completed successfully'
    });

  } catch (error) {
    console.error('❌ Page analysis failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Get WhatsApp list
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

// Send single message (text only)
app.post('/send-message', async (req, res) => {
  try {
    const { mobile, message } = req.body;

    if (!mobile || !message) {
      return res.status(400).json({
        success: false,
        error: 'Mobile number and message are required'
      });
    }

    if (!isLoggedIn || !globalPage) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    const result = await sendTextMessage(mobile, message);
    res.json(result);

  } catch (error) {
    console.error('❌ Send message error:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});


app.get('/api/screenshots', (req, res) => {
  const dirPath = path.join(__dirname, 'public');

  fs.readdir(dirPath, (err, files) => {
    if (err) {
      return res.status(500).json({ error: 'Unable to read screenshot directory.' });
    }

    const imageFiles = files.filter(file =>
      file.endsWith('.png') || file.endsWith('.jpg') || file.endsWith('.jpeg')
    );

    const baseUrl = `${req.protocol}://${req.get('host')}/public`;

    const screenshots = imageFiles.map(file => ({
      filename: file,
      url: `${baseUrl}/${file}`
    }));

    res.json({ count: screenshots.length, screenshots });
  });
});

// Send bulk messages (enhanced to support media)
app.post('/send-messages', async (req, res) => {
  try {
    const { whatsapp } = req.body;

    if (!whatsapp || !Array.isArray(whatsapp) || whatsapp.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected array of WhatsApp messages.'
      });
    }

    // Check if WhatsApp session is active
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

    // Take initial screenshot for debugging
    try {
      await globalPage.screenshot({
        path: `debug-send-messages-start-${Date.now()}.png`,
        fullPage: true
      });
      console.log('📸 Initial screenshot taken for debugging');
    } catch (e) {
      console.log('⚠️ Could not take initial screenshot');
    }

    const results = [];

    for (const item of whatsapp) {
      const { id, mobile, message = '', filePath = '', caption = '', mediaType = 'auto' } = item;

      if (!mobile || (!message && !filePath)) {
        results.push({
          id,
          success: false,
          mobile,
          error: 'Mobile number and either message or filePath are required'
        });
        continue;
      }

      const result = await sendMessage(mobile, message, filePath, caption, mediaType);
      results.push({
        id,
        ...result
      });

      // Add delay between messages
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

// Debug screenshot endpoint for send-messages issues
app.get('/debug-send-messages', async (req, res) => {
  try {
    if (!globalPage || !globalBrowser) {
      return res.status(400).json({
        success: false,
        message: 'WhatsApp session not initialized',
        debug: {
          browserActive: !!globalBrowser,
          pageActive: !!globalPage,
          isLoggedIn: isLoggedIn
        }
      });
    }

    console.log('📸 Taking debug screenshot for send-messages...');

    // Take screenshot
    const screenshot = await globalPage.screenshot({
      type: 'png',
      fullPage: true,
      encoding: 'base64'
    });

    // Get detailed page analysis
    const pageAnalysis = await globalPage.evaluate(() => {
      // Check for search box
      const searchSelectors = [
        '[data-testid="chat-list-search"]',
        'div[contenteditable="true"][data-tab="3"]',
        'div[role="textbox"][data-tab="3"]',
        '[title="Search or start new chat"]',
        '[placeholder*="Search"]'
      ];

      const searchBoxes = searchSelectors.map(selector => {
        const element = document.querySelector(selector);
        return {
          selector,
          found: !!element,
          visible: element ? element.offsetParent !== null : false,
          text: element ? element.textContent || element.value || '' : '',
          placeholder: element ? element.placeholder || '' : ''
        };
      });

      // Check for message input box
      const messageSelectors = [
        '[data-testid="conversation-compose-box-input"]',
        'div[contenteditable="true"][data-tab="10"]',
        '[role="textbox"][data-tab="10"]',
        'div[contenteditable="true"][data-lexical-editor="true"]'
      ];

      const messageBoxes = messageSelectors.map(selector => {
        const element = document.querySelector(selector);
        return {
          selector,
          found: !!element,
          visible: element ? element.offsetParent !== null : false
        };
      });

      // Check for dialogs
      const dialogSelectors = [
        'button:has-text("Continue")',
        '[role="button"]:has-text("OK")',
        'div[data-testid="modal"]',
        'button[data-testid="continue-button"]'
      ];

      const dialogs = dialogSelectors.map(selector => {
        const element = document.querySelector(selector);
        return {
          selector,
          found: !!element,
          visible: element ? element.offsetParent !== null : false
        };
      });

      return {
        url: window.location.href,
        title: document.title,
        searchBoxes,
        messageBoxes,
        dialogs,
        bodyText: document.body.innerText?.substring(0, 1000),
        timestamp: new Date().toISOString()
      };
    });

    res.json({
      success: true,
      screenshot: `data:image/png;base64,${screenshot}`,
      analysis: pageAnalysis,
      message: 'Debug screenshot and analysis completed'
    });

  } catch (error) {
    console.error('❌ Debug screenshot failed:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Close WhatsApp session
app.post('/close', async (req, res) => {
  try {
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
      isLoggedIn = false;
      console.log('🔒 WhatsApp session closed');
    }

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

// Get session status
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
  if (globalBrowser) {
    await globalBrowser.close();
  }

  // Clean up uploads directory
  if (fs.existsSync('uploads/')) {
    const files = fs.readdirSync('uploads/');
    files.forEach(file => {
      try {
        fs.unlinkSync(path.join('uploads/', file));
      } catch (e) {
        console.error('Error cleaning up file:', e.message);
      }
    });
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
console.log(path.join(__dirname, 'build'));

// Serve static files from the React app
app.use(express.static(path.join(__dirname, 'build')));

// Handle all routing for React app
app.get('', (req, res) => {
  res.sendFile(path.join(__dirname, 'build', 'index.html'));
});
// Start server
app.listen(PORT, () => {
  console.log(`🚀 Enhanced WhatsApp API Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Initialize WhatsApp: POST http://localhost:${PORT}/initialize`);
  console.log(`📤 Send text message: POST http://localhost:${PORT}/send-message`);
  console.log(`📎 Send media message: POST http://localhost:${PORT}/send-media`);
  console.log(`📫 Send bulk messages: POST http://localhost:${PORT}/send-messages`);
});

module.exports = app;