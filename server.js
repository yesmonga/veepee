const express = require('express');
const https = require('https');
const crypto = require('crypto');
const zlib = require('zlib');
const { Pool } = require('pg');

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// ============== DATABASE SETUP ==============

let pool = null;
let useDatabase = false;

if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });
  useDatabase = true;
  console.log('✅ Database connection configured');
} else {
  console.log('⚠️ No DATABASE_URL configured - using in-memory storage only');
}

async function initDatabase() {
  if (!pool) return;
  
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS monitored_products (
        key VARCHAR(255) PRIMARY KEY,
        sale_id VARCHAR(100) NOT NULL,
        item_id VARCHAR(100) NOT NULL,
        product_info JSONB,
        size_mapping JSONB,
        watched_sizes JSONB,
        previous_stock JSONB,
        notified JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS product_history (
        key VARCHAR(255) PRIMARY KEY,
        sale_id VARCHAR(100) NOT NULL,
        item_id VARCHAR(100) NOT NULL,
        title VARCHAR(500),
        brand VARCHAR(255),
        size_mapping JSONB,
        added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_monitored TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    await pool.query(`
      CREATE TABLE IF NOT EXISTS cart_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        has_items BOOLEAN DEFAULT FALSE,
        items JSONB DEFAULT '[]',
        expiration_date TIMESTAMP,
        last_check TIMESTAMP,
        last_recover TIMESTAMP,
        recovery_active BOOLEAN DEFAULT FALSE,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    // Initialize cart_state row if not exists
    await pool.query(`
      INSERT INTO cart_state (id, has_items, items, recovery_active)
      VALUES (1, FALSE, '[]', FALSE)
      ON CONFLICT (id) DO NOTHING
    `);
    
    console.log('✅ Database tables initialized');
  } catch (error) {
    console.error('❌ Database initialization error:', error.message);
    useDatabase = false;
  }
}

// ============== DATABASE OPERATIONS ==============

async function saveMonitoredProductToDB(key, product) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO monitored_products (key, sale_id, item_id, product_info, size_mapping, watched_sizes, previous_stock, notified, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET
        product_info = $4,
        size_mapping = $5,
        watched_sizes = $6,
        previous_stock = $7,
        notified = $8,
        updated_at = CURRENT_TIMESTAMP
    `, [
      key,
      product.saleId,
      product.itemId,
      JSON.stringify(product.productInfo),
      JSON.stringify(product.sizeMapping),
      JSON.stringify(Array.from(product.watchedSizes)),
      JSON.stringify(product.previousStock),
      JSON.stringify(Array.from(product.notified))
    ]);
  } catch (error) {
    console.error('Error saving product to DB:', error.message);
  }
}

async function deleteMonitoredProductFromDB(key) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM monitored_products WHERE key = $1', [key]);
  } catch (error) {
    console.error('Error deleting product from DB:', error.message);
  }
}

async function loadMonitoredProductsFromDB() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT * FROM monitored_products');
    for (const row of result.rows) {
      monitoredProducts.set(row.key, {
        saleId: row.sale_id,
        itemId: row.item_id,
        productInfo: row.product_info || {},
        sizeMapping: row.size_mapping || {},
        watchedSizes: new Set(row.watched_sizes || []),
        previousStock: row.previous_stock || {},
        notified: new Set(row.notified || [])
      });
    }
    console.log(`📂 Loaded ${result.rows.length} monitored products from DB`);
  } catch (error) {
    console.error('Error loading products from DB:', error.message);
  }
}

async function saveHistoryToDB(key, item) {
  if (!pool) return;
  try {
    await pool.query(`
      INSERT INTO product_history (key, sale_id, item_id, title, brand, size_mapping, added_at, last_monitored)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (key) DO UPDATE SET
        title = $4,
        brand = $5,
        size_mapping = $6,
        last_monitored = $8
    `, [
      key,
      item.saleId,
      item.itemId,
      item.title,
      item.brand,
      JSON.stringify(item.sizeMapping),
      item.addedAt,
      item.lastMonitored
    ]);
  } catch (error) {
    console.error('Error saving history to DB:', error.message);
  }
}

async function deleteHistoryFromDB(key) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM product_history WHERE key = $1', [key]);
  } catch (error) {
    console.error('Error deleting history from DB:', error.message);
  }
}

