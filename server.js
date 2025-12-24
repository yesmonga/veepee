const express = require('express');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Configuration - All sensitive data from environment variables
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.veepee.fr/cart",
  cartReservationMinutes: 15,
  checkIntervalMs: 60 * 1000,
  // Veepee auth: format is "userId:secretKey" or just the full auth header value
  userId: process.env.VEEPEE_USER_ID || "",
  secretKey: process.env.VEEPEE_SECRET_KEY || "",
  // Or provide the full pre-computed auth if signature is static
  authHeader: process.env.VEEPEE_AUTH || ""
};

// Store monitored products
const monitoredProducts = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// ============== VEEPEE API FUNCTIONS ==============

function getVPDate() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '');
}

function generateSignature(method, path, date) {
  // If we have a pre-computed auth header, use it
  if (CONFIG.authHeader) {
    return CONFIG.authHeader;
  }
  
  // Otherwise compute HMAC signature
  if (!CONFIG.userId || !CONFIG.secretKey) {
    throw new Error('VEEPEE_USER_ID and VEEPEE_SECRET_KEY are required');
  }
  
  const stringToSign = `${method}\n${path}\n${date}`;
  const signature = crypto
    .createHmac('sha256', CONFIG.secretKey)
    .update(stringToSign)
    .digest('base64');
  
  return `VPMWS ${CONFIG.userId}:${signature}`;
}

