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

// Global browser instance and state management
let globalBrowser = null;
let globalPage = null;
let globalContext = null;
let isLoggedIn = false;
let isWhatsAppReady = false;
let loginCheckInterval = null;
let playwrightInstalled = false;
let lastQRRefresh = 0;
const QR_REFRESH_INTERVAL = 30000; // 30 seconds

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

// Check if Playwright is already installed
async function checkPlaywrightInstallation() {
  try {
    const { execSync } = require('child_process');
    
    // Try to get Playwright version
    const version = execSync('npx playwright --version', { 
      stdio: 'pipe',
      timeout: 10000 
    }).toString().trim();
    
    console.log(`✅ Playwright already installed: ${version}`);
    playwrightInstalled = true;
    return true;
  } catch (error) {
    console.log('❌ Playwright not found or not properly installed');
    playwrightInstalled = false;
    return false;
  }
}

// Install Playwright with optimized approach
async function installPlaywright() {
  if (playwrightInstalled) {
    console.log('✅ Playwright already installed, skipping installation');
    return true;
  }

  try {
    console.log('🔍 Installing Playwright browsers...');
    const { execSync } = require('child_process');

    const installCommands = [
      'npx playwright install chromium --with-deps',
      'npx playwright install chromium',
      'npx playwright install-deps'
    ];

    for (const command of installCommands) {
      try {
        console.log(`🔄 Executing: ${command}`);
        execSync(command, {
          stdio: 'inherit',
          timeout: 300000 // 5 minutes timeout
        });
        console.log(`✅ Success: ${command}`);
        playwrightInstalled = true;
        return true;
      } catch (cmdError) {
        console.log(`❌ Failed: ${command} - ${cmdError.message}`);
        continue;
      }
    }

    console.log('⚠️ All installation methods failed, attempting to continue...');
    return false;
  } catch (installError) {
    console.error('❌ Browser installation failed:', installError.message);
    return false;
  }
}

// Optimized browser launch options for Render
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
    '--disable-features=TranslateUI,VizDisplayCompositor',
    '--disable-blink-features=AutomationControlled',
    '--disable-web-security',
    '--disable-features=VizDisplayCompositor',
    '--memory-pressure-off',
    '--disable-features=site-per-process'
  ];

  const launchOptions = {
    headless: true,
    args: baseArgs,
    timeout: 60000
  };

  // Render-specific optimizations
  if (env.render || env.isCloud) {
    launchOptions.args.push(
      '--single-process',
      '--max_old_space_size=4096',
      '--disable-features=VizDisplayCompositor',
      '--run-all-compositor-stages-before-draw',
      '--disable-new-content-rendering-timeout'
    );
  }

  return launchOptions;
}

// Enhanced context options
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
    colorScheme: 'light',
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

// Check if browser is already logged in
async function checkExistingLogin() {
  if (!globalPage) return false;
  
  try {
    console.log('🔍 Checking existing login status...');
    
    const loginSelectors = [
      '[data-testid="chat-list"]',
      '[data-testid="side"]',
      '#side',
      '[data-testid="chat-list-search"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    for (const selector of loginSelectors) {
      try {
        const element = await globalPage.$(selector);
        if (element && await element.isVisible()) {
          console.log(`✅ Already logged in - found: ${selector}`);
          isLoggedIn = true;
          isWhatsAppReady = true;
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    
    return false;
  } catch (error) {
    console.log('⚠️ Error checking existing login:', error.message);
    return false;
  }
}

// Enhanced stealth setup
async function setupStealth(page) {
  await page.addInitScript(() => {
    // Remove webdriver property
    delete Object.getPrototypeOf(navigator).webdriver;
    delete navigator.__proto__.webdriver;
    delete navigator.webdriver;

    // Override plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [
        {
          0: { type: "application/x-google-chrome-pdf", suffixes: "pdf", description: "Portable Document Format" },
          description: "Portable Document Format",
          filename: "internal-pdf-viewer",
          length: 1,
          name: "Chrome PDF Plugin"
        }
      ]
    });

    // Override languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en']
    });

    // Add chrome object
    if (!window.chrome) {
      window.chrome = { runtime: {}, loadTimes: function() {}, csi: function() {}, app: {} };
    }

    // Override permissions
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) => (
      parameters.name === 'notifications' ?
        Promise.resolve({ state: Notification.permission }) :
        originalQuery(parameters)
    );
  });
}

