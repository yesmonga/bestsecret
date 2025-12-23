const https = require('https');

// Configuration
const CONFIG = {
  code: "40444581",
  color: "000703715",
  checkIntervalMs: 60 * 1000, // 1 minute
  discordWebhook: "https://discord.com/api/webhooks/1452815636106579988/VlYTWRTCvdD9rqBkx4d2ZPw1rTVfeBbE5yTAUHU_jtKJAbIbWB5lXBfKuP_G2nkfFvp7",
  checkoutUrl: "https://www.bestsecret.com/cart.htm",
  cartReservationMinutes: 20,
  authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6IkFKRVZXaXdTd2RXdFlmWEJQXzctSSJ9.eyJodHRwczovL2Jlc3RzZWNyZXQuY29tL2N1c3RvbWVySWQiOiIyNDM1MjAyNDYtMDcyODQ4IiwiaHR0cHM6Ly9iZXN0c2VjcmV0LmNvbS92aXBTdGF0dXMiOiJTVEFUVVNfR1JPVVBfQkFTSUMiLCJodHRwczovL2Jlc3RzZWNyZXQuY29tL2NvdW50cnkiOiJmciIsImh0dHBzOi8vYmVzdHNlY3JldC5jb20vc2FsdGVkSGFzaGVkQWNjb3VudElkIjoiOWJjNjVkMTk5N2E3YzIyODVkZjc2YmMwM2MyMGVkOWI2OTI0M2UzNzIwODc1MDk1OGYwMzAyODFmZWQ3OGEyMyIsImlzcyI6Imh0dHBzOi8vbG9naW4uYmVzdHNlY3JldC5jb20vIiwic3ViIjoiYXV0aDB8YnNjdXN0b21lcnN8MjQzNTIwMjQ2LTA3Mjg0OCIsImF1ZCI6WyJodHRwczovL3d3dy5iZXN0c2VjcmV0LmNvbS92MSIsImh0dHBzOi8vd2ViLWFjYi1wcm9kLTVjMmEuZXUuYXV0aDAuY29tL3VzZXJpbmZvIl0sImlhdCI6MTc2NjQ0NjM1OSwiZXhwIjoxNzY2NDU0OTU5LCJzY29wZSI6Im9wZW5pZCBlbWFpbCBvZmZsaW5lX2FjY2VzcyIsImF6cCI6IjRvRjVUUTVoNUFLUUNiT0RpUUJCaHJ3aVlmNFd4Y0R5In0.KYICsjfQfdHw4GaaoKB9ZwOo5gRIQX4nrxdK84ms4liMwh-Tud9a89F8gaEbhbqacZHBN1sAEdhnGO0YI3bBqgzOCTsx0P6WIiFFtpeACCFSHoBRxiGrD6R-0DKB8q7Uh7oj3BiXnJ1ESKlarBs03DNu0dWq9hyfR0ZQUBKOrPYh4l2XJ3S2E8w3gQA9reTM3WnLYhldfkv6Wtx3SyzenpcstDakeLMVrwhv41HN8yGlBILXXsU6x5-efU4MPQGsyoOl_RS5AzR4jz66z2bDcqX2aKRsmVVrM-s2hvonsqCA7G6EukRVQRkQU3SUgLDvHcm7ddfyPpQuuo-tOvXRKQ"
};

// Store previous stock state to detect changes
let previousStock = {};

// Track items already added to cart to avoid duplicates
const addedToCart = new Set();

// Mapping variantId -> size info (fetched from product details)
let sizeMapping = {};

// Product info
let productInfo = null;

const productDetailQuery = {
  operationName: "ProductDetailAndStock",
  query: `query ProductDetailAndStock($code: String!, $color: String!) { product(code: $code, color: $color) { __typename ...ProductDetailFragment } stock { __typename styleArticleStocks(genericArticleId: $code, styleCode: $color) { __typename ...StockInformationFragment } } }
fragment ProductDetailFragment on PdpProductDetail { __typename productTitle designer { __typename name } style { __typename primaryColor { __typename name } } variants { __typename code size { __typename sizeText vendorSize } } price { __typename primary { __typename salesPrice { __typename formatted } recommendedRetailPrice { __typename formatted } relativeDiscount { __typename formatted } } } }
fragment StockInformationFragment on VariantArticleStock { __typename variantArticleId unreservedStock }`,
  variables: {
    code: CONFIG.code,
    color: CONFIG.color
  }
};

const graphqlQuery = {
  operationName: "StockWithCodeAndColor",
  query: `query StockWithCodeAndColor($code: String!, $color: String!) { stock { __typename styleArticleStocks(genericArticleId: $code, styleCode: $color) { __typename ...StockInformationFragment } } }
fragment StockInformationFragment on VariantArticleStock { __typename variantArticleId unreservedStock }`,
  variables: {
    code: CONFIG.code,
    color: CONFIG.color
  }
};