function makeRequest(method, path, body = null, customAuth = null) {
  return new Promise((resolve, reject) => {
    const vpDate = getVPDate();
    const postData = body ? JSON.stringify(body) : null;
    
    let authorization;
    if (customAuth) {
      authorization = customAuth;
    } else {
      try {
        authorization = generateSignature(method, path, vpDate);
      } catch (error) {
        reject(error);
        return;
      }
    }

    const headers = {
      'Host': 'www.veepee.fr',
      'Accept': 'application/json',
      'X-VP-Date': vpDate,
      'Authorization': authorization,
      'Brand': 'Apple-iPhone',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'x-vp-version': '6.206.0',
      'User-Agent': 'vp-iphone 6.206.0 sysVer 26.2-iOS',
      'Connection': 'keep-alive',
      'x-vp-device': '1',
      'X-VP-DeviceID': '1'
    };

    if (postData) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const options = {
      hostname: 'www.veepee.fr',
      port: 443,
      path: path,
      method: method,
      headers: headers
    };

    const req = https.request(options, (res) => {
      let chunks = [];
      
      res.on('data', (chunk) => { chunks.push(chunk); });
      res.on('end', () => {
        let buffer = Buffer.concat(chunks);
        
        // Decompress if gzipped
        const encoding = res.headers['content-encoding'];
        if (encoding === 'gzip') {
          try {
            buffer = zlib.gunzipSync(buffer);
          } catch (e) {
            // If gunzip fails, try using raw buffer
          }
        } else if (encoding === 'br') {
          try {
            buffer = zlib.brotliDecompressSync(buffer);
          } catch (e) {
            // If brotli fails, try using raw buffer
          }
        } else if (encoding === 'deflate') {
          try {
            buffer = zlib.inflateSync(buffer);
          } catch (e) {
            // If inflate fails, try using raw buffer
          }
        }
        
        const data = buffer.toString('utf8');
        
        // Check for HTTP-level auth errors
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (${res.statusCode}) - Token expired or invalid`));
          return;
        }
        
        if (res.statusCode >= 400) {
          reject(new Error(`HTTP Error ${res.statusCode}: ${data}`));
          return;
        }
        
        try {
          const response = JSON.parse(data);
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message} - Raw: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    
    if (postData) {
      req.write(postData);
    }
    req.end();
  });
}

// Parse Veepee product URL
function parseVeepeeUrl(url) {
  // Format: https://www.veepee.fr/gr/product/897233/90983689
  const match = url.match(/\/product\/(\d+)\/(\d+)/);
  if (match) {
    return {
      saleId: match[1],
      itemId: match[2]
    };
  }
  return null;
}

// Get product options (sizes and stock)
async function getProductOptions(saleId, itemId) {
  const path = `/api/catalog/v1/sale/${saleId}/item/${itemId}/options`;
  const response = await makeRequest('GET', path);
  
  // Response is an array of size options
  // [{"id":"60416988","name":"S","stockLabel":"","quantity":6,"tooltip":{"title":"S"}}]
  return response;
}

// Get product details
async function getProductDetails(saleId, itemId) {
  // For now, we'll get basic info from the options response
  // The product name comes from the cart response after adding
  const options = await getProductOptions(saleId, itemId);
  
  // Build size mapping
  const sizeMapping = {};
  const stockInfo = {};
  
  options.forEach(opt => {
    sizeMapping[opt.id] = {
      size: opt.name,
      stockLabel: opt.stockLabel
    };
    stockInfo[opt.id] = {
      quantity: opt.quantity,
      inStock: opt.quantity > 0
    };
  });
  
  return {
    productInfo: {
      saleId,
      itemId,
      title: `Produit ${itemId}`, // Will be updated after cart add
      brand: 'Veepee',
      price: '-',
      discount: '-'
    },
    sizeMapping,
    stockInfo
  };
}

// Add to cart
async function addToCart(saleId, productId) {
  const path = '/api/cartproxy/v1/item';
  const body = {
    context: {
      origin: 0,
      sale_id: saleId
    },
    order_to_reopen: {
      order_id: null
    },
    product_id: productId,
    quantity: 1,
    cart_type: "fs"
  };
  
  const response = await makeRequest('POST', path, body);
  
  // Extract product info from response
  if (response && response.last_cart_item) {
    const item = response.last_cart_item;
    return {
      success: true,
      productInfo: {
        title: item.item_name || 'Produit',
        brand: item.campaign_name || 'Veepee',
        price: `${item.unit_amount}€`,
        originalPrice: `${item.unit_MSRP}€`,
        discount: item.retail_discount_percentage || '-',
        size: item.size,
        image: item.image
      },
      expirationDate: response.expiration_date,
      cartTotal: response.subtotal
    };
  }
  
  return { success: false };
}

// ============== DISCORD NOTIFICATIONS ==============

function sendDiscordWebhook(payload) {
  return new Promise((resolve, reject) => {
    if (!CONFIG.discordWebhook) {
      console.log('Discord webhook not configured');
      return resolve(false);
    }
    
    const webhookUrl = new URL(CONFIG.discordWebhook);
    const payloadStr = JSON.stringify(payload);

    const options = {
      hostname: webhookUrl.hostname,
      port: 443,
      path: webhookUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payloadStr)
      }
    };

    const req = https.request(options, (res) => {
      if (res.statusCode === 204 || res.statusCode === 200) {
        resolve(true);
      } else {
        reject(new Error(`Discord error: ${res.statusCode}`));
      }
    });

    req.on('error', reject);
    req.write(payloadStr);
    req.end();
  });
}

function sendDiscordNotification(productInfo, productId, size, quantity, deadlineStr, productUrl) {
  const embed = {
    title: "🚨 ARTICLE AJOUTÉ AU PANIER!",
    color: 0xe91e63, // Veepee pink
    thumbnail: productInfo.image ? { url: productInfo.image } : undefined,
    fields: [
      { name: "👕 Produit", value: `**${productInfo.title}**`, inline: false },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "📦 Stock", value: `${quantity} dispo`, inline: true },
      { name: "💰 Prix", value: `${productInfo.price} ~~${productInfo.originalPrice}~~ (${productInfo.discount})`, inline: false },
      { name: "⏰ CHECKOUT AVANT", value: `**${deadlineStr}**`, inline: false },
      { name: "🔗 Liens", value: `[Voir produit](${productUrl}) | [Aller au panier](${CONFIG.checkoutUrl})`, inline: false }
    ],
    footer: { text: `ID: ${productId}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚨 **ARTICLE AJOUTÉ AU PANIER - CHECKOUT MAINTENANT!**",
    embeds: [embed]
  });
}

function sendStockAlertNotification(productInfo, productId, size, quantity, productUrl) {
  const embed = {
    title: "🚨 STOCK DISPONIBLE!",
    color: 0xe91e63, // Veepee pink
    fields: [
      { name: "👕 Produit", value: `**${productInfo.title}**`, inline: false },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "📦 Quantité", value: `${quantity} dispo`, inline: true },
      { name: "💰 Prix", value: productInfo.price || '-', inline: true },
      { name: "🔗 Lien produit", value: `[Voir sur Veepee](${productUrl})`, inline: true },
      { name: "🛒 Checkout", value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: true }
    ],
    footer: { text: `ID: ${productId}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚨 **NOUVEAU STOCK - AJOUTE VITE AU PANIER!**",
    embeds: [embed]
  });
}

// Track if we already sent a token expired notification
let tokenExpiredNotificationSent = false;

function sendTokenExpiredNotification(errorMessage) {
  if (tokenExpiredNotificationSent) {
    return Promise.resolve(false);
  }
  
  tokenExpiredNotificationSent = true;
  
  const embed = {
    title: "⚠️ TOKEN EXPIRÉ",
    color: 0xf87171,
    description: "Le token Veepee a expiré. Le monitoring est en pause jusqu'à la mise à jour du token.",
    fields: [
      { name: "🔧 Action requise", value: "Mettez à jour le token via l'interface web ou les variables d'environnement", inline: false },
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false }
    ],
    footer: { text: "Veepee Monitor" },
    timestamp: new Date().toISOString()
  };

  console.log('⚠️ Token expired - sending Discord notification');
  
  return sendDiscordWebhook({
    content: "@everyone ⚠️ **TOKEN EXPIRÉ - MISE À JOUR REQUISE!**",
    embeds: [embed]
  });
}

function resetTokenExpiredFlag() {
  tokenExpiredNotificationSent = false;
}

// ============== MONITORING LOGIC ==============

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

async function monitorAllProducts() {
  for (const [key, product] of monitoredProducts) {
    try {
      const options = await getProductOptions(product.saleId, product.itemId);
      
      console.log(`[${getTimestamp()}] Checking ${product.productInfo.title}`);
      
      // Build current stock from options
      const currentStock = {};
      options.forEach(opt => {
        currentStock[opt.id] = {
          quantity: opt.quantity,
          inStock: opt.quantity > 0
        };
      });
      
      for (const [productId, stockData] of Object.entries(currentStock)) {
        const prevStock = product.previousStock[productId];
        const wasOutOfStock = !prevStock || prevStock.quantity === 0;
        const nowInStock = stockData.quantity > 0;
        const sizeInfo = product.sizeMapping[productId];
        const size = sizeInfo?.size || '?';
        
        // Check if this size is being watched and stock became available
        if (product.watchedSizes.has(productId) && wasOutOfStock && nowInStock) {
          if (!product.notified.has(productId)) {
            console.log(`🚨 NEW STOCK: ${size} (${productId}) - ${stockData.quantity} units!`);
            
            // Mark as notified to avoid spam
            product.notified.add(productId);
            
            // Send stock alert notification
            const productUrl = `https://www.veepee.fr/gr/product/${product.saleId}/${product.itemId}`;
            await sendStockAlertNotification(
              product.productInfo,
              productId,
              size,
              stockData.quantity,
              productUrl
            );
            
            console.log(`📢 Discord notification sent!`);
          }
        }
        
        // Reset notification if item goes out of stock (to re-notify when it comes back)
        if (product.notified.has(productId) && !nowInStock) {
          product.notified.delete(productId);
        }
      }
      
      // Update previous stock
      product.previousStock = currentStock;
      
    } catch (error) {
      console.error(`[${getTimestamp()}] Error monitoring ${key}:`, error.message);
      
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('unauthorized') || 
          errorMsg.includes('401') || 
          errorMsg.includes('403') ||
          errorMsg.includes('token') ||
          errorMsg.includes('auth') ||
          errorMsg.includes('expired') ||
          errorMsg.includes('invalid')) {
        await sendTokenExpiredNotification(error.message);
      }
    }
  }
}