// Optimized QR code extraction
async function extractQRCode() {
  try {
    console.log('🔍 Extracting QR code...');

    // Wait for QR code container
    await globalPage.waitForTimeout(5000);

    const qrSelectors = [
      'canvas[aria-label*="QR"]',
      'canvas[aria-label*="Scan"]',
      '[data-testid="qr-code"] canvas',
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

          // Validate canvas has QR content
          const hasQRContent = await element.evaluate(canvas => {
            if (canvas.tagName.toLowerCase() !== 'canvas') return false;
            
            try {
              const ctx = canvas.getContext('2d');
              const imageData = ctx.getImageData(0, 0, Math.min(100, canvas.width), Math.min(100, canvas.height));
              // Check for QR-like pattern (black and white pixels)
              let blackPixels = 0, whitePixels = 0;
              
              for (let i = 0; i < imageData.data.length; i += 4) {
                const r = imageData.data[i];
                const g = imageData.data[i + 1];
                const b = imageData.data[i + 2];
                const brightness = (r + g + b) / 3;
                
                if (brightness < 128) blackPixels++;
                else whitePixels++;
              }
              
              // QR codes should have both black and white pixels
              return blackPixels > 100 && whitePixels > 100;
            } catch (e) {
              return false;
            }
          });

          if (hasQRContent) {
            qrElement = element;
            usedSelector = selector;
            console.log(`✅ Found valid QR canvas: ${selector}`);
            break;
          }
        }

        if (qrElement) break;
      } catch (e) {
        continue;
      }
    }

    if (!qrElement) {
      return { success: false, error: 'QR code element not found' };
    }

    // Extract QR code with retry
    let qrDataUrl;
    const maxRetries = 3;
    
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await globalPage.waitForTimeout(2000);
        
        qrDataUrl = await qrElement.evaluate(canvas => {
          return canvas.toDataURL('image/png');
        });

        if (qrDataUrl && qrDataUrl.length > 1000) {
          break;
        }
        
        console.log(`⚠️ QR extraction attempt ${attempt} - data too small, retrying...`);
      } catch (e) {
        console.log(`❌ QR extraction attempt ${attempt} failed:`, e.message);
      }
    }

    // Fallback to screenshot
    if (!qrDataUrl || qrDataUrl.length < 1000) {
      console.log('🔄 Using screenshot fallback');
      const screenshot = await qrElement.screenshot({ type: 'png' });
      qrDataUrl = `data:image/png;base64,${screenshot.toString('base64')}`;
    }

    if (!qrDataUrl || qrDataUrl.length < 1000) {
      return { success: false, error: 'Failed to extract valid QR code' };
    }

    console.log(`✅ QR code extracted successfully (${qrDataUrl.length} chars)`);
    lastQRRefresh = Date.now();

    return {
      success: true,
      qrCode: qrDataUrl,
      metadata: {
        selector: usedSelector,
        timestamp: new Date().toISOString(),
        dataSize: qrDataUrl.length
      }
    };

  } catch (error) {
    console.error('❌ QR extraction failed:', error.message);
    return { success: false, error: error.message };
  }
}

// Auto-refresh QR code if needed
async function refreshQRIfNeeded() {
  try {
    const now = Date.now();
    if (now - lastQRRefresh > QR_REFRESH_INTERVAL) {
      console.log('🔄 QR code refresh needed...');
      await globalPage.reload({ waitUntil: 'domcontentloaded' });
      await globalPage.waitForTimeout(5000);
      lastQRRefresh = now;
      return true;
    }
    return false;
  } catch (error) {
    console.log('⚠️ Error refreshing QR:', error.message);
    return false;
  }
}

// Enhanced login monitoring
function startLoginMonitoring() {
  if (loginCheckInterval) {
    clearInterval(loginCheckInterval);
  }

  loginCheckInterval = setInterval(async () => {
    try {
      if (!globalPage || isLoggedIn) {
        clearInterval(loginCheckInterval);
        return;
      }

      const loginStatus = await checkExistingLogin();
      
      if (loginStatus) {
        console.log('✅ Login detected via monitoring');
        isLoggedIn = true;
        isWhatsAppReady = true;
        clearInterval(loginCheckInterval);
      }
    } catch (error) {
      console.log('⚠️ Error in login monitoring:', error.message);
    }
  }, 10000); // Check every 10 seconds
}

// Handle WhatsApp dialogs and popups
async function handleDialogs() {
  try {
    const dialogSelectors = [
      'button[data-testid="continue-button"]',
      'button:has-text("Continue")',
      'button:has-text("OK")',
      'button:has-text("Got it")',
      'button:has-text("Dismiss")',
      '[data-testid="popup-panel-ok-button"]',
      'button[aria-label="Close"]'
    ];

    for (const selector of dialogSelectors) {
      try {
        const element = await globalPage.$(selector);
        if (element && await element.isVisible()) {
          console.log(`📋 Dismissing dialog: ${selector}`);
          await element.click();
          await globalPage.waitForTimeout(1000);
          return true;
        }
      } catch (e) {
        continue;
      }
    }
    return false;
  } catch (error) {
    console.log('⚠️ Error handling dialogs:', error.message);
    return false;
  }
}

