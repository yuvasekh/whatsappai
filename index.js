// process.env.PLAYWRIGHT_BROWSERS_PATH = '/ms-playwright';
// console.log(console.log('PLAYWRIGHT_BROWSERS_PATH:', process.env.PLAYWRIGHT_BROWSERS_PATH))
const path = require('path');
const express = require('express');
const { chromium } = require('playwright');
const cors = require('cors');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

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
    
   const isHeadless = process.env.HEADLESS !== 'false';

globalBrowser = await chromium.launch({
  headless: isHeadless,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

    
    
    const context = await globalBrowser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    
    globalPage = await context.newPage();
    
    console.log('🌐 Navigating to WhatsApp Web...');
    await globalPage.goto('https://web.whatsapp.com/', { waitUntil: 'networkidle' });
    
    console.log('📱 Please scan the QR code with your WhatsApp mobile app...');
    
    // Wait for login completion
    const searchSelectors = [
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[title="Search or start new chat"]',
      'div[role="textbox"][data-tab="3"]'
    ];
    
    let searchBox = null;
    for (const selector of searchSelectors) {
      try {
        searchBox = await globalPage.waitForSelector(selector, { timeout: 120000 });
        if (searchBox) {
          console.log(`✅ Login successful! Found search box with selector: ${selector}`);
          isLoggedIn = true;
          break;
        }
      } catch (e) {
        continue;
      }
    }
    
    if (!searchBox) {
      throw new Error('Login failed - could not find search box');
    }
    
    return true;
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

// Send message to a single contact
async function sendSingleMessage(mobile, message, caption = '', link = '') {
  try {
    if (!globalPage || !isLoggedIn) {
      throw new Error('WhatsApp session not initialized');
    }

    console.log(`📞 Sending message to: ${mobile}`);
    
    // Search selectors
    const searchSelectors = [
      '[data-testid="chat-list-search"]',
      'div[contenteditable="true"][data-tab="3"]',
      '[title="Search or start new chat"]',
      'div[role="textbox"][data-tab="3"]'
    ];
    //
    
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
    
    // Prepare complete message
    let completeMessage = message;
    if (caption) {
      completeMessage += `\n\n${caption}`;
    }
    if (link) {
      completeMessage += `\n\n${link}`;
    }
    
    // Send message
    await messageBox.click();
    await messageBox.fill(completeMessage);
    await messageBox.press('Enter');
    
    console.log(`✅ Message sent to ${mobile}`);
    await globalPage.waitForTimeout(2000); // Wait between messages
    
    return { success: true, mobile, message: 'Message sent successfully' };
    
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
    
    await initializeWhatsApp();
    
    res.json({ 
      success: true, 
      message: 'WhatsApp session initialized successfully. Please scan QR code if prompted.' 
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});
app.get('/get-whatsapp-list', async (req, res) => {
  const { userid, secret, method = 'list_whatsapp_l' } = req.query;
console.log(req.query)
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


// Send bulk WhatsApp messages
app.post('/send-messages', async (req, res) => {
  try {
    const { whatsapp } = req.body;
    
    // Validate request body
    if (!whatsapp || !Array.isArray(whatsapp) || whatsapp.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid request body. Expected array of WhatsApp messages.'
      });
    }
    
    // Check if WhatsApp is initialized
    if (!isLoggedIn || !globalPage) {
      return res.status(400).json({
        success: false,
        error: 'WhatsApp session not initialized. Please call /initialize first.'
      });
    }
    
    console.log(`📤 Processing ${whatsapp.length} messages...`);
    
    const results = [];
    
    // Process each message
    for (const item of whatsapp) {
      const { id, mobile, message, caption = '', link = '' } = item;
      
      if (!mobile || !message) {
        results.push({
          id,
          success: false,
          mobile,
          error: 'Mobile number and message are required'
        });
        continue;
      }
      
      const result = await sendSingleMessage(mobile, message, caption, link);
      results.push({
        id,
        ...result
      });
      
      // Add delay between messages to avoid being blocked
      if (whatsapp.indexOf(item) < whatsapp.length - 1) {
        console.log('⏳ Waiting 3 seconds before next message...');
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    }
    
    // Count successful and failed messages
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
  console.log(`🚀 WhatsApp API Server running on port ${PORT}`);
  console.log(`📍 Health check: http://localhost:${PORT}/health`);
  console.log(`🔧 Initialize WhatsApp: POST http://localhost:${PORT}/initialize`);
  console.log(`📤 Send messages: POST http://localhost:${PORT}/send-messages`);
});

module.exports = app;