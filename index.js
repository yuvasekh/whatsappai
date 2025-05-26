const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const axios = require('axios');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads/';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 100 * 1024 * 1024 // 100MB limit
  }
});

// Middleware
app.use(express.json());
app.use(cors());

// Global browser instance
let globalBrowser = null;
let globalPage = null;
let isLoggedIn = false;

// Initialize WhatsApp Web session
async function initializeWhatsApp() {
  try {
    console.log('🚀 Initializing WhatsApp Web session...');

    // Detect cloud environment vs local development
    const isCloudEnvironment = process.env.NODE_ENV === 'production' ||
                               process.env.RENDER ||
                               process.env.RAILWAY ||
                               process.env.VERCEL ||
                               process.env.HEROKU;

    console.log(`🔧 Environment: ${isCloudEnvironment ? 'Cloud (headless)' : 'Local (visible browser)'}`);

    // Ensure browsers are installed in cloud environment
    if (isCloudEnvironment) {
      try {
        console.log('🔍 Checking Playwright browser installation...');
        const { execSync } = require('child_process');

        // Try to install browsers if not available
        try {
          execSync('npx playwright install --dry-run', { stdio: 'pipe' });
          console.log('✅ Playwright browsers are already installed');
        } catch (error) {
          console.log('⚠️ Installing Playwright browsers...');
          execSync('npx playwright install', {
            stdio: 'inherit',
            timeout: 300000 // 5 minutes timeout
          });
          console.log('✅ Playwright browsers installed successfully');
        }
      } catch (installError) {
        console.error('❌ Failed to install Playwright browsers:', installError.message);
        throw new Error('Browser installation failed: ' + installError.message);
      }
    }

    // Try to launch browser with fallback options
    const baseArgs = [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--disable-features=VizDisplayCompositor'
    ];

    // Add cloud-specific args
    if (isCloudEnvironment) {
      baseArgs.push(
        '--no-zygote',
        '--single-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding'
      );
    }

    const launchOptions = {
      headless: isCloudEnvironment,
      args: baseArgs
    };

    console.log('🚀 Attempting to launch browser with options:', JSON.stringify(launchOptions, null, 2));

    try {
      globalBrowser = await chromium.launch(launchOptions);
      console.log('✅ Chromium browser launched successfully');
    } catch (launchError) {
      console.error('❌ Failed to launch Chromium:', launchError.message);

      if (isCloudEnvironment) {
        console.log('🔄 Trying alternative approaches...');

        // Try 1: Force reinstall specific version
        try {
          const { execSync } = require('child_process');
          console.log('📦 Force reinstalling Playwright browsers...');
          execSync('npx playwright install chromium --force', { stdio: 'inherit', timeout: 180000 });

          globalBrowser = await chromium.launch(launchOptions);
          console.log('✅ Browser launched after force reinstall');
        } catch (reinstallError) {
          console.error('❌ Force reinstall failed:', reinstallError.message);

          // Try 2: Use different launch options
          try {
            console.log('🔄 Trying with minimal launch options...');
            const minimalOptions = {
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox']
            };

            globalBrowser = await chromium.launch(minimalOptions);
            console.log('✅ Browser launched with minimal options');
          } catch (minimalError) {
            throw new Error(`All browser launch attempts failed. Original: ${launchError.message}. Reinstall: ${reinstallError.message}. Minimal: ${minimalError.message}`);
          }
        }
      } else {
        throw launchError;
      }
    }

    const context = await globalBrowser.newContext({
      viewport: { width: 1280, height: 720 }
    });

    globalPage = await context.newPage();

    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', { waitUntil: 'networkidle' });

    // Wait to detect either login or QR code

    // Try wait for login success first (search box)
    const loginTimeout = 10000;
    const searchSelectors = [
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[title="Search or start new chat"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    for (const selector of searchSelectors) {
      try {
        const el = await globalPage.waitForSelector(selector, { timeout: loginTimeout });
        if (el) {
          console.log(`✅ Login successful! Found search box with selector: ${selector}`);
          isLoggedIn = true;
          return { loggedIn: true };
        }
      } catch (e) {
        // ignore, try next selector
      }
    }

    // If login not detected, look for QR code with multiple selectors
    console.log('🔍 Looking for QR code...');

    // Updated QR code selectors for current WhatsApp Web
    const qrSelectors = [
      '[data-testid="qr-code"]',
      'canvas[aria-label*="QR"]',
      'canvas[aria-label*="Scan"]',
      'img[alt*="QR"]',
      'img[alt*="Scan"]',
      'canvas[role="img"]',
      'div[data-testid="qr-code"] canvas',
      'div[data-testid="qr-code"] img',
      '.qr-code canvas',
      '.qr-code img'
    ];

    let qrElement = null;
    let usedSelector = '';

    // Try each selector
    for (const selector of qrSelectors) {
      try {
        console.log(`🔍 Trying QR selector: ${selector}`);
        qrElement = await globalPage.waitForSelector(selector, { timeout: 5000 });
        if (qrElement) {
          usedSelector = selector;
          console.log(`✅ Found QR code with selector: ${selector}`);
          break;
        }
      } catch (e) {
        console.log(`❌ Selector ${selector} failed: ${e.message}`);
        continue;
      }
    }

    if (!qrElement) {
      // Take a screenshot for debugging
      try {
        const screenshot = await globalPage.screenshot({ encoding: 'base64' });
        console.log('📸 Page screenshot taken for debugging');
        // You could save this screenshot or return it for debugging
      } catch (screenshotError) {
        console.log('❌ Could not take screenshot:', screenshotError.message);
      }

      throw new Error('QR code not found with any selector. Page may not have loaded properly or QR code may have expired.');
    }

    try {
      let qrDataUrl = null;
      const tagName = await qrElement.evaluate(node => node.tagName);
      console.log(`📋 QR element tag: ${tagName}`);

      if (tagName === 'CANVAS') {
        qrDataUrl = await qrElement.evaluate(canvas => canvas.toDataURL());
      } else if (tagName === 'IMG') {
        qrDataUrl = await qrElement.getAttribute('src');
      } else {
        // Try to find canvas or img inside the element
        const innerCanvas = await qrElement.$('canvas');
        const innerImg = await qrElement.$('img');

        if (innerCanvas) {
          qrDataUrl = await innerCanvas.evaluate(canvas => canvas.toDataURL());
        } else if (innerImg) {
          qrDataUrl = await innerImg.getAttribute('src');
        }
      }

      if (!qrDataUrl || qrDataUrl === 'data:,') {
        throw new Error('QR code data is empty or invalid');
      }

      console.log('✅ QR code captured successfully');
      console.log(`📊 QR data length: ${qrDataUrl.length} characters`);

      return { loggedIn: false, qrCode: qrDataUrl };

    } catch (extractError) {
      throw new Error('Failed to extract QR code data: ' + extractError.message);
    }

  } catch (error) {
    console.error('❌ Failed to initialize WhatsApp:', error.message);
    if (globalBrowser) {
      await globalBrowser.close();
      globalBrowser = null;
      globalPage = null;
    }
    throw error;
  }
}



// Navigate to chat
async function navigateToChat(mobile) {
  try {
    console.log(`📞 Navigating to chat: ${mobile}`);

    // Search selectors
    const searchSelectors = [
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[title="Search or start new chat"]',
      'div[role="textbox"][data-tab="3"]'
    ];

    // Find and click search box
    let searchBox = null;
    for (const selector of searchSelectors) {
      try {
        searchBox = await globalPage.$(selector);
        if (searchBox) break;
      } catch (e) {
        continue;
      }
    }

    if (!searchBox) {
      throw new Error('Search box not found');
    }

    // Clear search and enter phone number
    await searchBox.click();
    await searchBox.fill('');
    await globalPage.waitForTimeout(500);

    // Format phone number (ensure it starts with +)
    const formattedMobile = mobile.startsWith('+') ? mobile : `+${mobile}`;
    await searchBox.fill(formattedMobile);
    await globalPage.press('div[contenteditable="true"][data-tab="3"]', 'Enter');

    // Wait for chat to load
    await globalPage.waitForTimeout(3000);

    return true;
  } catch (error) {
    console.error(`❌ Failed to navigate to chat ${mobile}:`, error.message);
    throw error;
  }
}

// Send text message
async function sendTextMessage(mobile, message) {
  try {
    await navigateToChat(mobile);

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
        messageBox = await globalPage.waitForSelector(selector, { timeout: 10000 });
        if (messageBox) break;
      } catch (e) {
        continue;
      }
    }

    if (!messageBox) {
      throw new Error('Message input box not found');
    }

    // Send message
    await messageBox.click();
    await messageBox.fill(message);
    await messageBox.press('Enter');

    console.log(`✅ Text message sent to ${mobile}`);
    await globalPage.waitForTimeout(2000);

    return { success: true, mobile, message: 'Text message sent successfully' };

  } catch (error) {
    console.error(`❌ Failed to send text message to ${mobile}:`, error.message);
    return { success: false, mobile, error: error.message };
  }
}

