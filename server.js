const express = require('express');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Data persistence files
const DATA_DIR = path.join(__dirname, 'data');
const PRODUCTS_FILE = path.join(DATA_DIR, 'monitored_products.json');
const HISTORY_FILE = path.join(DATA_DIR, 'product_history.json');
const FILLER_PRODUCTS_FILE = path.join(DATA_DIR, 'filler_products.json');
const CART_KEEPER_FILE = path.join(DATA_DIR, 'cart_keeper.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const app = express();
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// Configuration - All sensitive data from environment variables
const CONFIG = {
  discordWebhook: process.env.DISCORD_WEBHOOK || "",
  checkoutUrl: "https://www.bestsecret.com/cart.htm",
  cartReservationMinutes: 20,
  checkIntervalMs: 60 * 1000,
  authorization: process.env.BESTSECRET_TOKEN || "",
  refreshToken: process.env.BESTSECRET_REFRESH_TOKEN || "",
  // Login credentials for auto-login when refresh token expires
  email: process.env.BESTSECRET_EMAIL || "",
  password: process.env.BESTSECRET_PASSWORD || "",
  clientId: "4oF5TQ5h5AKQCbODiQBBhrwiYf4WxcDy",
  redirectUri: "com.bestsecret.BestSecret://login.bestsecret.com/ios/com.bestsecret.BestSecret/callback",
  tokenRefreshIntervalMs: 120 * 60 * 1000 // Refresh every 2 hours (token expires in ~2.4 hours)
};

// ============== PKCE HELPERS ==============

function generateRandomString(length) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
  let result = '';
  const randomBytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    result += chars[randomBytes[i] % chars.length];
  }
  return result;
}

function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function generateCodeVerifier() {
  return generateRandomString(43);
}

function generateCodeChallenge(codeVerifier) {
  const hash = crypto.createHash('sha256').update(codeVerifier).digest();
  return base64URLEncode(hash);
}

function generateState() {
  return base64URLEncode(crypto.randomBytes(32));
}

// ============== HTTP REQUEST HELPER ==============

function httpsRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = [];
      res.on('data', chunk => data.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(data).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          body
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Request timeout'));
    });
    if (postData) req.write(postData);
    req.end();
  });
}

function extractCookies(headers) {
  const cookies = {};
  const setCookies = headers['set-cookie'] || [];
  for (const cookie of setCookies) {
    const match = cookie.match(/^([^=]+)=([^;]+)/);
    if (match) {
      cookies[match[1]] = match[2];
    }
  }
  return cookies;
}

function formatCookies(cookieObj) {
  return Object.entries(cookieObj).map(([k, v]) => `${k}=${v}`).join('; ');
}

// Token refresh interval reference
let tokenRefreshInterval = null;
let lastTokenRefresh = null;

// Store monitored products
// Structure: { "code-color": { code, color, productInfo, sizeMapping, watchedSizes: Set, previousStock: {}, addedToCart: Set } }
const monitoredProducts = new Map();

// Product history (persists across monitoring sessions)
const productHistory = new Map();

// Filler products (always in stock items to keep cart alive)
// Structure: [{ code, color, variantId, productInfo, addCount }]
let fillerProducts = [];

// Cart keeper state
let cartKeeperState = {
  enabled: false,
  lastCartAddTime: null,      // When a monitored product was last added to cart
  lastFillerAddTime: null,    // When a filler product was last added
  fillerAddCount: 0,          // How many filler items added in current session
  currentFillerIndex: 0,      // Which filler product to use next
  cartHasItems: false         // Whether cart has monitored items
};

// Cart keeper interval reference
let cartKeeperInterval = null;

// Cart keeper settings
const CART_KEEPER_CONFIG = {
  checkIntervalMs: 60 * 1000,        // Check every 1 minute
  addFillerAfterMs: 18 * 60 * 1000,  // Add filler 18 min after last add (before 20 min expiry)
  maxFillerPerProduct: 4             // Max 4 items of same product/size
};

// Monitoring interval reference
let monitoringInterval = null;

// ============== PERSISTENCE FUNCTIONS ==============

function saveMonitoredProducts() {
  try {
    const data = [];
    for (const [key, product] of monitoredProducts) {
      data.push({
        key,
        code: product.code,
        color: product.color,
        productInfo: product.productInfo,
        sizeMapping: product.sizeMapping,
        watchedSizes: Array.from(product.watchedSizes),
        previousStock: product.previousStock,
        addedToCart: Array.from(product.addedToCart)
      });
    }
    fs.writeFileSync(PRODUCTS_FILE, JSON.stringify(data, null, 2));
    console.log(`[${getTimestamp()}] 💾 Saved ${data.length} monitored products`);
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error saving products:`, error.message);
  }
}

function loadMonitoredProducts() {
  try {
    if (fs.existsSync(PRODUCTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8'));
      for (const product of data) {
        monitoredProducts.set(product.key, {
          code: product.code,
          color: product.color,
          productInfo: product.productInfo,
          sizeMapping: product.sizeMapping,
          watchedSizes: new Set(product.watchedSizes),
          previousStock: product.previousStock || {},
          addedToCart: new Set(product.addedToCart || [])
        });
      }
      console.log(`[${getTimestamp()}] 📂 Loaded ${data.length} monitored products from disk`);
      return data.length;
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error loading products:`, error.message);
  }
  return 0;
}

function saveHistory() {
  try {
    const data = [];
    for (const [key, item] of productHistory) {
      data.push({ key, ...item });
    }
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(data, null, 2));
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error saving history:`, error.message);
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
      for (const item of data) {
        const { key, ...rest } = item;
        productHistory.set(key, rest);
      }
      console.log(`[${getTimestamp()}] 📂 Loaded ${data.length} history items from disk`);
      return data.length;
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error loading history:`, error.message);
  }
  return 0;
}

// Filler products persistence
function saveFillerProducts() {
  try {
    fs.writeFileSync(FILLER_PRODUCTS_FILE, JSON.stringify(fillerProducts, null, 2));
    console.log(`[${getTimestamp()}] 💾 Saved ${fillerProducts.length} filler products`);
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error saving filler products:`, error.message);
  }
}

function loadFillerProducts() {
  try {
    if (fs.existsSync(FILLER_PRODUCTS_FILE)) {
      fillerProducts = JSON.parse(fs.readFileSync(FILLER_PRODUCTS_FILE, 'utf8'));
      console.log(`[${getTimestamp()}] 📂 Loaded ${fillerProducts.length} filler products from disk`);
      return fillerProducts.length;
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error loading filler products:`, error.message);
  }
  return 0;
}

