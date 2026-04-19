/**
 * 천명 · Cheonmyeong — Oracle AI Proxy Worker
 * Deploy to Cloudflare Workers
 *
 * Required environment secrets (set with `wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY    — your Anthropic API key
 *   APP_SECRET           — a random string you choose (must match the app)
 *   APPLE_SHARED_SECRET  — App Store Connect → App → In-App Purchases → App-Specific Shared Secret
 *
 * Optional env var (set in wrangler.toml [vars]):
 *   REQUIRE_RECEIPT = "true"   — enforce Apple receipt verification (set after going live)
 */

// Apple IAP Product IDs — must match App Store Connect exactly
const PRODUCTS = {
  premium: [
    'com.sageera.cheonmyeong.premium.monthly',
    'com.sageera.cheonmyeong.premium.annual',
  ],
  oracle: [
    'com.sageera.cheonmyeong.oracle.monthly',
    'com.sageera.cheonmyeong.oracle.annual',
    'com.sageera.cheonmyeong.lifetime',
  ],
  scroll: [
    'com.sageera.cheonmyeong.scrolls.5',
    'com.sageera.cheonmyeong.scrolls.15',
    'com.sageera.cheonmyeong.scrolls.30',
    'com.sageera.cheonmyeong.scrolls.60',
  ],
};

const ALL_PAID_IDS = [...PRODUCTS.premium, ...PRODUCTS.oracle, ...PRODUCTS.scroll];

export default {
  async fetch(request, env) {

    // ── CORS preflight ────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204, env);
    }

    if (request.method !== 'POST') {
      return corsResponse({ error: 'Method not allowed' }, 405, env);
    }

    // ── 1. Verify App Secret ──────────────────────────────────────────────
    const appSecret = request.headers.get('x-app-secret');
    if (!env.APP_SECRET || appSecret !== env.APP_SECRET) {
      console.warn('Rejected: bad app secret');
      return corsResponse({ error: 'Unauthorized' }, 401, env);
    }

    // ── 2. Check subscription tier ────────────────────────────────────────
    const tier = request.headers.get('x-tier') || 'free';
    if (tier === 'free') {
      return corsResponse({ error: 'Subscription required', code: 'NO_SUB' }, 402, env);
    }

    // ── 3. Apple Receipt Verification ────────────────────────────────────
    // When REQUIRE_RECEIPT=true (set this after App Store launch), every
    // paid request must include a valid Apple receipt.
    const receipt = request.headers.get('x-apple-receipt');
    const requireReceipt = env.REQUIRE_RECEIPT === 'true';

    if (requireReceipt) {
      if (!receipt) {
        return corsResponse({ error: 'Receipt required', code: 'NO_RECEIPT' }, 402, env);
      }
      const valid = await verifyAppleReceipt(receipt, tier, env.APPLE_SHARED_SECRET);
      if (!valid) {
        console.warn('Rejected: invalid Apple receipt for tier', tier);
        return corsResponse({ error: 'Receipt invalid or expired', code: 'BAD_RECEIPT' }, 402, env);
      }
    }

    // ── 4. Parse request body ─────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch (e) {
      return corsResponse({ error: 'Invalid JSON body' }, 400, env);
    }

    const { system, messages, max_tokens } = body;

    if (!system || !messages || !Array.isArray(messages) || messages.length === 0) {
      return corsResponse({ error: 'Missing system or messages' }, 400, env);
    }

    // Cap tokens by tier
    const tokenCap = tier === 'oracle' ? 1200 : 800;
    const tokens = Math.min(max_tokens || 800, tokenCap);

    // ── 5. Call Anthropic ─────────────────────────────────────────────────
    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: tokens,
          system,
          messages,
        }),
      });
    } catch (e) {
      console.error('Anthropic fetch error:', e);
      return corsResponse({ error: 'AI service unreachable' }, 502, env);
    }

    if (!anthropicResp.ok) {
      const err = await anthropicResp.json().catch(() => ({}));
      console.error('Anthropic error:', anthropicResp.status, err);
      return corsResponse({ error: 'AI service error', status: anthropicResp.status }, 502, env);
    }

    const data = await anthropicResp.json();
    return corsResponse(data, 200, env);
  },
};

/**
 * Verify an Apple receipt against Apple's servers.
 * Tries production first; if Apple returns 21007 (sandbox receipt on prod), retries sandbox.
 * Returns true if receipt contains a valid, non-expired purchase for the given tier.
 */
async function verifyAppleReceipt(receiptData, tier, sharedSecret) {
  if (!sharedSecret) {
    console.warn('APPLE_SHARED_SECRET not set — skipping receipt verification');
    return true; // fail-open if secret not configured yet
  }

  const endpoints = [
    'https://buy.itunes.apple.com/verifyReceipt',
    'https://sandbox.itunes.apple.com/verifyReceipt',
  ];

  const validProductIds = PRODUCTS[tier] || ALL_PAID_IDS;

  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          'receipt-data': receiptData,
          'password': sharedSecret,
          'exclude-old-transactions': true,
        }),
      });

      const data = await resp.json();

      // 21007 = sandbox receipt sent to production — retry with sandbox
      if (data.status === 21007) continue;

      // Any non-zero status is an error
      if (data.status !== 0) {
        console.warn('Apple receipt status:', data.status);
        return false;
      }

      const now = Date.now();
      const receipts = data.latest_receipt_info || [];

      return receipts.some(r => {
        if (!validProductIds.includes(r.product_id)) return false;
        // Subscriptions have expiry; lifetime purchases do not
        const expiry = parseInt(r.expires_date_ms || '0', 10);
        if (expiry > 0) return expiry > now;
        return true; // one-time purchase (lifetime)
      });

    } catch (e) {
      console.error('Receipt verification exception:', e);
    }
  }

  return false;
}

function corsHeaders(env) {
  // In production you can lock this to your app's domain
  const origin = (env && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-secret, x-tier, x-apple-receipt',
    'Access-Control-Max-Age': '86400',
  };
}

function corsResponse(body, status, env) {
  return new Response(
    body !== null ? JSON.stringify(body) : null,
    {
      status,
      headers: {
        ...corsHeaders(env),
        'content-type': 'application/json',
      },
    }
  );
}
