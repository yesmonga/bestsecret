const express = require('express');
const https = require('https');

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
  clientId: "4oF5TQ5h5AKQCbODiQBBhrwiYf4WxcDy",
  tokenRefreshIntervalMs: 120 * 60 * 1000 // Refresh every 2 hours (token expires in ~2.4 hours)
};

// Token refresh interval reference
let tokenRefreshInterval = null;
let lastTokenRefresh = null;

// Store monitored products
// Structure: { "code-color": { code, color, productInfo, sizeMapping, watchedSizes: Set, previousStock: {}, addedToCart: Set } }
const monitoredProducts = new Map();

// Monitoring interval reference
let monitoringInterval = null;

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
    description: "Le rafraîchissement automatique du token a échoué. Intervention manuelle requise.",
    fields: [
      { name: "❌ Erreur", value: `\`${errorMessage}\``, inline: false },
      { name: "🔧 Action requise", value: "Mettez à jour le refresh_token via l'interface web", inline: false }
    ],
    footer: { text: "BestSecret Monitor" },
    timestamp: new Date().toISOString()
  };

  return sendDiscordWebhook({
    content: "@everyone ❌ **ÉCHEC RAFRAÎCHISSEMENT - INTERVENTION REQUISE!**",
    embeds: [embed]
  });
}

async function performTokenRefresh() {
  console.log(`[${getTimestamp()}] 🔄 Attempting token refresh...`);
  
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
  } catch (error) {
    console.error(`[${getTimestamp()}] ❌ Token refresh failed:`, error.message);
    
    await sendTokenRefreshFailedNotification(error.message);
    
    return false;
  }
}

function startTokenRefresh() {
  if (tokenRefreshInterval) {
    console.log('Token refresh already running');
    return;
  }
  
  if (!CONFIG.refreshToken) {
    console.log('⚠️ No refresh token configured - automatic refresh disabled');
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
              
              const now = new Date();
              const deadline = new Date(now.getTime() + CONFIG.cartReservationMinutes * 60 * 1000);
              const deadlineStr = deadline.toLocaleString('fr-FR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
              });
              
              console.log(`✅ Added to cart! Checkout before: ${deadlineStr}`);
              
              await sendDiscordNotification(product.productInfo, variantId, size, deadlineStr);
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

// Fetch product details (step 1: enter code and color)
app.post('/api/products/fetch', async (req, res) => {
  try {
    const { code, color } = req.body;
    
    if (!code || !color) {
      return res.status(400).json({ error: 'Code and color are required' });
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
  
  res.json({ success: true, message: 'Cart tracking reset' });
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
    timestamp: new Date().toISOString()
  });
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
  
  // Start automatic token refresh if refresh token is configured
  if (CONFIG.refreshToken) {
    startTokenRefresh();
  } else {
    console.log('⚠️ No BESTSECRET_REFRESH_TOKEN configured - automatic token refresh disabled');
  }
});