// Cart keeper state persistence
function saveCartKeeperState() {
  try {
    fs.writeFileSync(CART_KEEPER_FILE, JSON.stringify(cartKeeperState, null, 2));
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error saving cart keeper state:`, error.message);
  }
}

function loadCartKeeperState() {
  try {
    if (fs.existsSync(CART_KEEPER_FILE)) {
      const loaded = JSON.parse(fs.readFileSync(CART_KEEPER_FILE, 'utf8'));
      cartKeeperState = { ...cartKeeperState, ...loaded };
      console.log(`[${getTimestamp()}] 📂 Loaded cart keeper state (enabled: ${cartKeeperState.enabled})`);
      return true;
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Error loading cart keeper state:`, error.message);
  }
  return false;
}

// ============== CART KEEPER FUNCTIONS ==============

// Check cart reservation time using BestSecret API
async function checkCartReservationTime() {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      operationName: 'CartReservationTime',
      variables: '{}',
      extensions: JSON.stringify({
        persistedQuery: {
          version: 1,
          sha256Hash: '3031f08f392db789cffa4581a4b72da736af1ce29775692bc7661da4cfa68627'
        }
      })
    });

    const options = {
      hostname: 'www.bestsecret.com',
      port: 443,
      path: `/bff-spa?${params.toString()}`,
      method: 'GET',
      headers: {
        'Accept': '*/*',
        'x-current-spa-version': '1766058484',
        'x-correlation-id': `web-spa-${crypto.randomUUID()}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) iOS app/7.114.1 (iOS 26.2) [iPhone18,1]',
        'Authorization': CONFIG.authorization,
        'Cookie': 'JSESSIONID=Y24-9364755d-c42b-4cd0-8d7e-fcaf3a4eb9b3'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          const remainingMs = response.data?.cart?.remainingReservationTimeInMS || 0;
          const maxMs = response.data?.accountInfo?.maximumCartReservationTimeInMS || 1200000;
          resolve({ remainingMs, maxMs, hasItems: remainingMs > 0 });
        } catch (e) {
          reject(new Error(`Failed to parse cart time: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy();
      reject(new Error('Cart check timeout'));
    });
    req.end();
  });
}

// Get the next filler product to add (rotates through available fillers)
function getNextFillerProduct() {
  if (fillerProducts.length === 0) return null;
  
  // Find a filler that hasn't reached max add count
  for (let i = 0; i < fillerProducts.length; i++) {
    const index = (cartKeeperState.currentFillerIndex + i) % fillerProducts.length;
    const filler = fillerProducts[index];
    
    if ((filler.addCount || 0) < CART_KEEPER_CONFIG.maxFillerPerProduct) {
      cartKeeperState.currentFillerIndex = (index + 1) % fillerProducts.length;
      return filler;
    }
  }
  
  // All fillers maxed out, reset counts and start over
  console.log(`[${getTimestamp()}] 🔄 Resetting filler add counts`);
  fillerProducts.forEach(f => f.addCount = 0);
  saveFillerProducts();
  cartKeeperState.currentFillerIndex = 0;
  return fillerProducts[0];
}

// Cart keeper main logic - runs periodically
async function runCartKeeper() {
  if (!cartKeeperState.enabled || fillerProducts.length === 0) {
    return;
  }

  try {
    // Check if cart has items and how much time is left
    const cartInfo = await checkCartReservationTime();
    
    console.log(`[${getTimestamp()}] 🛒 Cart check: ${cartInfo.hasItems ? 'Has items' : 'Empty'}, ${Math.round(cartInfo.remainingMs / 60000)}min remaining`);
    
    if (!cartInfo.hasItems) {
      // Cart is empty, reset state
      if (cartKeeperState.cartHasItems) {
        console.log(`[${getTimestamp()}] 📭 Cart is now empty`);
        cartKeeperState.cartHasItems = false;
        cartKeeperState.lastCartAddTime = null;
        saveCartKeeperState();
      }
      return;
    }

    // Cart has items
    cartKeeperState.cartHasItems = true;
    
    // Calculate time since last add (either monitored product or filler)
    const lastAddTime = cartKeeperState.lastFillerAddTime || cartKeeperState.lastCartAddTime;
    const now = Date.now();
    const timeSinceLastAdd = lastAddTime ? now - new Date(lastAddTime).getTime() : Infinity;
    
    // Check if we need to add a filler (18 minutes since last add OR remaining time < 3 minutes)
    const needsFiller = timeSinceLastAdd >= CART_KEEPER_CONFIG.addFillerAfterMs || 
                        cartInfo.remainingMs < 3 * 60 * 1000;
    
    if (needsFiller) {
      const filler = getNextFillerProduct();
      if (filler) {
        console.log(`[${getTimestamp()}] 🔄 Adding filler product to keep cart alive...`);
        
        const success = await addToCart(filler.variantId);
        if (success) {
          filler.addCount = (filler.addCount || 0) + 1;
          cartKeeperState.lastFillerAddTime = new Date().toISOString();
          cartKeeperState.fillerAddCount++;
          
          saveFillerProducts();
          saveCartKeeperState();
          
          console.log(`[${getTimestamp()}] ✅ Filler added! (${filler.productInfo?.title || filler.variantId}) - Total fillers: ${cartKeeperState.fillerAddCount}`);
          
          // Send Discord notification about cart keeper activity
          await sendCartKeeperNotification(filler, cartKeeperState.fillerAddCount);
        } else {
          console.log(`[${getTimestamp()}] ❌ Failed to add filler product`);
        }
      } else {
        console.log(`[${getTimestamp()}] ⚠️ No filler products available`);
      }
    }
  } catch (error) {
    console.error(`[${getTimestamp()}] Cart keeper error:`, error.message);
  }
}