function makeRequest(query, operationType, callback) {
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
      try {
        const response = JSON.parse(data);
        callback(null, response);
      } catch (error) {
        callback(error, data);
      }
    });
  });

  req.on('error', (error) => { callback(error, null); });
  req.write(postData);
  req.end();
}

function fetchProductDetails(callback) {
  console.log('📋 Récupération des détails produit...');
  
  makeRequest(productDetailQuery, 'query', (error, response) => {
    if (error) {
      console.error(`[${getTimestamp()}] ❌ Erreur récupération produit:`, error.message);
      callback(error);
      return;
    }

    if (!response.data?.product) {
      console.error(`[${getTimestamp()}] ❌ Réponse produit invalide:`, JSON.stringify(response));
      callback(new Error('Invalid product response'));
      return;
    }

    const product = response.data.product;
    productInfo = {
      title: product.productTitle,
      designer: product.designer?.name,
      color: product.style?.primaryColor?.name,
      price: product.price?.primary?.salesPrice?.formatted,
      originalPrice: product.price?.primary?.recommendedRetailPrice?.formatted,
      discount: product.price?.primary?.relativeDiscount?.formatted
    };

    // Build size mapping
    sizeMapping = {};
    product.variants.forEach(variant => {
      sizeMapping[variant.code] = {
        size: variant.size?.sizeText || 'N/A',
        vendorSize: variant.size?.vendorSize
      };
    });

    console.log(`
╔══════════════════════════════════════════════════════════════╗
║  📦 PRODUIT TROUVÉ                                           ║
╠══════════════════════════════════════════════════════════════╣
║  ${(productInfo.designer + ' - ' + productInfo.title).substring(0, 60).padEnd(60)} ║
║  Couleur: ${productInfo.color.padEnd(51)} ║
║  Prix: ${(productInfo.price + ' (au lieu de ' + productInfo.originalPrice + ')').padEnd(54)} ║
║  Réduction: ${productInfo.discount.padEnd(49)} ║
╠══════════════════════════════════════════════════════════════╣
║  TAILLES DISPONIBLES:                                        ║`);

    Object.entries(sizeMapping).forEach(([code, info]) => {
      console.log(`║    ${code} → ${info.size.padEnd(48)} ║`);
    });
    
    console.log(`╚══════════════════════════════════════════════════════════════╝\n`);

    // Also process initial stock from this response
    if (response.data?.stock?.styleArticleStocks) {
      processStockData(response, true);
    }

    callback(null);
  });
}

function checkStock() {
  const postData = JSON.stringify(graphqlQuery);

  makeRequest(graphqlQuery, 'query', (error, response) => {
    if (error) {
      console.error(`[${getTimestamp()}] ❌ Erreur requête stock:`, error.message);
      return;
    }
    processStockData(response, false);
  });
}

function getSizeLabel(variantId) {
  const info = sizeMapping[variantId];
  return info ? info.size : '?';
}

function processStockData(response, isInitial) {
  const timestamp = getTimestamp();
  
  if (!response.data?.stock?.styleArticleStocks) {
    console.error(`[${timestamp}] ❌ Réponse invalide:`, JSON.stringify(response));
    return;
  }

  const stocks = response.data.stock.styleArticleStocks;
  const currentStock = {};
  
  console.log(`\n[${timestamp}] 📦 Vérification du stock:`);
  console.log('─'.repeat(60));

  stocks.forEach(item => {
    const variantId = item.variantArticleId;
    const stock = item.unreservedStock;
    const size = getSizeLabel(variantId);
    currentStock[variantId] = stock;

    const prevStock = previousStock[variantId];
    const stockStatus = stock > 0 ? '✅ EN STOCK' : '❌ Rupture';
    const sizeDisplay = `[${size}]`.padEnd(6);
    
    // Detect stock changes (skip on initial load)
    if (!isInitial && prevStock !== undefined && prevStock !== stock) {
      if (prevStock === 0 && stock > 0) {
        // New stock available!
        console.log(`🚨🚨🚨 ALERTE! ${sizeDisplay} ${variantId}: NOUVEAU STOCK! (${stock} unités) 🚨🚨🚨`);
        notifyNewStock(variantId, stock, size);
      } else if (prevStock > 0 && stock === 0) {
        console.log(`⚠️  ${sizeDisplay} ${variantId}: Stock épuisé (était: ${prevStock})`);
      } else {
        console.log(`📊 ${sizeDisplay} ${variantId}: Stock changé ${prevStock} → ${stock}`);
      }
    } else {
      console.log(`   ${sizeDisplay} ${variantId}: ${String(stock).padStart(3)} unités ${stockStatus}`);
    }
  });

  previousStock = currentStock;
  console.log('─'.repeat(60));
}