// Main initialization function
async function initializeWhatsApp() {
  try {
    console.log('🚀 Initializing WhatsApp Web session...');

    // Check if already initialized and logged in
    if (globalBrowser && globalPage && isLoggedIn) {
      console.log('✅ WhatsApp session already active and logged in');
      return { loggedIn: true, alreadyInitialized: true };
    }

    const env = detectEnvironment();
    console.log(`🔧 Environment: ${env.isCloud ? 'Cloud' : 'Local'}`);

    // Check and install Playwright if needed
    if (env.isCloud) {
      await checkPlaywrightInstallation();
      if (!playwrightInstalled) {
        await installPlaywright();
      }
    }

    // Launch browser if not already launched
    if (!globalBrowser) {
      const launchOptions = getBrowserLaunchOptions(env);
      console.log('🚀 Launching browser...');
      
      globalBrowser = await chromium.launch(launchOptions);
      globalContext = await globalBrowser.newContext(getContextOptions());
      globalPage = await globalContext.newPage();
      
      await setupStealth(globalPage);
    }

    // Check if already on WhatsApp and logged in
    const currentUrl = await globalPage.url();
    if (currentUrl.includes('web.whatsapp.com')) {
      const loginStatus = await checkExistingLogin();
      if (loginStatus) {
        return { loggedIn: true, alreadyInitialized: true };
      }
    }

    // Navigate to WhatsApp Web
    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for page to stabilize
    await globalPage.waitForTimeout(8000);
    await handleDialogs();

    // Check if already logged in after navigation
    const loginStatus = await checkExistingLogin();
    if (loginStatus) {
      return { loggedIn: true };
    }

    // Extract QR code
    const qrResult = await extractQRCode();
    
    if (!qrResult.success) {
      throw new Error(qrResult.error || 'Failed to extract QR code');
    }

    // Start monitoring for login
    startLoginMonitoring();

    console.log('✅ WhatsApp initialization completed');

    return {
      loggedIn: false,
      qrCode: qrResult.qrCode,
      metadata: qrResult.metadata
    };

  } catch (error) {
    console.error('❌ WhatsApp initialization failed:', error.message);
    await cleanup();
    throw error;
  }
}

// Get fresh QR code
async function getFreshQRCode() {
  try {
    if (!globalPage) {
      throw new Error('WhatsApp not initialized');
    }

    if (isLoggedIn) {
      return { success: true, loggedIn: true };
    }

    // Refresh QR if needed
    await refreshQRIfNeeded();
    
    const qrResult = await extractQRCode();
    
    if (qrResult.success) {
      return {
        success: true,
        qrCode: qrResult.qrCode,
        metadata: qrResult.metadata,
        loggedIn: false
      };
    }

    return qrResult;
  } catch (error) {
    console.error('❌ Error getting fresh QR code:', error.message);
    return { success: false, error: error.message };
  }
}

// Send message function (optimized)
async function sendMessage(mobile, message) {
  try {
    if (!isLoggedIn || !isWhatsAppReady) {
      throw new Error('WhatsApp not logged in or ready');
    }

    console.log(`📤 Sending message to ${mobile}`);

    const cleanNumber = mobile.replace(/[^\d]/g, '');
    const waUrl = `https://web.whatsapp.com/send?phone=${cleanNumber}`;
    
    await globalPage.goto(waUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    await globalPage.waitForTimeout(3000);
    await handleDialogs();

    // Find message input
    const messageSelectors = [
      '[data-testid="conversation-compose-box-input"]',
      'div[contenteditable="true"][data-tab="10"]',
      '[role="textbox"][data-tab="10"]',
      'div[contenteditable="true"][data-lexical-editor="true"]'
    ];

    let messageBox = null;
    for (const selector of messageSelectors) {
      try {
        messageBox = await globalPage.waitForSelector(selector, {
          timeout: 15000,
          state: 'visible'
        });
        if (messageBox) break;
      } catch (e) {
        continue;
      }
    }

    if (!messageBox) {
      throw new Error('Message input not found');
    }

    // Type and send message
    await messageBox.click();
    await globalPage.waitForTimeout(500);
    await messageBox.type(message, { delay: 50 });
    await globalPage.waitForTimeout(1000);
    await globalPage.keyboard.press('Enter');
    await globalPage.waitForTimeout(2000);

    console.log(`✅ Message sent to ${mobile}`);
    return { success: true, mobile, message: 'Message sent successfully' };

  } catch (error) {
    console.error(`❌ Failed to send message to ${mobile}:`, error.message);
    return { success: false, mobile, error: error.message };
  }
}

// Cleanup function
async function cleanup() {
  try {
    if (loginCheckInterval) {
      clearInterval(loginCheckInterval);
      loginCheckInterval = null;
    }
    
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
      globalContext = null;
      isLoggedIn = false;
      isWhatsAppReady = false;
      console.log('🧹 Browser cleanup completed');
    }
  } catch (error) {
    console.log('⚠️ Error during cleanup:', error.message);
  }
}

// API Routes

// Initialize WhatsApp
app.post('/initialize', async (req, res) => {
  try {
    const result = await initializeWhatsApp();
    
    res.json({
      success: true,
      message: result.alreadyInitialized ? 
        'WhatsApp session already active' : 
        'WhatsApp session initialized',
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