// Send Discord notification when filler is added
function sendCartKeeperNotification(filler, totalFillers) {
  const embed = {
    title: "🔄 Cart Keeper - Panier maintenu",
    color: 0x3b82f6,
    fields: [
      { name: "📦 Produit ajouté", value: filler.productInfo?.title || filler.variantId, inline: false },
      { name: "🔢 Total fillers ajoutés", value: `${totalFillers}`, inline: true },
      { name: "⏰ Prochain refresh", value: "~18 min", inline: true }
    ],
    footer: { text: "Cart Keeper - Maintient le panier actif" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({ embeds: [embed] });
}

// Start cart keeper
function startCartKeeper() {
  if (cartKeeperInterval) {
    console.log('Cart keeper already running');
    return;
  }
  
  if (fillerProducts.length === 0) {
    console.log('⚠️ No filler products configured - cart keeper disabled');
    return;
  }
  
  cartKeeperState.enabled = true;
  saveCartKeeperState();
  
  console.log(`[${getTimestamp()}] 🛒 Cart keeper started (checking every ${CART_KEEPER_CONFIG.checkIntervalMs / 1000}s)`);
  
  // Run immediately
  runCartKeeper();
  
  // Then run periodically
  cartKeeperInterval = setInterval(runCartKeeper, CART_KEEPER_CONFIG.checkIntervalMs);
}

// Stop cart keeper
function stopCartKeeper() {
  if (cartKeeperInterval) {
    clearInterval(cartKeeperInterval);
    cartKeeperInterval = null;
  }
  cartKeeperState.enabled = false;
  saveCartKeeperState();
  console.log(`[${getTimestamp()}] 🛑 Cart keeper stopped`);
}

// Called when a monitored product is added to cart
function onMonitoredProductAddedToCart() {
  cartKeeperState.lastCartAddTime = new Date().toISOString();
  cartKeeperState.cartHasItems = true;
  cartKeeperState.lastFillerAddTime = null; // Reset filler timer
  saveCartKeeperState();
  
  // Auto-start cart keeper if fillers are configured
  if (fillerProducts.length > 0 && !cartKeeperInterval) {
    startCartKeeper();
  }
}

// Add product to history
function addToHistory(code, color, productInfo, sizeMapping) {
  const key = `${code}-${color}`;
  productHistory.set(key, {
    code,
    color,
    title: productInfo.title || `Produit ${code}`,
    brand: productInfo.brand,
    price: productInfo.price,
    originalPrice: productInfo.originalPrice,
    discount: productInfo.discount,
    imageUrl: productInfo.imageUrl,
    sizeMapping,
    addedAt: new Date().toISOString(),
    lastMonitored: new Date().toISOString()
  });
  saveHistory(); // Auto-save after adding
}

// ============== BESTSECRET API FUNCTIONS ==============

function makeRequest(query, operationType) {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify(query);

    const options = {
      hostname: 'www.bestsecret.com',
      port: 443,
      path: '/apps-graphql',
      method: 'POST',
      headers: {
        'Pragma': 'no-remember-me',
        'Accept': 'multipart/mixed;deferSpec=20220824,application/graphql-response+json,application/json',
        'apollographql-client-version': '7.114.1-2',
        'X-Correlation-ID': 'app-ios-192C8693-CDD3-4069-8CBD-F9A580902993',
        'Authorization': CONFIG.authorization,
        'Accept-Language': 'fr',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'iOS app/7.114.1 (iOS 26.2) [iPhone18,1]',
        'X-APOLLO-OPERATION-TYPE': operationType,
        'apollographql-client-name': 'com.bestsecret.BestSecret-apollo-ios',
        'Connection': 'keep-alive',
        'Cookie': 'JSESSIONID=Y24-9364755d-c42b-4cd0-8d7e-fcaf3a4eb9b3; Q7dd-SfmkGWaQxhT7lLo5Q__=v1XPEHg36gkqn; X-CSRF-TOKEN=25df9386-0c7d-44fd-b637-2a3b3103ceb6',
        'X-APOLLO-OPERATION-NAME': query.operationName
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        // Check for HTTP-level auth errors
        if (res.statusCode === 401 || res.statusCode === 403) {
          reject(new Error(`Unauthorized (${res.statusCode}) - Token expired or invalid`));
          return;
        }
        
        try {
          const response = JSON.parse(data);
          
          // Check for GraphQL-level auth errors
          if (response.errors) {
            const authError = response.errors.find(e => 
              e.message?.toLowerCase().includes('unauthorized') ||
              e.message?.toLowerCase().includes('token') ||
              e.message?.toLowerCase().includes('auth') ||
              e.extensions?.code === 'UNAUTHENTICATED'
            );
            if (authError) {
              reject(new Error(`Auth error: ${authError.message}`));
              return;
            }
          }
          
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(postData);
    req.end();
  });
}

async function fetchProductDetails(code, color) {
  const query = {
    operationName: "ProductDetailAndStock",
    query: `query ProductDetailAndStock($code: String!, $color: String!) { product(code: $code, color: $color) { __typename ...ProductDetailFragment } stock { __typename styleArticleStocks(genericArticleId: $code, styleCode: $color) { __typename ...StockInformationFragment } } }
fragment ProductDetailFragment on PdpProductDetail { __typename productTitle designer { __typename name } style { __typename primaryColor { __typename name } } variants { __typename code size { __typename sizeText vendorSize } } price { __typename primary { __typename salesPrice { __typename formatted } recommendedRetailPrice { __typename formatted } relativeDiscount { __typename formatted } } } }
fragment StockInformationFragment on VariantArticleStock { __typename variantArticleId unreservedStock }`,
    variables: { code, color }
  };

  const response = await makeRequest(query, 'query');
  
  if (!response.data?.product) {
    throw new Error('Product not found');
  }

  const product = response.data.product;
  const productInfo = {
    title: product.productTitle,
    designer: product.designer?.name,
    color: product.style?.primaryColor?.name,
    price: product.price?.primary?.salesPrice?.formatted,
    originalPrice: product.price?.primary?.recommendedRetailPrice?.formatted,
    discount: product.price?.primary?.relativeDiscount?.formatted
  };

  const sizeMapping = {};
  product.variants.forEach(variant => {
    sizeMapping[variant.code] = {
      size: variant.size?.sizeText || 'N/A',
      vendorSize: variant.size?.vendorSize
    };
  });

  const stocks = response.data.stock?.styleArticleStocks || [];
  const stockInfo = {};
  stocks.forEach(item => {
    stockInfo[item.variantArticleId] = item.unreservedStock;
  });

  return { productInfo, sizeMapping, stockInfo };
}

async function checkStock(code, color) {
  const query = {
    operationName: "StockWithCodeAndColor",
    query: `query StockWithCodeAndColor($code: String!, $color: String!) { stock { __typename styleArticleStocks(genericArticleId: $code, styleCode: $color) { __typename ...StockInformationFragment } } }
fragment StockInformationFragment on VariantArticleStock { __typename variantArticleId unreservedStock }`,
    variables: { code, color }
  };

  const response = await makeRequest(query, 'query');
  
  if (!response.data?.stock?.styleArticleStocks) {
    throw new Error('Stock check failed');
  }

  const stockInfo = {};
  response.data.stock.styleArticleStocks.forEach(item => {
    stockInfo[item.variantArticleId] = item.unreservedStock;
  });

  return stockInfo;
}

async function addToCart(productCode) {
  const query = {
    operationName: "AddToCart",
    query: "mutation AddToCart($productCode: String!) { addToCart(productCode: $productCode) { __typename informationFromUpdate { __typename content } response } }",
    variables: { productCode }
  };

  const response = await makeRequest(query, 'mutation');
  return response.data?.addToCart?.response === 'SUCCESS';
}

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

function sendDiscordNotification(productInfo, productCode, size, deadlineStr) {
  const embed = {
    title: "🚨 ARTICLE AJOUTÉ AU PANIER!",
    color: 0x4ade80,
    fields: [
      { name: "👕 Produit", value: `**${productInfo.designer} - ${productInfo.title}**`, inline: false },
      { name: "🎨 Couleur", value: productInfo.color || '-', inline: true },
      { name: "📏 Taille", value: `**${size}**`, inline: true },
      { name: "💰 Prix", value: `${productInfo.price || '-'} (${productInfo.discount || '-'})`, inline: true },
      { name: "⏰ CHECKOUT AVANT", value: `**${deadlineStr}**`, inline: false },
      { name: "🛒 Lien Checkout", value: `[Aller au panier](${CONFIG.checkoutUrl})`, inline: false }
    ],
    footer: { text: `Article: ${productCode}` },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚨 **NOUVEAU STOCK DISPONIBLE - CHECKOUT MAINTENANT!**",
    embeds: [embed]
  });
}

// Track if we already sent a token expired notification (to avoid spam)
let tokenExpiredNotificationSent = false;

function sendTokenExpiredNotification(errorMessage) {
  if (tokenExpiredNotificationSent) {
    return Promise.resolve(false);
  }
  
  tokenExpiredNotificationSent = true;
  
  const embed = {
    title: "⚠️ TOKEN EXPIRÉ",
    color: 0xf87171,
    description: "Le token BestSecret a expiré. Le monitoring est en pause jusqu'à la mise à jour du token.",
    fields: [
      { name: "🔧 Action requise", value: "Mettez à jour le token via l'interface web ou la variable d'environnement Railway", inline: false },
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false }
    ],
    footer: { text: "BestSecret Monitor" },
    timestamp: new Date().toISOString()
  };

  console.log('⚠️ Token expired - sending Discord notification');
  
  return sendDiscordWebhook({
    content: "@everyone ⚠️ **TOKEN EXPIRÉ - MISE À JOUR REQUISE!**",
    embeds: [embed]
  });
}

// Reset token expired flag when token is updated
function resetTokenExpiredFlag() {
  tokenExpiredNotificationSent = false;
}

// ============== TOKEN REFRESH LOGIC ==============

async function refreshAccessToken() {
  return new Promise((resolve, reject) => {
    if (!CONFIG.refreshToken) {
      reject(new Error('No refresh token available'));
      return;
    }

    const postData = JSON.stringify({
      grant_type: "refresh_token",
      client_id: CONFIG.clientId,
      refresh_token: CONFIG.refreshToken
    });

    const options = {
      hostname: 'login.bestsecret.com',
      port: 443,
      path: '/oauth/token',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'BestSecret/2 CFNetwork/3860.300.31 Darwin/25.2.0',
        'Accept': '*/*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
        'Auth0-Client': 'eyJ2ZXJzaW9uIjoiMi41LjAiLCJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsic3dpZnQiOiI1LngiLCJpT1MiOiIyNi4yIn19',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const response = JSON.parse(data);
          
          if (res.statusCode !== 200 || !response.access_token) {
            reject(new Error(`Token refresh failed: ${res.statusCode} - ${data}`));
            return;
          }
          
          resolve(response);
        } catch (error) {
          reject(new Error(`Parse error: ${error.message}`));
        }
      });
    });

    req.on('error', (error) => reject(error));
    req.write(postData);
    req.end();
  });
}