function notifyNewStock(variantId, quantity, size) {
  // Sound notification (terminal bell)
  process.stdout.write('\x07');
  
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🎉 NOUVELLE TAILLE DISPONIBLE!                              ║
╠══════════════════════════════════════════════════════════════╣
║  Taille: ${size.padEnd(53)} ║
║  Article: ${variantId.padEnd(52)} ║
║  Quantité: ${String(quantity).padEnd(51)} ║
║  Heure: ${getTimestamp().padEnd(54)} ║
╚══════════════════════════════════════════════════════════════╝
`);

  // Auto add to cart
  addToCart(variantId, size);
}

function addToCart(productCode, size) {
  if (addedToCart.has(productCode)) {
    console.log(`⏭️  ${productCode} (${size}) déjà ajouté au panier, on skip.`);
    return;
  }

  const addToCartQuery = {
    operationName: "AddToCart",
    query: "mutation AddToCart($productCode: String!) { addToCart(productCode: $productCode) { __typename informationFromUpdate { __typename content } response } }",
    variables: {
      productCode: productCode
    }
  };

  console.log(`🛒 Ajout au panier de ${productCode} (taille ${size})...`);

  makeRequest(addToCartQuery, 'mutation', (error, response) => {
    if (error) {
      console.error(`[${getTimestamp()}] ❌ Erreur requête panier:`, error.message);
      return;
    }

    if (response.data?.addToCart?.response === 'SUCCESS') {
      addedToCart.add(productCode);
      const now = new Date();
      const checkoutDeadline = new Date(now.getTime() + CONFIG.cartReservationMinutes * 60 * 1000);
      const deadlineStr = checkoutDeadline.toLocaleString('fr-FR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      
      console.log(`
╔══════════════════════════════════════════════════════════════╗
║  ✅ AJOUTÉ AU PANIER AVEC SUCCÈS!                            ║
╠══════════════════════════════════════════════════════════════╣
║  Taille: ${size.padEnd(53)} ║
║  Article: ${productCode.padEnd(52)} ║
║  Heure: ${getTimestamp().padEnd(54)} ║
║  ⏰ Checkout avant: ${deadlineStr.padEnd(43)} ║
╚══════════════════════════════════════════════════════════════╝
`);
      process.stdout.write('\x07\x07\x07'); // Triple beep!
      
      // Send Discord notification
      sendDiscordNotification(productCode, size, deadlineStr);
    } else {
      console.error(`[${getTimestamp()}] ❌ Échec ajout panier:`, JSON.stringify(response));
    }
  });
}

function getTimestamp() {
  return new Date().toLocaleString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

function sendDiscordNotification(productCode, size, deadlineStr) {
  const webhookUrl = new URL(CONFIG.discordWebhook);
  
  const embed = {
    title: "🚨 ARTICLE AJOUTÉ AU PANIER!",
    color: 0x00ff00, // Green
    fields: [
      {
        name: "👕 Produit",
        value: `**${productInfo.designer} - ${productInfo.title}**`,
        inline: false
      },
      {
        name: "🎨 Couleur",
        value: productInfo.color,
        inline: true
      },
      {
        name: "📏 Taille",
        value: `**${size}**`,
        inline: true
      },
      {
        name: "💰 Prix",
        value: `${productInfo.price} (${productInfo.discount})`,
        inline: true
      },
      {
        name: "⏰ CHECKOUT AVANT",
        value: `**${deadlineStr}**`,
        inline: false
      },
      {
        name: "🛒 Lien Checkout",
        value: `[Aller au panier](${CONFIG.checkoutUrl})`,
        inline: false
      }
    ],
    footer: {
      text: `Article: ${productCode}`
    },
    timestamp: new Date().toISOString()
  };

  const payload = JSON.stringify({
    content: "@everyone 🚨 **NOUVEAU STOCK DISPONIBLE - CHECKOUT MAINTENANT!**",
    embeds: [embed]
  });

  const options = {
    hostname: webhookUrl.hostname,
    port: 443,
    path: webhookUrl.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  console.log('📤 Envoi notification Discord...');

  const req = https.request(options, (res) => {
    if (res.statusCode === 204 || res.statusCode === 200) {
      console.log('✅ Notification Discord envoyée!');
    } else {
      console.error(`❌ Discord webhook erreur: ${res.statusCode}`);
    }
  });

  req.on('error', (error) => {
    console.error('❌ Erreur envoi Discord:', error.message);
  });

  req.write(payload);
  req.end();
}

// Main
console.log(`
╔══════════════════════════════════════════════════════════════╗
║  🔍 BestSecret Stock Monitor                                 ║
║  Article: ${CONFIG.code.padEnd(52)} ║
║  Couleur: ${CONFIG.color.padEnd(52)} ║
║  Intervalle: ${(CONFIG.checkIntervalMs / 1000 + ' secondes').padEnd(49)} ║
╚══════════════════════════════════════════════════════════════╝
`);

console.log('Démarrage du monitoring...\n');

// First fetch product details to get size mapping, then start monitoring
fetchProductDetails((error) => {
  if (error) {
    console.error('❌ Impossible de récupérer les détails produit. Arrêt.');
    process.exit(1);
  }

  // Schedule periodic checks (first check already done in fetchProductDetails)
  setInterval(checkStock, CONFIG.checkIntervalMs);
  
  console.log('\n⏰ Monitoring actif. Appuyez sur Ctrl+C pour arrêter.\n');
});