async function clearHistoryFromDB() {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM product_history');
  } catch (error) {
    console.error('Error clearing history from DB:', error.message);
  }
}

async function loadHistoryFromDB() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT * FROM product_history ORDER BY last_monitored DESC');
    for (const row of result.rows) {
      productHistory.set(row.key, {
        saleId: row.sale_id,
        itemId: row.item_id,
        title: row.title,
        brand: row.brand,
        sizeMapping: row.size_mapping || {},
        addedAt: row.added_at,
        lastMonitored: row.last_monitored
      });
    }
    console.log(`📂 Loaded ${result.rows.length} history items from DB`);
  } catch (error) {
    console.error('Error loading history from DB:', error.message);
  }
}

async function saveCartStateToDB() {
  if (!pool) return;
  try {
    await pool.query(`
      UPDATE cart_state SET
        has_items = $1,
        items = $2,
        expiration_date = $3,
        last_check = $4,
        last_recover = $5,
        recovery_active = $6,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = 1
    `, [
      cartState.hasItems,
      JSON.stringify(cartState.items),
      cartState.expirationDate,
      cartState.lastCheck,
      cartState.lastRecover,
      cartState.recoveryActive
    ]);
  } catch (error) {
    console.error('Error saving cart state to DB:', error.message);
  }
}

async function loadCartStateFromDB() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT * FROM cart_state WHERE id = 1');
    if (result.rows.length > 0) {
      const row = result.rows[0];
      cartState.hasItems = row.has_items || false;
      cartState.items = row.items || [];
      cartState.expirationDate = row.expiration_date;
      cartState.lastCheck = row.last_check;
      cartState.lastRecover = row.last_recover;
      cartState.recoveryActive = row.recovery_active || false;
      
      // Restart cart recovery if it was active
      if (cartState.recoveryActive && cartState.hasItems) {
        console.log('🔄 Resuming cart recovery from DB state...');
        startCartRecovery();
      }
      
      console.log(`🛒 Loaded cart state from DB (${cartState.items.length} items)`);
    }
  } catch (error) {
    console.error('Error loading cart state from DB:', error.message);
  }
}

// Parse auth from full headers or just the Authorization value
function parseAuthFromEnv(input) {
  if (!input) return "";
  
  // If it contains multiple lines, it's likely full headers
  if (input.includes('\n') && input.toLowerCase().includes('authorization:')) {
    const match = input.match(/authorization:\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }
  }
  
  // Otherwise use as-is
  return input.trim();
}

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
  authHeader: parseAuthFromEnv(process.env.VEEPEE_AUTH)
};

// Store monitored products
const monitoredProducts = new Map();

// Product history (persists across monitoring sessions)
const productHistory = new Map();

// Monitoring interval reference
let monitoringInterval = null;

// Cart recovery interval reference
let cartRecoveryInterval = null;

// Cart recovery config
const CART_RECOVERY_INTERVAL_MS = 13 * 60 * 1000; // 13 minutes

// Add product to history
async function addToHistory(saleId, itemId, productInfo, sizeMapping) {
  const key = `${saleId}-${itemId}`;
  const historyItem = {
    saleId,
    itemId,
    title: productInfo.title || `Produit ${itemId}`,
    brand: productInfo.brand,
    sizeMapping,
    addedAt: new Date().toISOString(),
    lastMonitored: new Date().toISOString()
  };
  productHistory.set(key, historyItem);
  await saveHistoryToDB(key, historyItem);
}

// ============== CART STATE ==============

let cartState = {
  hasItems: false,
  items: [],
  expirationDate: null,
  lastCheck: null,
  lastRecover: null,
  recoveryActive: false
};

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
  
  // Order: method + date + path (discovered from APK decompilation)
  const stringToSign = `${method}\n${date}\n${path}`;
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

// Get cart contents
async function getCart() {
  const path = '/api/cartproxy/orderpiper/cart/v3';
  try {
    const response = await makeRequest('GET', path);
    return response;
  } catch (error) {
    // Empty cart returns no JSON, so we handle this case
    if (error.message.includes('Parse error') || error.message.includes('Unexpected end')) {
      return { empty: true };
    }
    throw error;
  }
}