function sendTokenRefreshSuccessNotification() {
  const embed = {
    title: "✅ TOKEN RAFRAÎCHI",
    color: 0x22c55e,
    description: "Le token BestSecret a été automatiquement rafraîchi.",
    fields: [
      { name: "⏰ Prochain rafraîchissement", value: "Dans ~2 heures", inline: false }
    ],
    footer: { text: "BestSecret Monitor - Auto Refresh" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    embeds: [embed]
  });
}

function sendTokenRefreshFailedNotification(errorMessage) {
  const embed = {
    title: "❌ ÉCHEC RAFRAÎCHISSEMENT TOKEN",
    color: 0xf87171,
    description: "Le rafraîchissement automatique du token a échoué. Tentative de re-login...",
    fields: [
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false }
    ],
    footer: { text: "BestSecret Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    embeds: [embed]
  });
}

function sendLoginSuccessNotification() {
  const embed = {
    title: "🔑 LOGIN RÉUSSI",
    color: 0x22c55e,
    description: "Connexion automatique à BestSecret réussie! Nouveaux tokens obtenus.",
    fields: [
      { name: "⏰ Prochain rafraîchissement", value: "Dans ~2 heures", inline: false }
    ],
    footer: { text: "BestSecret Monitor - Auto Login" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    embeds: [embed]
  });
}

function sendLoginFailedNotification(errorMessage) {
  const embed = {
    title: "🚫 ÉCHEC LOGIN AUTOMATIQUE",
    color: 0xf87171,
    description: "La connexion automatique a échoué. Vérifiez vos identifiants.",
    fields: [
      { name: "❌ Erreur", value: `\`${errorMessage.substring(0, 500)}\``, inline: false },
      { name: "🔧 Action requise", value: "Vérifiez BESTSECRET_EMAIL et BESTSECRET_PASSWORD", inline: false }
    ],
    footer: { text: "BestSecret Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone 🚫 **ÉCHEC LOGIN - VÉRIFIEZ VOS IDENTIFIANTS!**",
    embeds: [embed]
  });
}

// ============== FULL LOGIN FLOW (OAuth2 + PKCE) ==============