function startMonitoring() {
  if (monitoringInterval) {
    console.log('Monitoring already running');
    return;
  }
  
  console.log(`[${getTimestamp()}] 🚀 Starting monitoring (interval: ${CONFIG.checkIntervalMs / 1000}s)`);
  monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
  
  // Run immediately
  monitorAllProducts();
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log(`[${getTimestamp()}] ⏹️ Monitoring stopped`);
  }
}

// ============== API ROUTES ==============

// Get all monitored products
app.get('/api/products', (req, res) => {
  const products = [];
  for (const [key, product] of monitoredProducts) {
    products.push({
      key,
      saleId: product.saleId,
      itemId: product.itemId,
      productInfo: product.productInfo,
      sizeMapping: product.sizeMapping,
      watchedSizes: Array.from(product.watchedSizes),
      currentStock: product.previousStock,
      notified: Array.from(product.notified)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

// Fetch product details
app.post('/api/products/fetch', async (req, res) => {
  try {
    let { saleId, itemId, url } = req.body;
    
    // Parse URL if provided
    if (url) {
      const parsed = parseVeepeeUrl(url);
      if (parsed) {
        saleId = parsed.saleId;
        itemId = parsed.itemId;
      } else {
        return res.status(400).json({ error: 'Invalid Veepee URL format' });
      }
    }
    
    if (!saleId || !itemId) {
      return res.status(400).json({ error: 'Sale ID and Item ID are required' });
    }

    const { productInfo, sizeMapping, stockInfo } = await getProductDetails(saleId, itemId);
    
    res.json({
      saleId,
      itemId,
      productInfo,
      sizes: Object.entries(sizeMapping).map(([productId, info]) => ({
        productId,
        size: info.size,
        stockLabel: info.stockLabel,
        stock: stockInfo[productId]?.quantity || 0
      }))
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Add product to monitoring
app.post('/api/products/add', async (req, res) => {
  try {
    let { saleId, itemId, url, watchedSizes } = req.body;
    
    // Parse URL if provided
    if (url) {
      const parsed = parseVeepeeUrl(url);
      if (parsed) {
        saleId = parsed.saleId;
        itemId = parsed.itemId;
      }
    }
    
    if (!saleId || !itemId || !watchedSizes || !Array.isArray(watchedSizes)) {
      return res.status(400).json({ error: 'Sale ID, Item ID, and watchedSizes array are required' });
    }

    const key = `${saleId}-${itemId}`;
    
    const { productInfo, sizeMapping, stockInfo } = await getProductDetails(saleId, itemId);
    
    // Check if any watched size is already in stock
    const alreadyInStock = [];
    for (const productId of watchedSizes) {
      const stock = stockInfo[productId];
      if (stock && stock.inStock && stock.quantity > 0) {
        const size = sizeMapping[productId]?.size || productId;
        alreadyInStock.push(size);
        
        // Try to add to cart immediately
        try {
          const cartResult = await addToCart(saleId, productId);
          if (cartResult.success) {
            const deadline = new Date(cartResult.expirationDate);
            const deadlineStr = deadline.toLocaleString('fr-FR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit'
            });
            
            const productUrl = `https://www.veepee.fr/gr/product/${saleId}/${itemId}`;
            await sendDiscordNotification(
              cartResult.productInfo,
              productId,
              size,
              stock.quantity,
              deadlineStr,
              productUrl
            );
          }
        } catch (err) {
          console.log(`Could not auto-add ${size} to cart: ${err.message}`);
        }
      }
    }
    
    monitoredProducts.set(key, {
      saleId,
      itemId,
      productInfo,
      sizeMapping,
      watchedSizes: new Set(watchedSizes),
      previousStock: stockInfo,
      notified: new Set(alreadyInStock.length > 0 ? watchedSizes.filter(id => stockInfo[id]?.inStock) : [])
    });

    startMonitoring();

    res.json({ 
      success: true, 
      message: `Now monitoring ${productInfo.title}`,
      watchedSizes: watchedSizes.map(id => sizeMapping[id]?.size || id),
      alreadyInStock
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Remove product from monitoring
app.delete('/api/products/:key', (req, res) => {
  const { key } = req.params;
  
  if (monitoredProducts.has(key)) {
    monitoredProducts.delete(key);
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

// Reset cart tracking for a product
app.post('/api/products/:key/reset', (req, res) => {
  const { key } = req.params;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.notified.clear();
  
  res.json({ success: true, message: 'Notifications reset' });
});

// Update authorization
app.post('/api/config/auth', (req, res) => {
  const { userId, secretKey, authHeader } = req.body;
  
  if (!authHeader && (!userId || !secretKey)) {
    return res.status(400).json({ error: 'Either authHeader or userId+secretKey are required' });
  }
  
  if (authHeader) {
    CONFIG.authHeader = authHeader;
    console.log(`[${getTimestamp()}] Auth header updated via API`);
  } else {
    CONFIG.userId = userId;
    CONFIG.secretKey = secretKey;
    CONFIG.authHeader = ''; // Clear pre-computed auth
    console.log(`[${getTimestamp()}] User credentials updated via API`);
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Auth updated' });
});

// Serve main page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Health check
app.get('/health', (req, res) => {
  const uptime = process.uptime();
  const hours = Math.floor(uptime / 3600);
  const minutes = Math.floor((uptime % 3600) / 60);
  const seconds = Math.floor(uptime % 60);
  
  res.json({
    status: 'alive',
    uptime: `${hours}h ${minutes}m ${seconds}s`,
    uptimeSeconds: uptime,
    monitoredProducts: monitoredProducts.size,
    isMonitoring: !!monitoringInterval,
    hasAuth: !!(CONFIG.authHeader || (CONFIG.userId && CONFIG.secretKey)),
    timestamp: new Date().toISOString()
  });
});

app.get('/ping', (req, res) => {
  res.send('pong');
});

// Test endpoint for checking stock
app.post('/api/test/stock', async (req, res) => {
  try {
    const { saleId, itemId } = req.body;
    
    if (!saleId || !itemId) {
      return res.status(400).json({ error: 'saleId and itemId are required' });
    }
    
    const options = await getProductOptions(saleId, itemId);
    res.json({ success: true, options });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Test endpoint for add to cart
app.post('/api/test/addtocart', async (req, res) => {
  try {
    const { saleId, productId } = req.body;
    
    if (!saleId || !productId) {
      return res.status(400).json({ error: 'saleId and productId are required' });
    }
    
    const result = await addToCart(saleId, productId);
    res.json({ success: result.success, result });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const serverStartTime = new Date();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛒 Veepee Stock Monitor - Web Interface                     ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  if (!CONFIG.authHeader && (!CONFIG.userId || !CONFIG.secretKey)) {
    console.log('⚠️ No VEEPEE auth configured - set VEEPEE_AUTH or VEEPEE_USER_ID + VEEPEE_SECRET_KEY');
  }
});