// Send media file (image, video, document, audio)
async function sendMediaFile(mobile, filePath, caption = '', mediaType = 'auto') {
  try {
    await navigateToChat(mobile);

    // Find and click attachment button
    const attachmentSelectors = [
      '[data-testid="clip"]',
      '[data-testid="attach-menu-btn"]',
      'span[data-testid="clip"]',
      'div[title="Attach"]'
    ];

    let attachmentButton = null;
    for (const selector of attachmentSelectors) {
      try {
        attachmentButton = await globalPage.waitForSelector(selector, { timeout: 10000 });
        if (attachmentButton) {
          console.log(`Found attachment button with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!attachmentButton) {
      throw new Error('Attachment button not found');
    }

    await attachmentButton.click();
    await globalPage.waitForTimeout(1000);

    // Determine media type based on file extension if not specified
    const fileExtension = path.extname(filePath).toLowerCase();
    let buttonSelector = '';

    if (mediaType === 'auto') {
      const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      const videoExtensions = ['.mp4', '.avi', '.mkv', '.mov', '.wmv', '.webm'];
      const audioExtensions = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];

      if (imageExtensions.includes(fileExtension) || videoExtensions.includes(fileExtension)) {
        mediaType = 'media';
      } else if (audioExtensions.includes(fileExtension)) {
        mediaType = 'audio';
      } else {
        mediaType = 'document';
      }
    }

    // Select appropriate attachment type
    switch (mediaType) {
      case 'media':
      case 'image':
      case 'video':
        buttonSelector = '[data-testid="attach-image"], input[accept*="image"], input[accept*="video"]';
        break;
      case 'document':
        buttonSelector = '[data-testid="attach-document"], input[accept*="*"]';
        break;
      case 'audio':
        buttonSelector = '[data-testid="attach-audio"], input[accept*="audio"]';
        break;
      default:
        buttonSelector = '[data-testid="attach-document"], input[accept*="*"]';
    }

    // Wait for file input and upload file
    try {
      const fileInput = await globalPage.waitForSelector('input[type="file"]', { timeout: 5000 });
      await fileInput.setInputFiles(filePath);
      console.log(`📎 File uploaded: ${filePath}`);
    } catch (e) {
      // Try alternative method
      const [fileChooser] = await Promise.all([
        globalPage.waitForEvent('filechooser'),
        globalPage.click(`${buttonSelector}, [data-testid="attach-document"]`).catch(() => {
          // If specific button not found, try generic file input
          return globalPage.click('input[type="file"]');
        })
      ]);
      await fileChooser.setFiles(filePath);
      console.log(`📎 File uploaded via file chooser: ${filePath}`);
    }

    await globalPage.waitForTimeout(2000);

    // Add caption if provided
    if (caption) {
      const captionSelectors = [
        '[data-testid="media-caption-input-container"] div[contenteditable="true"]',
        'div[data-testid="caption-input"]',
        'div[contenteditable="true"][data-lexical-editor="true"]'
      ];

      for (const selector of captionSelectors) {
        try {
          const captionBox = await globalPage.$(selector);
          if (captionBox) {
            await captionBox.click();
            await captionBox.fill(caption);
            console.log(`📝 Caption added: ${caption}`);
            break;
          }
        } catch (e) {
          continue;
        }
      }
    }

    // Send the media
    const sendSelectors = [
      '[data-testid="send-button"]',
      'span[data-testid="send"]',
      'button[aria-label="Send"]',
      'div[role="button"][aria-label="Send"]'
    ];

    let sendButton = null;
    for (const selector of sendSelectors) {
      try {
        sendButton = await globalPage.waitForSelector(selector, { timeout: 10000 });
        if (sendButton) break;
      } catch (e) {
        continue;
      }
    }

    if (!sendButton) {
      throw new Error('Send button not found');
    }

    await sendButton.click();
    console.log(`✅ Media file sent to ${mobile}`);

    // Wait for media to be sent
    await globalPage.waitForTimeout(5000);

    return { success: true, mobile, message: `Media file sent successfully: ${path.basename(filePath)}` };

  } catch (error) {
    console.error(`❌ Failed to send media to ${mobile}:`, error.message);
    return { success: false, mobile, error: error.message };
  }
}

// Send message with optional media
async function sendMessage(mobile, message = '', filePath = '', caption = '', mediaType = 'auto') {
  try {
    if (!globalPage || !isLoggedIn) {
      throw new Error('WhatsApp session not initialized');
    }

    const results = [];

    // Send media file if provided
    if (filePath && fs.existsSync(filePath)) {
      const mediaResult = await sendMediaFile(mobile, filePath, caption, mediaType);
      results.push(mediaResult);

      // Add delay between media and text message
      if (message) {
        await globalPage.waitForTimeout(2000);
      }
    }

    // Send text message if provided
    if (message) {
      const textResult = await sendTextMessage(mobile, message);
      results.push(textResult);
    }

    // Return combined results
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

// API Routes

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    whatsappStatus: isLoggedIn ? 'Connected' : 'Disconnected',
    timestamp: new Date().toISOString()
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
      message: 'WhatsApp session initialized successfully. Please scan QR code if prompted.',
      qr: result.qrCode || null,
      loggedIn: result.loggedIn || false
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

      return res.status(404).json({
        success: false,
        message: 'QR code not found. It may have expired or you may already be logged in.'
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

// Send media message with file upload
app.post('/send-media', upload.single('file'), async (req, res) => {
  try {
    const { mobile, message = '', caption = '', mediaType = 'auto' } = req.body;

    if (!mobile) {
      return res.status(400).json({
        success: false,
        error: 'Mobile number is required'
      });
    }

    if (!req.file && !message) {
      return res.status(400).json({
        success: false,
        error: 'Either file or message is required'
      });
    }

    if (!isLoggedIn || !globalPage) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    const result = await sendMessage(mobile, message, req.file?.path, caption, mediaType);

    // Clean up uploaded file
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.json(result);

  } catch (error) {
    console.error('❌ Send media error:', error.message);

    // Clean up uploaded file on error
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
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

    if (!isLoggedIn || !globalPage) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }

    console.log(`📤 Processing ${whatsapp.length} messages...`);

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