async function performFullLogin() {
  if (!CONFIG.email || !CONFIG.password) {
    throw new Error('No credentials configured (BESTSECRET_EMAIL / BESTSECRET_PASSWORD)');
  }

  console.log(`[${getTimestamp()}] 🔐 Starting full OAuth2 + PKCE login flow...`);

  // Step 1: Generate PKCE values
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  console.log(`[${getTimestamp()}] Generated PKCE: state=${state.substring(0, 10)}...`);

  // Step 2: GET /authorize - initiates OAuth flow, returns cookies and redirect
  const auth0Client = 'eyJuYW1lIjoiQXV0aDAuc3dpZnQiLCJlbnYiOnsiaU9TIjoiMjYuMiIsInN3aWZ0IjoiNS54In0sInZlcnNpb24iOiIyLjUuMCJ9';
  const authorizeParams = new URLSearchParams({
    response_type: 'code',
    ui_locales: 'fr',
    scope: 'openid email offline_access',
    code_challenge_method: 'S256',
    'ext-app-info': 'iOS/7.114.1/26.2',
    redirect_uri: CONFIG.redirectUri,
    client_id: CONFIG.clientId,
    state: state,
    code_challenge: codeChallenge,
    auth0Client: auth0Client
  });

  const authorizeRes = await httpsRequest({
    hostname: 'login.bestsecret.com',
    port: 443,
    path: `/authorize?${authorizeParams.toString()}`,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9'
    }
  });

  if (authorizeRes.statusCode !== 302) {
    throw new Error(`Authorize failed: ${authorizeRes.statusCode}`);
  }

  let cookies = extractCookies(authorizeRes.headers);
  const loginRedirect = authorizeRes.headers.location;
  console.log(`[${getTimestamp()}] Step 1/5: Authorize redirect obtained`);

  // Step 3: GET /u/login - get login page (with cookies)
  const loginPageRes = await httpsRequest({
    hostname: 'login.bestsecret.com',
    port: 443,
    path: loginRedirect,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Cookie': formatCookies(cookies)
    }
  });

  cookies = { ...cookies, ...extractCookies(loginPageRes.headers) };
  console.log(`[${getTimestamp()}] Step 2/5: Login page loaded`);

  // Extract state from URL for POST
  const stateMatch = loginRedirect.match(/state=([^&]+)/);
  const loginState = stateMatch ? stateMatch[1] : '';

  // Step 4: POST /u/login - submit credentials
  const loginPostData = new URLSearchParams({
    state: loginState,
    username: CONFIG.email,
    password: CONFIG.password,
    'ulp-remember-me': 'on'
  }).toString();

  const loginPostRes = await httpsRequest({
    hostname: 'login.bestsecret.com',
    port: 443,
    path: loginRedirect,
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': formatCookies(cookies),
      'Origin': 'https://login.bestsecret.com',
      'Referer': `https://login.bestsecret.com${loginRedirect}`,
      'Content-Length': Buffer.byteLength(loginPostData)
    }
  }, loginPostData);

  if (loginPostRes.statusCode !== 302) {
    // Check if login failed (wrong credentials)
    if (loginPostRes.body.includes('Wrong email or password') || 
        loginPostRes.body.includes('invalid') ||
        loginPostRes.body.includes('error')) {
      throw new Error('Invalid credentials - Wrong email or password');
    }
    throw new Error(`Login POST failed: ${loginPostRes.statusCode}`);
  }

  cookies = { ...cookies, ...extractCookies(loginPostRes.headers) };
  const resumeRedirect = loginPostRes.headers.location;
  console.log(`[${getTimestamp()}] Step 3/5: Login successful, resuming auth`);

  // Step 5: GET /authorize/resume - get authorization code
  const resumeRes = await httpsRequest({
    hostname: 'login.bestsecret.com',
    port: 443,
    path: resumeRedirect,
    method: 'GET',
    headers: {
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Mobile/15E148 Safari/604.1',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Cookie': formatCookies(cookies),
      'Referer': `https://login.bestsecret.com${loginRedirect}`
    }
  });

  if (resumeRes.statusCode !== 302) {
    throw new Error(`Resume failed: ${resumeRes.statusCode}`);
  }

  // Extract authorization code from callback URL
  const callbackUrl = resumeRes.headers.location;
  const codeMatch = callbackUrl.match(/code=([^&]+)/);
  if (!codeMatch) {
    throw new Error('No authorization code in callback');
  }
  const authCode = codeMatch[1];
  console.log(`[${getTimestamp()}] Step 4/5: Authorization code obtained`);

  // Step 6: POST /oauth/token - exchange code for tokens
  const tokenPostData = JSON.stringify({
    client_id: CONFIG.clientId,
    code_verifier: codeVerifier,
    redirect_uri: CONFIG.redirectUri,
    grant_type: 'authorization_code',
    code: authCode
  });

  const tokenRes = await httpsRequest({
    hostname: 'login.bestsecret.com',
    port: 443,
    path: '/oauth/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'BestSecret/2 CFNetwork/3860.300.31 Darwin/25.2.0',
      'Accept': '*/*',
      'Accept-Language': 'fr-FR,fr;q=0.9',
      'Auth0-Client': auth0Client,
      'Content-Length': Buffer.byteLength(tokenPostData)
    }
  }, tokenPostData);

  if (tokenRes.statusCode !== 200) {
    throw new Error(`Token exchange failed: ${tokenRes.statusCode} - ${tokenRes.body}`);
  }

  const tokenData = JSON.parse(tokenRes.body);
  if (!tokenData.access_token || !tokenData.refresh_token) {
    throw new Error('Invalid token response');
  }

  console.log(`[${getTimestamp()}] Step 5/5: Tokens obtained successfully!`);

  return tokenData;
}