// Recover/extend cart
async function recoverCart() {
  const path = '/api/cartproxy/orderpiper/cart/v3/recover';
  const body = { dismissedProducts: [] };
  const response = await makeRequest('POST', path, body);
  return response;
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

function sendStockAlertNotification(productInfo, productId, size, quantity, productUrl, cartResult = null) {
  // Determine cart status
  let cartStatus = "❌ Non ajouté";
  let cartColor = 0xe91e63; // Pink for stock alert only
  let title = "🚨 STOCK DISPONIBLE!";
  let content = "@everyone 🚨 **NOUVEAU STOCK - AJOUTE VITE AU PANIER!**";
  
  if (cartResult && cartResult.success) {
    cartStatus = "✅ Ajouté au panier!";
    cartColor = 0x22c55e; // Green for success
    title = "🛒 AJOUTÉ AU PANIER!";
    content = "@everyone 🛒 **ARTICLE AJOUTÉ AU PANIER - CHECKOUT MAINTENANT!**";
  } else if (cartResult && cartResult.error) {
    cartStatus = `❌ Échec: ${cartResult.error.substring(0, 50)}`;
  }
  
  const fields = [
    { name: "👕 Produit", value: `**${productInfo.title}**`, inline: false },
    { name: "📏 Taille", value: `**${size}**`, inline: true },
    { name: "📦 Quantité", value: `${quantity} dispo`, inline: true },
    { name: "🛒 Panier", value: cartStatus, inline: true }
  ];
  
  // Add price if available
  if (cartResult && cartResult.success && cartResult.productInfo) {
    fields.push({ name: "💰 Prix", value: `${cartResult.productInfo.price} ~~${cartResult.productInfo.originalPrice}~~ (${cartResult.productInfo.discount})`, inline: false });
  } else if (productInfo.price && productInfo.price !== '-') {
    fields.push({ name: "� Prix", value: productInfo.price, inline: true });
  }
  
  // Add expiration if cart success
  if (cartResult && cartResult.success && cartResult.expirationDate) {
    const expDate = new Date(cartResult.expirationDate);
    fields.push({ name: "⏰ Expire", value: expDate.toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'}), inline: true });
  }
  
  fields.push({ name: "� Liens", value: `[Voir produit](${productUrl}) | [Checkout](${CONFIG.checkoutUrl})`, inline: false });
  
  const embed = {
    title: title,
    color: cartColor,
    fields: fields,
    footer: { text: `ID: ${productId}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: content,
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

// Cart recovery notification
function sendCartRecoveryNotification(items, newExpirationDate) {
  const itemsList = items.map(item => `• ${item.productName} (${item.size})`).join('\n');
  const deadlineStr = new Date(newExpirationDate).toLocaleString('fr-FR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
  
  const embed = {
    title: "🔄 PANIER PROLONGÉ",
    color: 0x22c55e, // Green
    description: `Le panier a été prolongé avec succès!`,
    fields: [
      { name: "📦 Articles", value: itemsList || 'Aucun', inline: false },
      { name: "⏰ Nouvelle expiration", value: `**${deadlineStr}**`, inline: false },
      { name: "🛒 Checkout", value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: false }
    ],
    footer: { text: `${items.length} article(s) dans le panier` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "🔄 **PANIER PROLONGÉ - Tu as encore 15 minutes!**",
    embeds: [embed]
  });
}

// Cart empty notification (recovery stopped)
function sendCartEmptyNotification() {
  const embed = {
    title: "🛒 PANIER VIDE",
    color: 0xfbbf24, // Yellow
    description: "Le panier est vide. Le prolongement automatique a été désactivé.",
    fields: [
      { name: "ℹ️ Info", value: "Le prolongement reprendra automatiquement quand un article sera ajouté au panier.", inline: false }
    ],
    footer: { text: "Veepee Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    embeds: [embed]
  });
}

// ============== CART RECOVERY LOGIC ==============

async function checkAndRecoverCart() {
  try {
    console.log(`[${getTimestamp()}] 🛒 Checking cart status...`);
    
    const cartData = await getCart();
    cartState.lastCheck = new Date().toISOString();
    
    // Check if cart is empty
    if (cartData.empty) {
      console.log(`[${getTimestamp()}] 🛒 Cart is empty`);
      
      if (cartState.hasItems) {
        // Cart was not empty before, notify
        cartState.hasItems = false;
        cartState.items = [];
        cartState.expirationDate = null;
        await sendCartEmptyNotification();
        stopCartRecovery();
      }
      return { success: false, reason: 'empty' };
    }
    
    // Check for recoverable items (cart expired but can be recovered)
    if (cartData.recoverableItems && cartData.recoverableItems.itemList && cartData.recoverableItems.itemList.length > 0) {
      console.log(`[${getTimestamp()}] 🔄 Cart expired, recovering ${cartData.recoverableItems.itemList.length} items...`);
      
      const recoverResult = await recoverCart();
      cartState.lastRecover = new Date().toISOString();
      
      if (recoverResult && recoverResult.expirationDate) {
        // Extract items from recovery response
        let items = [];
        if (recoverResult.deliveryGroups) {
          recoverResult.deliveryGroups.forEach(group => {
            if (group.cartItemGroups) {
              group.cartItemGroups.forEach(cartGroup => {
                if (cartGroup.items) {
                  items = items.concat(cartGroup.items);
                }
              });
            }
          });
        }
        
        cartState.hasItems = true;
        cartState.items = items;
        cartState.expirationDate = recoverResult.expirationDate;
        await saveCartStateToDB();
        
        // Auto-start cart recovery if not already running
        if (!cartRecoveryInterval && items.length > 0) {
          console.log(`[${getTimestamp()}] 🔄 Items recovered - auto-starting cart recovery`);
          cartState.recoveryActive = true;
          await saveCartStateToDB();
          cartRecoveryInterval = setInterval(checkAndRecoverCart, CART_RECOVERY_INTERVAL_MS);
        }
        
        console.log(`[${getTimestamp()}] ✅ Cart recovered! New expiration: ${recoverResult.expirationDate}`);
        await sendCartRecoveryNotification(items, recoverResult.expirationDate);
        
        return { success: true, items: items.length, expirationDate: recoverResult.expirationDate };
      }
    }
    
    // Cart has active items (not expired yet)
    if (cartData.deliveryGroups || cartData.unitCount > 0) {
      let items = [];
      if (cartData.deliveryGroups) {
        cartData.deliveryGroups.forEach(group => {
          if (group.cartItemGroups) {
            group.cartItemGroups.forEach(cartGroup => {
              if (cartGroup.items) {
                items = items.concat(cartGroup.items);
              }
            });
          }
        });
      }
      
      cartState.hasItems = true;
      cartState.items = items;
      cartState.expirationDate = cartData.expirationDate;
      await saveCartStateToDB();
      
      // Auto-start cart recovery if items detected and not already running
      if (!cartRecoveryInterval && items.length > 0) {
        console.log(`[${getTimestamp()}] � Items detected in cart - auto-starting cart recovery`);
        cartState.recoveryActive = true;
        await saveCartStateToDB();
        cartRecoveryInterval = setInterval(checkAndRecoverCart, CART_RECOVERY_INTERVAL_MS);
      }
      
      console.log(`[${getTimestamp()}] � Cart has ${items.length} items, expires: ${cartData.expirationDate}`);
      return { success: true, items: items.length, expirationDate: cartData.expirationDate, needsRecovery: false };
    }
    
    return { success: false, reason: 'unknown' };
    
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Cart check error:`, error.message);
    
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403')) {
      await sendTokenExpiredNotification(error.message);
    }
    
    return { success: false, error: error.message };
  }
}

async function startCartRecovery(skipInitialCheck = false) {
  if (cartRecoveryInterval) {
    console.log(`[${getTimestamp()}] 🔄 Cart recovery already running`);
    return { success: true, message: 'Already running' };
  }
  
  // First check if cart has items (unless we already know it does)
  if (!skipInitialCheck) {
    const cartData = await getCart();
    if (cartData.empty) {
      console.log(`[${getTimestamp()}] 🛒 Cannot start cart recovery - cart is empty`);
      return { success: false, message: 'Cart is empty' };
    }
  }
  
  cartState.recoveryActive = true;
  await saveCartStateToDB();
  console.log(`[${getTimestamp()}] 🔄 Starting cart recovery (interval: ${CART_RECOVERY_INTERVAL_MS / 1000 / 60} min)`);
  
  // Run immediately
  checkAndRecoverCart();
  
  // Then run every 13 minutes
  cartRecoveryInterval = setInterval(checkAndRecoverCart, CART_RECOVERY_INTERVAL_MS);
  
  return { success: true, message: 'Cart recovery started' };
}

async function stopCartRecovery() {
  if (cartRecoveryInterval) {
    clearInterval(cartRecoveryInterval);
    cartRecoveryInterval = null;
    cartState.recoveryActive = false;
    await saveCartStateToDB();
    console.log(`[${getTimestamp()}] ⏹️ Cart recovery stopped`);
  }
}

// Cart Keeper Loop - starts on restock, stops when cart is empty
function startCartKeeperLoop() {
  if (cartRecoveryInterval) {
    console.log(`[${getTimestamp()}] 🔄 Cart Keeper already running`);
    return;
  }
  
  console.log(`[${getTimestamp()}] 🔄 Cart Keeper started (checks every ${CART_RECOVERY_INTERVAL_MS / 1000 / 60} min)`);
  cartState.recoveryActive = true;
  saveCartStateToDB();
  
  // Check immediately on start
  checkAndRecoverCart();
  
  // Then check every 13 minutes
  cartRecoveryInterval = setInterval(checkAndRecoverCart, CART_RECOVERY_INTERVAL_MS);
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
            
            // Try to add to cart automatically
            const productUrl = `https://www.veepee.fr/gr/product/${product.saleId}/${product.itemId}`;
            let cartResult = null;
            
            try {
              console.log(`[${getTimestamp()}] 🛒 Adding to cart: ${size} (${productId})...`);
              cartResult = await addToCart(product.saleId, productId);
              
              if (cartResult.success) {
                console.log(`[${getTimestamp()}] ✅ Added to cart! Expires: ${cartResult.expirationDate}`);
                
                // Start Cart Keeper when item is added to cart
                if (!cartRecoveryInterval) {
                  console.log(`[${getTimestamp()}] 🔄 Item in cart - starting Cart Keeper`);
                  startCartKeeperLoop();
                }
              }
            } catch (cartError) {
              console.error(`[${getTimestamp()}] ❌ Add to cart failed:`, cartError.message);
              cartResult = { success: false, error: cartError.message };
            }
            
            // Send stock alert notification with cart status
            await sendStockAlertNotification(
              product.productInfo,
              productId,
              size,
              stockData.quantity,
              productUrl,
              cartResult
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
    
    const product = {
      saleId,
      itemId,
      productInfo,
      sizeMapping,
      watchedSizes: new Set(watchedSizes),
      previousStock: stockInfo,
      notified: new Set(alreadyInStock.length > 0 ? watchedSizes.filter(id => stockInfo[id]?.inStock) : [])
    };
    monitoredProducts.set(key, product);
    await saveMonitoredProductToDB(key, product);
    
    // Save to history
    await addToHistory(saleId, itemId, productInfo, sizeMapping);

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
app.delete('/api/products/:key', async (req, res) => {
  const { key } = req.params;
  
  if (monitoredProducts.has(key)) {
    monitoredProducts.delete(key);
    await deleteMonitoredProductFromDB(key);
    
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

// ============== HISTORY API ==============

// Get product history
app.get('/api/history', (req, res) => {
  const history = [];
  for (const [key, item] of productHistory) {
    history.push({
      key,
      saleId: item.saleId,
      itemId: item.itemId,
      title: item.title,
      brand: item.brand,
      sizeMapping: item.sizeMapping,
      addedAt: item.addedAt,
      lastMonitored: item.lastMonitored,
      isCurrentlyMonitored: monitoredProducts.has(key)
    });
  }
  // Sort by lastMonitored (most recent first)
  history.sort((a, b) => new Date(b.lastMonitored) - new Date(a.lastMonitored));
  res.json({ history });
});

// Clear history
app.delete('/api/history', async (req, res) => {
  productHistory.clear();
  await clearHistoryFromDB();
  res.json({ success: true, message: 'History cleared' });
});

// Remove single item from history
app.delete('/api/history/:key', async (req, res) => {
  const { key } = req.params;
  if (productHistory.has(key)) {
    productHistory.delete(key);
    await deleteHistoryFromDB(key);
    res.json({ success: true, message: 'Item removed from history' });
  } else {
    res.status(404).json({ error: 'Item not found in history' });
  }
});

// ============== CART RECOVERY API ==============

// Get cart state
app.get('/api/cart', (req, res) => {
  res.json({
    ...cartState,
    recoveryIntervalMs: CART_RECOVERY_INTERVAL_MS,
    recoveryIntervalMin: CART_RECOVERY_INTERVAL_MS / 1000 / 60
  });
});

// Check cart status (manual trigger)
app.post('/api/cart/check', async (req, res) => {
  try {
    const result = await checkAndRecoverCart();
    res.json({ success: true, ...result, cartState });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start cart recovery
app.post('/api/cart/recovery/start', async (req, res) => {
  const result = await startCartRecovery();
  res.json({ ...result, cartState });
});

// Stop cart recovery
app.post('/api/cart/recovery/stop', async (req, res) => {
  await stopCartRecovery();
  res.json({ success: true, message: 'Cart recovery stopped', cartState });
});

// Manual recover (force)
app.post('/api/cart/recover', async (req, res) => {
  try {
    const result = await recoverCart();
    
    // Update cart state
    if (result && result.expirationDate) {
      let items = [];
      if (result.deliveryGroups) {
        result.deliveryGroups.forEach(group => {
          if (group.cartItemGroups) {
            group.cartItemGroups.forEach(cartGroup => {
              if (cartGroup.items) {
                items = items.concat(cartGroup.items);
              }
            });
          }
        });
      }
      
      cartState.hasItems = true;
      cartState.items = items;
      cartState.expirationDate = result.expirationDate;
      cartState.lastRecover = new Date().toISOString();
      
      // Start recovery interval if not already running
      if (!cartRecoveryInterval) {
        startCartRecovery();
      }
    }
    
    res.json({ success: true, result, cartState });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Parse auth from full headers or just the Authorization value
function parseAuthInput(input) {
  if (!input) return null;
  
  // If it contains multiple lines, it's likely full headers
  if (input.includes('\n') && input.includes('Authorization:')) {
    const match = input.match(/Authorization:\s*(.+)/i);
    if (match) {
      return match[1].trim();
    }
  }
  
  // Otherwise use as-is
  return input.trim();
}

// Update authorization
app.post('/api/config/auth', (req, res) => {
  const { userId, secretKey, authHeader } = req.body;
  
  const parsedAuth = parseAuthInput(authHeader);
  
  if (!parsedAuth && (!userId || !secretKey)) {
    return res.status(400).json({ error: 'Either authHeader or userId+secretKey are required' });
  }
  
  if (parsedAuth) {
    CONFIG.authHeader = parsedAuth;
    console.log(`[${getTimestamp()}] Auth header updated via API: ${parsedAuth.substring(0, 30)}...`);
  } else {
    CONFIG.userId = userId;
    CONFIG.secretKey = secretKey;
    CONFIG.authHeader = '';
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
    cartRecovery: {
      active: cartState.recoveryActive,
      hasItems: cartState.hasItems,
      itemCount: cartState.items.length,
      expirationDate: cartState.expirationDate,
      lastCheck: cartState.lastCheck,
      lastRecover: cartState.lastRecover
    },
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

async function startServer() {
  // Initialize database
  await initDatabase();
  
  // Load data from database
  await loadMonitoredProductsFromDB();
  await loadHistoryFromDB();
  await loadCartStateFromDB();
  
  // Start monitoring if we have products
  if (monitoredProducts.size > 0) {
    startMonitoring();
  }
  
  // Cart Keeper will be started when a restock is detected
  
  app.listen(PORT, '0.0.0.0', () => {
    const dbStatus = useDatabase ? 'PostgreSQL ✅' : 'In-memory only ⚠️';
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🛒 Veepee Stock Monitor - Web Interface                     ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
║  Database: ${dbStatus.padEnd(50)} ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    if (!CONFIG.authHeader && (!CONFIG.userId || !CONFIG.secretKey)) {
      console.log('⚠️ No VEEPEE auth configured - set VEEPEE_AUTH or VEEPEE_USER_ID + VEEPEE_SECRET_KEY');
    }
    
    console.log(`🗄️ Database: ${useDatabase ? 'PostgreSQL connected' : 'No database (data will not persist)'}`);
    console.log(`📦 Monitored products: ${monitoredProducts.size}`);
    console.log(`📋 History items: ${productHistory.size}`);
    console.log(`🛒 Cart Keeper: Activates on restock detection`);
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
