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

    // First check for loading states that need to be handled
    const loadingSelectors = [
      'div:has-text("Loading chats")',
      'div:has-text("Loading...")',
      '[data-testid="startup-progress"]',
      '.progress-container',
      '.loading-screen'
    ];

    // Check if stuck in loading state
    for (const selector of loadingSelectors) {
      try {
        const loadingElement = await globalPage.$(selector);
        if (loadingElement && await loadingElement.isVisible()) {
          console.log(`⏳ Found loading state: ${selector}`);

          // Wait for loading to complete or timeout
          await globalPage.waitForTimeout(10000);

          // Try to force refresh if still loading
          const stillLoading = await globalPage.$(selector);
          if (stillLoading && await stillLoading.isVisible()) {
            console.log('🔄 Still loading, attempting to refresh...');
            await globalPage.reload({ waitUntil: 'networkidle' });
            await globalPage.waitForTimeout(5000);
          }
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

// Monitor QR scan completion and page transition
async function monitorQRScanCompletion() {
  try {
    console.log('🔍 Starting QR scan monitoring...');

    const env = detectEnvironment();
    const maxWaitTime = env.isCloud ? 300000 : 180000; // 5 minutes cloud, 3 minutes local
    const startTime = Date.now();

    const checkInterval = setInterval(async () => {
      try {
        if (!globalPage) {
          clearInterval(checkInterval);
          return;
        }

        // Take periodic screenshots to track progress
        const timestamp = Date.now();
        await globalPage.screenshot({
          path: `qr-monitor-${timestamp}.png`,
          fullPage: true
        });

        // Check if we've transitioned to chat interface
        const loginResult = await checkLoginStatus();

        if (loginResult.loggedIn) {
          console.log('✅ QR scan completed! User is now logged in');
          isLoggedIn = true;
          clearInterval(checkInterval);

          // Take final screenshot
          await globalPage.screenshot({
            path: `qr-scan-success-${timestamp}.png`,
            fullPage: true
          });

          return;
        }

        // Check if QR code has expired or changed
        const currentUrl = await globalPage.url();
        if (!currentUrl.includes('web.whatsapp.com')) {
          console.log('⚠️ Page navigated away from WhatsApp Web');
          clearInterval(checkInterval);
          return;
        }

        // Check for timeout
        if ((Date.now() - startTime) > maxWaitTime) {
          console.log('⏰ QR scan monitoring timeout reached');
          clearInterval(checkInterval);

          // Take timeout screenshot
          await globalPage.screenshot({
            path: `qr-scan-timeout-${timestamp}.png`,
            fullPage: true
          });
          return;
        }

      } catch (error) {
        console.log('⚠️ Error during QR monitoring:', error.message);
      }
    }, 10000); // Check every 10 seconds

  } catch (error) {
    console.error('❌ QR scan monitoring failed:', error.message);
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
            isWhatsAppReady = true; // Set the flag
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

// Enhanced navigate to chat using wa.me URL (works for saved and unsaved numbers)
async function navigateToChat(mobile) {
  try {
    console.log(`📞 Navigating to chat: ${mobile}`);

    if (!isWhatsAppReady) {
      console.log('⏳ WhatsApp not ready yet, waiting...');
      await waitForWhatsAppReady();
    }

    await handleDialogs();

    // Format number properly (remove + and any non-digits)
    const cleanNumber = mobile.replace(/[^\d]/g, '');
    
    // Use wa.me URL for reliable navigation to both saved and unsaved numbers
    const waUrl = `https://web.whatsapp.com/send?phone=${cleanNumber}`;
    
    console.log(`🌐 Directly refreshing page with URL: ${waUrl}`);
    
    // Instead of navigate then refresh, directly refresh with the URL
    // This works better for unsaved numbers
    await globalPage.goto(waUrl, {
      waitUntil: 'networkidle',
      timeout: 30000
    });

    // Wait for page load
    await globalPage.waitForTimeout(3000);
    
    // Handle any dialogs that might appear
    await handleDialogs();

    // Wait for chat interface to load with multiple possible selectors
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
          timeout: 15000,
          state: 'visible'
        });
        
        // Double check the element is actually interactable
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
      // Take debug screenshot
      await globalPage.screenshot({
        path: `debug-chat-not-found-${cleanNumber}-${Date.now()}.png`,
        fullPage: true
      });
      throw new Error('Chat interface not found after navigation');
    }

    // Additional wait to ensure everything is loaded and stable
    await globalPage.waitForTimeout(3000);

    // Try to focus on the chat input to make sure it's ready
    if (workingSelector) {
      try {
        await globalPage.click(workingSelector);
        console.log('🎯 Chat input focused and ready');
      } catch (e) {
        console.log('⚠️ Could not focus chat input, but proceeding...');
      }
    }

    console.log(`✅ Successfully navigated to chat: ${mobile}`);

    // Take screenshot after successful navigation
    try {
      await globalPage.screenshot({
        path: `after-navigation-${mobile.replace(/[^\d]/g, '')}-${Date.now()}.png`,
        fullPage: true
      });
      console.log('📸 Screenshot taken after navigation');
    } catch (e) {
      console.log('⚠️ Could not take post-navigation screenshot');
    }

    return true;

  } catch (error) {
    console.error(`❌ Failed to navigate to chat ${mobile}:`, error.message);

    // Take debug screenshot
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

    // Clear any existing content (using proper Playwright methods)
    await messageBox.selectText();
    await globalPage.keyboard.press('Delete');
    await globalPage.waitForTimeout(500);

    // Type message with delay for reliability
    await messageBox.type(message, { delay: 50 });
    await globalPage.waitForTimeout(2000); // Longer wait after typing

    // Ensure message is fully typed before sending
    const typedContent = await messageBox.evaluate(el => el.textContent || el.innerText || '');
    console.log(`📝 Typed content: "${typedContent.trim()}"`);

    if (!typedContent.trim().includes(message.trim())) {
      console.log('⚠️ Message not fully typed, retrying...');
      await messageBox.selectText();
      await globalPage.keyboard.press('Delete');
      await globalPage.waitForTimeout(500);
      await messageBox.type(message, { delay: 100 });
      await globalPage.waitForTimeout(1000);
    }

    // Send message with multiple attempts
    let messageSent = false;
    const sendAttempts = [
      () => globalPage.keyboard.press('Enter'),
      () => messageBox.press('Enter'),
      () => globalPage.keyboard.press('NumpadEnter')
    ];

    for (const attempt of sendAttempts) {
      try {
        console.log('📤 Attempting to send message...');
        await attempt();
        await globalPage.waitForTimeout(3000); // Longer wait to see if message appears

        // Better verification: check for sent message indicators
        const verificationChecks = [
          // Check if input is cleared
          async () => {
            const inputValue = await messageBox.evaluate(el => el.textContent || el.value || '');
            return !inputValue.trim();
          },
          // Check for message bubbles
          async () => {
            const messageBubbles = await globalPage.$$('[data-testid="msg-container"]');
            return messageBubbles.length > 0;
          },
          // Check for sent indicators
          async () => {
            const sentIndicators = await globalPage.$$('[data-testid="msg-check"], [data-icon="msg-check"]');
            return sentIndicators.length > 0;
          }
        ];

        let verified = false;
        for (const check of verificationChecks) {
          try {
            if (await check()) {
              verified = true;
              break;
            }
          } catch (e) {
            continue;
          }
        }

        if (verified) {
          messageSent = true;
          console.log('✅ Message send verified');
          break;
        } else {
          console.log('⚠️ Message send not verified, trying next method...');
        }
      } catch (e) {
        console.log('❌ Send attempt failed:', e.message);
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

// Send combined message (image + caption + text together)
async function sendCombinedMessage(mobile, message = '', mediaUrl = '', caption = '') {
  try {
    console.log(`📤 Sending combined message to ${mobile}:`, {
      hasMessage: !!message,
      hasMedia: !!mediaUrl,
      hasCaption: !!caption
    });

    // Navigate to chat once
    await navigateToChat(mobile);
    await handleDialogs();

    // Find message input box
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

    // Click and clear message box
    await messageBox.click();
    await globalPage.waitForTimeout(500);
    await messageBox.selectText();
    await globalPage.keyboard.press('Delete');
    await globalPage.waitForTimeout(500);

    // Combine all content into one message
    let combinedContent = '';

    // Add image URL first
    if (mediaUrl) {
      combinedContent += mediaUrl;
    }

    // Add caption if provided
    if (caption) {
      combinedContent += combinedContent ? `\n${caption}` : caption;
    }

    // Add message if provided
    if (message) {
      combinedContent += combinedContent ? `\n${message}` : message;
    }

    if (!combinedContent) {
      throw new Error('No content to send');
    }

    console.log(`📝 Combined content to send:\n${combinedContent}`);

    // Take screenshot before typing
    try {
      await globalPage.screenshot({
        path: `before-typing-${mobile.replace(/[^\d]/g, '')}-${Date.now()}.png`,
        fullPage: true
      });
      console.log('📸 Screenshot taken before typing');
    } catch (e) {
      console.log('⚠️ Could not take pre-typing screenshot');
    }

    // Type the combined content
    await messageBox.type(combinedContent, { delay: 50 });
    await globalPage.waitForTimeout(2000);

    // Take screenshot after typing
    try {
      await globalPage.screenshot({
        path: `after-typing-${mobile.replace(/[^\d]/g, '')}-${Date.now()}.png`,
        fullPage: true
      });
      console.log('📸 Screenshot taken after typing');
    } catch (e) {
      console.log('⚠️ Could not take post-typing screenshot');
    }

    // Send the message
    await globalPage.keyboard.press('Enter');
    await globalPage.waitForTimeout(3000);

    // Take screenshot after sending
    try {
      await globalPage.screenshot({
        path: `after-sending-${mobile.replace(/[^\d]/g, '')}-${Date.now()}.png`,
        fullPage: true
      });
      console.log('📸 Screenshot taken after sending');
    } catch (e) {
      console.log('⚠️ Could not take post-sending screenshot');
    }

    console.log(`✅ Combined message sent to ${mobile}`);
    return {
      success: true,
      mobile,
      message: 'Combined message (image + caption + text) sent successfully',
      content: { mediaUrl, caption, message }
    };

  } catch (error) {
    console.error(`❌ Failed to send combined message to ${mobile}:`, error.message);

    // Take debug screenshot
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

// Cleanup function
async function cleanup() {
  try {
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
      isLoggedIn = false;
      isWhatsAppReady = false; // Reset the ready flag
      console.log('🧹 Browser cleaned up');
    }
  } catch (error) {
    console.log('⚠️ Error during cleanup:', error.message);
  }
}
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
      const { id, mobile, message = '', filePath = '', link = '', caption = '', mediaType = 'auto' } = item;

      // Use link if filePath is not provided (your payload format)
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
// Static screenshot file endpoint (for debug files)
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    browserActive: !!globalBrowser,
    loggedIn: isLoggedIn
  });
});
app.get('/debug-screenshot', (req, res) => {
  const screenshotPath = path.join(__dirname, 'debug-whatsapp-full.png');
  res.sendFile(screenshotPath);
});

// Serve debug files from server directory
app.get('/debug-files/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(__dirname, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }

    // Security check - only allow image files
    if (!filename.match(/\.(png|jpg|jpeg)$/i)) {
      return res.status(400).json({ error: 'Invalid file type' });
    }

    res.sendFile(filePath);
  } catch (error) {
    res.status(500).json({ error: error.message });
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

// Send single message (text only
// List all debug screenshots and files
app.get('/api/screenshots', (req, res) => {
  try {
    const serverDir = __dirname;
    const publicDir = path.join(__dirname, 'public');

    // Read files from both server root and public directory
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
    const publicFiles = readDirectory(publicDir);

    const baseUrl = `${req.protocol}://${req.get('host')}`;

    const screenshots = [
      ...serverFiles.map(file => ({
        filename: file,
        location: 'server',
        url: `${baseUrl}/debug-files/${file}`,
        size: fs.existsSync(path.join(serverDir, file)) ? fs.statSync(path.join(serverDir, file)).size : 0,
        modified: fs.existsSync(path.join(serverDir, file)) ? fs.statSync(path.join(serverDir, file)).mtime : null
      })),
      ...publicFiles.map(file => ({
        filename: file,
        location: 'public',
        url: `${baseUrl}/public/${file}`,
        size: fs.existsSync(path.join(publicDir, file)) ? fs.statSync(path.join(publicDir, file)).size : 0,
        modified: fs.existsSync(path.join(publicDir, file)) ? fs.statSync(path.join(publicDir, file)).mtime : null
      }))
    ];

    // Sort by modification time (newest first)
    screenshots.sort((a, b) => new Date(b.modified) - new Date(a.modified));

    res.json({
      success: true,
      count: screenshots.length,
      screenshots,
      directories: {
        server: serverDir,
        public: publicDir
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
// Send bulk messages (enhanced to support media)

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