async function performTokenRefresh() {
  console.log(`[${getTimestamp()}] 🔄 Attempting token refresh...`);
  
  // If no refresh token, go directly to full login
  if (!CONFIG.refreshToken) {
    console.log(`[${getTimestamp()}] No refresh token - attempting full login...`);
    
    if (CONFIG.email && CONFIG.password) {
      try {
        const tokenData = await performFullLogin();
        
        CONFIG.authorization = `Bearer ${tokenData.access_token}`;
        CONFIG.refreshToken = tokenData.refresh_token;
        lastTokenRefresh = new Date();
        resetTokenExpiredFlag();
        
        console.log(`[${getTimestamp()}] ✅ Full login successful!`);
        await sendLoginSuccessNotification();
        
        return true;
      } catch (loginError) {
        console.error(`[${getTimestamp()}] 🚫 Full login failed:`, loginError.message);
        await sendLoginFailedNotification(loginError.message);
        return false;
      }
    } else {
      console.log(`[${getTimestamp()}] ⚠️ No credentials configured`);
      return false;
    }
  }
  
  // Try refresh token first
  try {
    const tokenData = await refreshAccessToken();
    
    // Update tokens in CONFIG
    CONFIG.authorization = `Bearer ${tokenData.access_token}`;
    if (tokenData.refresh_token) {
      CONFIG.refreshToken = tokenData.refresh_token;
    }
    
    lastTokenRefresh = new Date();
    resetTokenExpiredFlag();
    
    console.log(`[${getTimestamp()}] ✅ Token refreshed successfully!`);
    
    await sendTokenRefreshSuccessNotification();
    
    return true;
  } catch (refreshError) {
    console.error(`[${getTimestamp()}] ❌ Token refresh failed:`, refreshError.message);
    
    await sendTokenRefreshFailedNotification(refreshError.message);
    
    // Fallback: Try full login if credentials are configured
    if (CONFIG.email && CONFIG.password) {
      console.log(`[${getTimestamp()}] 🔐 Attempting full login as fallback...`);
      
      try {
        const tokenData = await performFullLogin();
        
        // Update tokens in CONFIG
        CONFIG.authorization = `Bearer ${tokenData.access_token}`;
        CONFIG.refreshToken = tokenData.refresh_token;
        
        lastTokenRefresh = new Date();
        resetTokenExpiredFlag();
        
        console.log(`[${getTimestamp()}] ✅ Full login successful!`);
        
        await sendLoginSuccessNotification();
        
        return true;
      } catch (loginError) {
        console.error(`[${getTimestamp()}] 🚫 Full login failed:`, loginError.message);
        
        await sendLoginFailedNotification(loginError.message);
        
        return false;
      }
    } else {
      console.log(`[${getTimestamp()}] ⚠️ No credentials configured for fallback login`);
      return false;
    }
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) {
    console.log('Token refresh already running');
    return;
  }
  
  // Check if we have either refresh token OR credentials for auto-login
  if (!CONFIG.refreshToken && (!CONFIG.email || !CONFIG.password)) {
    console.log('⚠️ No refresh token or credentials configured - automatic refresh disabled');
    return;
  }
  
  console.log(`🔄 Token auto-refresh started (every ${CONFIG.tokenRefreshIntervalMs / 60000} minutes)`);
  
  // Refresh immediately on start
  performTokenRefresh();
  
  // Then refresh every 2 hours
  tokenRefreshInterval = setInterval(performTokenRefresh, CONFIG.tokenRefreshIntervalMs);
}

function stopTokenRefresh() {
  if (tokenRefreshInterval) {
    clearInterval(tokenRefreshInterval);
    tokenRefreshInterval = null;
    console.log('Token refresh stopped');
  }
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
      const currentStock = await checkStock(product.code, product.color);
      
      console.log(`[${getTimestamp()}] Checking ${product.productInfo.designer} - ${product.productInfo.title}`);
      
      for (const [variantId, stock] of Object.entries(currentStock)) {
        const prevStock = product.previousStock[variantId] || 0;
        const sizeInfo = product.sizeMapping[variantId];
        const size = sizeInfo?.size || '?';
        
        // Check if this size is being watched and stock became available
        if (product.watchedSizes.has(variantId) && prevStock === 0 && stock > 0) {
          if (!product.addedToCart.has(variantId)) {
            console.log(`🚨 NEW STOCK: ${size} (${variantId}) - ${stock} units!`);
            
            const success = await addToCart(variantId);
            if (success) {
              product.addedToCart.add(variantId);
              saveMonitoredProducts(); // Save to disk
              
              const now = new Date();
              const deadline = new Date(now.getTime() + CONFIG.cartReservationMinutes * 60 * 1000);
              const deadlineStr = deadline.toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
              });
              
              console.log(`✅ Added to cart! Checkout before: ${deadlineStr}`);
              
              await sendDiscordNotification(product.productInfo, variantId, size, deadlineStr);
              
              // Trigger cart keeper to start keeping the cart alive
              onMonitoredProductAddedToCart();
            }
          }
        }
      }
      
      product.previousStock = currentStock;
    } catch (error) {
      console.error(`[${getTimestamp()}] Error monitoring ${key}:`, error.message);
      
      // Check if error is related to authentication/token expiration
      const errorMsg = error.message.toLowerCase();
      if (errorMsg.includes('unauthorized') || 
          errorMsg.includes('401') || 
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
  if (!monitoringInterval) {
    monitoringInterval = setInterval(monitorAllProducts, CONFIG.checkIntervalMs);
    console.log(`⏰ Monitoring started (every ${CONFIG.checkIntervalMs / 1000}s)`);
  }
}

function stopMonitoring() {
  if (monitoringInterval) {
    clearInterval(monitoringInterval);
    monitoringInterval = null;
    console.log('⏹️ Monitoring stopped');
  }
}

// ============== API ENDPOINTS ==============

// Get all monitored products
app.get('/api/products', (req, res) => {
  const products = [];
  for (const [key, product] of monitoredProducts) {
    products.push({
      key,
      code: product.code,
      color: product.color,
      productInfo: product.productInfo,
      sizeMapping: product.sizeMapping,
      watchedSizes: Array.from(product.watchedSizes),
      currentStock: product.previousStock,
      addedToCart: Array.from(product.addedToCart)
    });
  }
  res.json({ products, isMonitoring: !!monitoringInterval });
});

// Parse BestSecret URL to extract code and colorCode
function parseProductUrl(url) {
  // Format: https://www.bestsecret.com/product.htm?code=40448454&colorCode=000707799&...
  try {
    const urlObj = new URL(url);
    const code = urlObj.searchParams.get('code');
    const colorCode = urlObj.searchParams.get('colorCode');
    if (code && colorCode) {
      return { code, color: colorCode };
    }
  } catch (e) {}
  return null;
}

// Fetch product details (step 1: enter code and color or URL)
app.post('/api/products/fetch', async (req, res) => {
  try {
    let { code, color, url } = req.body;
    
    // If URL is provided, parse it
    if (url && (!code || !color)) {
      const parsed = parseProductUrl(url);
      if (parsed) {
        code = parsed.code;
        color = parsed.color;
      } else {
        return res.status(400).json({ error: 'Invalid BestSecret URL format' });
      }
    }
    
    if (!code || !color) {
      return res.status(400).json({ error: 'Code and color are required (or provide URL)' });
    }

    const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(code, color);
    
    res.json({
      code,
      color,
      productInfo,
      sizes: Object.entries(sizeMapping).map(([variantId, info]) => ({
        variantId,
        size: info.size,
        stock: stockInfo[variantId] || 0
      }))
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Fetch error:`, error.message);
    
    // Check if it's an auth error and send Discord notification
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth') ||
        errorMsg.includes('expired') ||
        errorMsg.includes('invalid')) {
      sendTokenExpiredNotification(error.message);
    }
    
    res.status(500).json({ error: error.message });
  }
});

// Add product to monitoring (step 2: select sizes to watch)
app.post('/api/products/add', async (req, res) => {
  try {
    const { code, color, watchedSizes } = req.body;
    
    if (!code || !color || !watchedSizes || !Array.isArray(watchedSizes)) {
      return res.status(400).json({ error: 'Code, color, and watchedSizes array are required' });
    }

    const key = `${code}-${color}`;
    
    // Fetch fresh product details
    const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(code, color);
    
    monitoredProducts.set(key, {
      code,
      color,
      productInfo,
      sizeMapping,
      watchedSizes: new Set(watchedSizes),
      previousStock: stockInfo,
      addedToCart: new Set()
    });
    
    // Save to disk
    saveMonitoredProducts();
    
    // Save to history
    addToHistory(code, color, productInfo, sizeMapping);

    // Start monitoring if not already running
    startMonitoring();

    res.json({ 
      success: true, 
      message: `Now monitoring ${productInfo.designer} - ${productInfo.title}`,
      watchedSizes: watchedSizes.map(id => sizeMapping[id]?.size || id)
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] Add product error:`, error.message);
    
    // Check if it's an auth error and send Discord notification
    const errorMsg = error.message.toLowerCase();
    if (errorMsg.includes('unauthorized') || 
        errorMsg.includes('401') || 
        errorMsg.includes('403') ||
        errorMsg.includes('token') ||
        errorMsg.includes('auth') ||
        errorMsg.includes('expired') ||
        errorMsg.includes('invalid')) {
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
    saveMonitoredProducts(); // Save to disk
    
    if (monitoredProducts.size === 0) {
      stopMonitoring();
    }
    
    res.json({ success: true, message: 'Product removed' });
  } else {
    res.status(404).json({ error: 'Product not found' });
  }
});

// Update watched sizes for a product
app.put('/api/products/:key/sizes', (req, res) => {
  const { key } = req.params;
  const { watchedSizes } = req.body;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.watchedSizes = new Set(watchedSizes);
  saveMonitoredProducts(); // Save to disk
  
  res.json({ success: true, watchedSizes: Array.from(product.watchedSizes) });
});

// Reset added to cart for a product (to re-enable alerts)
app.post('/api/products/:key/reset', (req, res) => {
  const { key } = req.params;
  
  if (!monitoredProducts.has(key)) {
    return res.status(404).json({ error: 'Product not found' });
  }
  
  const product = monitoredProducts.get(key);
  product.addedToCart.clear();
  saveMonitoredProducts(); // Save to disk
  
  res.json({ success: true, message: 'Cart tracking reset' });
});

// ============== HISTORY API ==============

// Get product history
app.get('/api/history', (req, res) => {
  const history = [];
  for (const [key, item] of productHistory) {
    history.push({
      key,
      code: item.code,
      color: item.color,
      title: item.title,
      brand: item.brand,
      price: item.price,
      originalPrice: item.originalPrice,
      discount: item.discount,
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
app.delete('/api/history', (req, res) => {
  productHistory.clear();
  saveHistory(); // Save to disk
  res.json({ success: true, message: 'History cleared' });
});

// Remove single item from history
app.delete('/api/history/:key', (req, res) => {
  const { key } = req.params;
  if (productHistory.has(key)) {
    productHistory.delete(key);
    saveHistory(); // Save to disk
    res.json({ success: true, message: 'Item removed from history' });
  } else {
    res.status(404).json({ error: 'Item not found in history' });
  }
});

// Update authorization token
app.post('/api/config/token', (req, res) => {
  const { token, refreshToken } = req.body;
  
  if (!token && !refreshToken) {
    return res.status(400).json({ error: 'Token or refreshToken is required' });
  }
  
  if (token) {
    CONFIG.authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    console.log(`[${getTimestamp()}] Access token updated via API`);
  }
  
  if (refreshToken) {
    CONFIG.refreshToken = refreshToken;
    console.log(`[${getTimestamp()}] Refresh token updated via API`);
    
    // Restart token refresh if not running
    if (!tokenRefreshInterval && CONFIG.refreshToken) {
      startTokenRefresh();
    }
  }
  
  resetTokenExpiredFlag();
  res.json({ success: true, message: 'Token(s) updated' });
});

// Endpoint to manually trigger token refresh
app.post('/api/config/refresh', async (req, res) => {
  try {
    const success = await performTokenRefresh();
    if (success) {
      res.json({ success: true, message: 'Token refreshed successfully' });
    } else {
      res.status(500).json({ error: 'Token refresh failed' });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============== CART KEEPER API ==============

// Get cart reservation time
app.get('/api/cart/time', async (req, res) => {
  try {
    const cartInfo = await checkCartReservationTime();
    res.json({
      remainingMs: cartInfo.remainingMs,
      remainingMinutes: Math.round(cartInfo.remainingMs / 60000),
      maxMs: cartInfo.maxMs,
      hasItems: cartInfo.hasItems
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get filler products
app.get('/api/fillers', (req, res) => {
  res.json({
    fillers: fillerProducts,
    cartKeeperEnabled: cartKeeperState.enabled,
    cartKeeperState: {
      lastCartAddTime: cartKeeperState.lastCartAddTime,
      lastFillerAddTime: cartKeeperState.lastFillerAddTime,
      fillerAddCount: cartKeeperState.fillerAddCount,
      cartHasItems: cartKeeperState.cartHasItems
    }
  });
});

// Add filler product
app.post('/api/fillers', async (req, res) => {
  try {
    const { code, color, variantId, url } = req.body;
    
    let productCode = code;
    let productColor = color;
    let productVariantId = variantId;
    
    // If URL is provided, parse it
    if (url) {
      const parsed = parseProductUrl(url);
      if (parsed) {
        productCode = parsed.code;
        productColor = parsed.color;
      }
    }
    
    if (!productCode || !productColor) {
      return res.status(400).json({ error: 'Code and color are required (or provide URL)' });
    }
    
    // Fetch product info
    const { productInfo, sizeMapping, stockInfo } = await fetchProductDetails(productCode, productColor);
    
    // If no variantId provided, find the first in-stock variant
    if (!productVariantId) {
      for (const [vId, stock] of Object.entries(stockInfo)) {
        if (stock > 0) {
          productVariantId = vId;
          break;
        }
      }
    }
    
    if (!productVariantId) {
      return res.status(400).json({ error: 'No in-stock variant found. Please provide a specific variantId.' });
    }
    
    // Check if already exists
    const exists = fillerProducts.find(f => f.variantId === productVariantId);
    if (exists) {
      return res.status(400).json({ error: 'This filler product already exists' });
    }
    
    const filler = {
      code: productCode,
      color: productColor,
      variantId: productVariantId,
      size: sizeMapping[productVariantId]?.size || 'N/A',
      productInfo: {
        title: productInfo.title,
        designer: productInfo.designer,
        price: productInfo.price
      },
      addCount: 0,
      addedAt: new Date().toISOString()
    };
    
    fillerProducts.push(filler);
    saveFillerProducts();
    
    res.json({ 
      success: true, 
      message: `Filler added: ${productInfo.designer} - ${productInfo.title} (${filler.size})`,
      filler 
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Remove filler product
app.delete('/api/fillers/:variantId', (req, res) => {
  const { variantId } = req.params;
  const index = fillerProducts.findIndex(f => f.variantId === variantId);
  
  if (index === -1) {
    return res.status(404).json({ error: 'Filler not found' });
  }
  
  fillerProducts.splice(index, 1);
  saveFillerProducts();
  
  res.json({ success: true, message: 'Filler removed' });
});

// Reset filler add counts
app.post('/api/fillers/reset', (req, res) => {
  fillerProducts.forEach(f => f.addCount = 0);
  cartKeeperState.fillerAddCount = 0;
  cartKeeperState.currentFillerIndex = 0;
  saveFillerProducts();
  saveCartKeeperState();
  
  res.json({ success: true, message: 'Filler counts reset' });
});

// Start/stop cart keeper
app.post('/api/cart-keeper/start', (req, res) => {
  if (fillerProducts.length === 0) {
    return res.status(400).json({ error: 'Add filler products first' });
  }
  startCartKeeper();
  res.json({ success: true, message: 'Cart keeper started' });
});

app.post('/api/cart-keeper/stop', (req, res) => {
  stopCartKeeper();
  res.json({ success: true, message: 'Cart keeper stopped' });
});

// Get cart keeper status
app.get('/api/cart-keeper/status', async (req, res) => {
  try {
    let cartInfo = { remainingMs: 0, hasItems: false };
    try {
      cartInfo = await checkCartReservationTime();
    } catch (e) {
      // Ignore cart check errors
    }
    
    res.json({
      enabled: cartKeeperState.enabled,
      isRunning: !!cartKeeperInterval,
      fillerCount: fillerProducts.length,
      cartHasItems: cartInfo.hasItems,
      remainingMinutes: Math.round(cartInfo.remainingMs / 60000),
      lastCartAddTime: cartKeeperState.lastCartAddTime,
      lastFillerAddTime: cartKeeperState.lastFillerAddTime,
      totalFillersAdded: cartKeeperState.fillerAddCount
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Serve the main page
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/public/index.html');
});

// Health check endpoint for UptimeRobot
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
    tokenAutoRefresh: !!tokenRefreshInterval,
    lastTokenRefresh: lastTokenRefresh ? lastTokenRefresh.toISOString() : null,
    hasRefreshToken: !!CONFIG.refreshToken,
    hasCredentials: !!(CONFIG.email && CONFIG.password),
    hasAccessToken: !!CONFIG.authorization,
    cartKeeper: {
      enabled: cartKeeperState.enabled,
      isRunning: !!cartKeeperInterval,
      fillerCount: fillerProducts.length,
      totalFillersAdded: cartKeeperState.fillerAddCount
    },
    timestamp: new Date().toISOString()
  });
});

// Endpoint to manually trigger full login
app.post('/api/config/login', async (req, res) => {
  try {
    // Allow credentials from request body or use configured ones
    const { email, password } = req.body;
    if (email) CONFIG.email = email;
    if (password) CONFIG.password = password;
    
    if (!CONFIG.email || !CONFIG.password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    console.log(`[${getTimestamp()}] 🔐 Manual login triggered...`);
    
    const tokenData = await performFullLogin();
    
    CONFIG.authorization = `Bearer ${tokenData.access_token}`;
    CONFIG.refreshToken = tokenData.refresh_token;
    lastTokenRefresh = new Date();
    resetTokenExpiredFlag();
    
    // Start token refresh if not already running
    if (!tokenRefreshInterval) {
      startTokenRefresh();
    }
    
    res.json({ 
      success: true, 
      message: 'Login successful! Tokens updated.',
      hasAccessToken: true,
      hasRefreshToken: true
    });
  } catch (error) {
    console.error(`[${getTimestamp()}] 🚫 Manual login failed:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

// Keep-alive ping endpoint (lightweight)
app.get('/ping', (req, res) => {
  res.send('pong');
});

// Store server start time
const serverStartTime = new Date();

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🔍 BestSecret Stock Monitor - Web Interface                 ║
║  Server running on port ${String(PORT).padEnd(37)} ║
║  Started at: ${serverStartTime.toISOString().padEnd(48)} ║
║  Health check: /health or /ping                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  
  // Load persisted data from disk
  const loadedProducts = loadMonitoredProducts();
  const loadedHistory = loadHistory();
  const loadedFillers = loadFillerProducts();
  loadCartKeeperState();
  
  // Start monitoring if products were loaded
  if (loadedProducts > 0) {
    console.log(`🚀 Starting monitoring for ${loadedProducts} restored products`);
    startMonitoring();
  }
  
  // Start cart keeper if it was enabled and fillers exist
  if (cartKeeperState.enabled && loadedFillers > 0) {
    console.log(`🛒 Resuming cart keeper with ${loadedFillers} filler products`);
    startCartKeeper();
  }
  
  // Start automatic token refresh if refresh token OR credentials are configured
  if (CONFIG.refreshToken || (CONFIG.email && CONFIG.password)) {
    startTokenRefresh();
  } else {
    console.log('⚠️ No BESTSECRET_REFRESH_TOKEN or credentials configured - automatic token refresh disabled');
  }
  
  // Log auth status
  console.log(`📧 Email configured: ${CONFIG.email ? 'Yes' : 'No'}`);
  console.log(`🔑 Refresh token configured: ${CONFIG.refreshToken ? 'Yes' : 'No'}`);
  console.log(`🎫 Access token configured: ${CONFIG.authorization ? 'Yes' : 'No'}`);
  console.log(`🛒 Filler products: ${loadedFillers}`);
});
