/**
 * 천명 · Cheonmyeong — Oracle AI Proxy + Stripe Subscription Worker
 * Deploy: npx wrangler deploy
 *
 * Secrets (set with `npx wrangler secret put <NAME>`):
 *   ANTHROPIC_API_KEY      — Anthropic API key
 *   APP_SECRET             — random string matching ORACLE_APP_SECRET in index.html
 *   APPLE_SHARED_SECRET    — App Store Connect in-app purchase shared secret
 *   STRIPE_WEBHOOK_SECRET  — whsec_... from Stripe webhook destination
 *   STRIPE_SECRET_KEY      — sk_live_... from Stripe dashboard
 *
 * KV Namespace:
 *   SUBSCRIPTIONS          — stores subscription status keyed by email
 */

// ── Stripe Product ID → tier mapping ─────────────────────────────────────────
const STRIPE_PRODUCTS = {
  premium: ['천명 Premium Monthly', '천명 Premium Annual'],
  oracle:  ['천명 Oracle Monthly', '천명 Oracle Annual', '천명 Lifetime'],
};

// Oracle Scroll consumable quantities by product name
const SCROLL_PRODUCTS = {
  '천명 Oracle Scrolls 5':  5,
  '천명 Oracle Scrolls 15': 15,
  '천명 Oracle Scrolls 30': 30,
  '천명 Oracle Scrolls 60': 60,
};

// Apple IAP Product IDs
const APPLE_PRODUCTS = {
  premium: ['com.sageera.cheonmyeong.premium.monthly','com.sageera.cheonmyeong.premium.annual'],
  oracle:  ['com.sageera.cheonmyeong.oracle.monthly','com.sageera.cheonmyeong.oracle.annual','com.sageera.cheonmyeong.lifetime'],
  scroll:  ['com.sageera.cheonmyeong.scrolls.5','com.sageera.cheonmyeong.scrolls.15','com.sageera.cheonmyeong.scrolls.30','com.sageera.cheonmyeong.scrolls.60'],
};

export default {
  async fetch(request, env) {

    // ── CORS preflight ────────────────────────────────────────────────────────
    if (request.method === 'OPTIONS') return corsResponse(null, 204, env);

    const url = new URL(request.url);

    // ── Route: Stripe webhook (no app secret needed — verified by Stripe sig) ─
    if (url.pathname === '/stripe-webhook') {
      return handleStripeWebhook(request, env);
    }

    // ── Route: Check subscription status by email ─────────────────────────────
    if (url.pathname === '/check-subscription') {
      return handleCheckSubscription(request, env);
    }

    // ── All other routes require POST + app secret ────────────────────────────
    if (request.method !== 'POST') {
      return corsResponse({ error: 'Method not allowed' }, 405, env);
    }

    const appSecret = request.headers.get('x-app-secret');
    if (!env.APP_SECRET || appSecret !== env.APP_SECRET) {
      return corsResponse({ error: 'Unauthorized' }, 401, env);
    }

    // ── Route: Oracle AI ──────────────────────────────────────────────────────
    const tier = request.headers.get('x-tier') || 'free';
    if (tier === 'free') {
      return corsResponse({ error: 'Subscription required', code: 'NO_SUB' }, 402, env);
    }

    const receipt = request.headers.get('x-apple-receipt');
    const requireReceipt = env.REQUIRE_RECEIPT === 'true';
    if (requireReceipt && receipt) {
      const valid = await verifyAppleReceipt(receipt, tier, env.APPLE_SHARED_SECRET);
      if (!valid) return corsResponse({ error: 'Receipt invalid', code: 'BAD_RECEIPT' }, 402, env);
    }

    let body;
    try { body = await request.json(); }
    catch { return corsResponse({ error: 'Invalid JSON' }, 400, env); }

    const { system, messages, max_tokens } = body;
    if (!system || !messages?.length) return corsResponse({ error: 'Missing fields' }, 400, env);

    const tokenCap = tier === 'oracle' ? 1200 : 800;
    const tokens = Math.min(max_tokens || 800, tokenCap);

    let anthropicResp;
    try {
      anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: tokens, system, messages }),
      });
    } catch (e) {
      return corsResponse({ error: 'AI service unreachable' }, 502, env);
    }

    if (!anthropicResp.ok) return corsResponse({ error: 'AI error' }, 502, env);
    return corsResponse(await anthropicResp.json(), 200, env);
  },
};

// ── Stripe Webhook Handler ────────────────────────────────────────────────────
async function handleStripeWebhook(request, env) {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const payload = await request.text();
  const sigHeader = request.headers.get('stripe-signature');

  // Verify the webhook signature
  const valid = await verifyStripeSignature(payload, sigHeader, env.STRIPE_WEBHOOK_SECRET);
  if (!valid) {
    console.warn('Invalid Stripe signature');
    return new Response('Unauthorized', { status: 401 });
  }

  const event = JSON.parse(payload);
  console.log('Stripe event:', event.type);

  try {
    switch (event.type) {

      case 'checkout.session.completed': {
        const session = event.data.object;
        const email = session.customer_details?.email || session.customer_email;
        if (!email) break;

        if (session.mode === 'subscription') {
          // Subscription purchase — fetch subscription details
          const sub = await fetchStripe(`/v1/subscriptions/${session.subscription}`, env);
          const tierName = getTierFromStripeItems(sub.items?.data || []);
          if (tierName) {
            await saveSubscription(env, email, {
              tier: tierName,
              status: 'active',
              subscriptionId: sub.id,
              expiresAt: sub.current_period_end * 1000,
              cancelAtPeriodEnd: sub.cancel_at_period_end,
            });
          }
        } else if (session.mode === 'payment') {
          // One-time scroll purchase — expand product to get name reliably
          const lineItems = await fetchStripe(`/v1/checkout/sessions/${session.id}/line_items?expand[]=data.price.product`, env);
          let scrollsToAdd = 0;
          for (const item of lineItems.data || []) {
            // Check multiple fields — Stripe can return the name in different places
            const name = item.price?.product?.name || item.description || '';
            let qty = SCROLL_PRODUCTS[name];
            if (!qty) {
              // Fallback: partial match on key
              for (const [key, val] of Object.entries(SCROLL_PRODUCTS)) {
                if (name.includes(key) || key.includes(name.trim())) { qty = val; break; }
              }
            }
            if (qty) scrollsToAdd += qty * (item.quantity || 1);
          }
          if (scrollsToAdd > 0) {
            const existing = await getSubscription(env, email);
            await saveSubscription(env, email, {
              ...(existing || {}),
              scrollCredits: ((existing?.scrollCredits) || 0) + scrollsToAdd,
            });
          }
        }
        break;
      }

      case 'customer.subscription.updated':
      case 'customer.subscription.pending_update_applied': {
        const sub = event.data.object;
        const email = await getEmailFromCustomer(sub.customer, env);
        if (!email) break;
        const tierName = getTierFromStripeItems(sub.items?.data || []);
        if (tierName) {
          await saveSubscription(env, email, {
            tier: tierName,
            status: sub.status,
            subscriptionId: sub.id,
            expiresAt: sub.current_period_end * 1000,
            cancelAtPeriodEnd: sub.cancel_at_period_end,
          });
        }
        break;
      }

      case 'customer.subscription.deleted': {
        const sub = event.data.object;
        const email = await getEmailFromCustomer(sub.customer, env);
        if (!email) break;
        const existing = await getSubscription(env, email);
        await saveSubscription(env, email, {
          ...(existing || {}),
          tier: 'free',
          status: 'cancelled',
          expiresAt: sub.current_period_end * 1000,
        });
        break;
      }

      case 'invoice.payment_failed': {
        const inv = event.data.object;
        const email = await getEmailFromCustomer(inv.customer, env);
        if (!email) break;
        const existing = await getSubscription(env, email);
        if (existing) {
          await saveSubscription(env, email, { ...existing, status: 'past_due' });
        }
        break;
      }

      case 'customer.subscription.trial_will_end': {
        // Trial ending in 3 days — log it (email reminders handled by Stripe)
        const sub = event.data.object;
        console.log('Trial ending soon for subscription:', sub.id);
        break;
      }
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
    return new Response('Internal error', { status: 500 });
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

// ── Check Subscription by Email ───────────────────────────────────────────────
async function handleCheckSubscription(request, env) {
  if (request.method !== 'POST') return corsResponse({ error: 'Method not allowed' }, 405, env);

  const appSecret = request.headers.get('x-app-secret');
  if (!env.APP_SECRET || appSecret !== env.APP_SECRET) {
    return corsResponse({ error: 'Unauthorized' }, 401, env);
  }

  let body;
  try { body = await request.json(); }
  catch { return corsResponse({ error: 'Invalid JSON' }, 400, env); }

  const { email } = body;
  if (!email) return corsResponse({ error: 'Email required' }, 400, env);

  const sub = await getSubscription(env, email.toLowerCase().trim());
  if (!sub) return corsResponse({ tier: 'free', status: 'none' }, 200, env);

  // Check if subscription has expired
  const now = Date.now();
  if (sub.expiresAt && sub.expiresAt < now && sub.tier !== 'free') {
    return corsResponse({ tier: 'free', status: 'expired', scrollCredits: sub.scrollCredits || 0 }, 200, env);
  }

  return corsResponse({
    tier: sub.tier || 'free',
    status: sub.status || 'active',
    expiresAt: sub.expiresAt,
    cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    scrollCredits: sub.scrollCredits || 0,
  }, 200, env);
}

// ── KV Helpers ────────────────────────────────────────────────────────────────
async function getSubscription(env, email) {
  if (!env.SUBSCRIPTIONS) return null;
  const val = await env.SUBSCRIPTIONS.get(`sub:${email.toLowerCase().trim()}`);
  return val ? JSON.parse(val) : null;
}

async function saveSubscription(env, email, data) {
  if (!env.SUBSCRIPTIONS) return;
  await env.SUBSCRIPTIONS.put(
    `sub:${email.toLowerCase().trim()}`,
    JSON.stringify({ ...data, updatedAt: Date.now() }),
    { expirationTtl: 60 * 60 * 24 * 400 } // 400 days
  );
}

// ── Stripe Helpers ────────────────────────────────────────────────────────────
async function fetchStripe(path, env) {
  const resp = await fetch(`https://api.stripe.com${path}`, {
    headers: { 'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  return resp.json();
}

async function getEmailFromCustomer(customerId, env) {
  const customer = await fetchStripe(`/v1/customers/${customerId}`, env);
  return customer.email || null;
}

function getTierFromStripeItems(items) {
  for (const item of items) {
    const name = item.price?.nickname || item.price?.product?.name || '';
    if (STRIPE_PRODUCTS.oracle.some(p => name.includes(p) || name.includes('Oracle') || name.includes('Lifetime'))) return 'oracle';
    if (STRIPE_PRODUCTS.premium.some(p => name.includes(p) || name.includes('Premium'))) return 'premium';
  }
  return null;
}

// ── Stripe Signature Verification ────────────────────────────────────────────
async function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  try {
    const parts = Object.fromEntries(sigHeader.split(',').map(p => p.split('=')));
    const timestamp = parts.t;
    const signature = parts.v1;
    const signedPayload = `${timestamp}.${payload}`;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
    const hexSig = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
    return hexSig === signature;
  } catch (e) {
    console.error('Signature verification error:', e);
    return false;
  }
}

// ── Apple Receipt Verification ────────────────────────────────────────────────
async function verifyAppleReceipt(receiptData, tier, sharedSecret) {
  if (!sharedSecret) return true;
  const endpoints = ['https://buy.itunes.apple.com/verifyReceipt','https://sandbox.itunes.apple.com/verifyReceipt'];
  const validIds = APPLE_PRODUCTS[tier] || [];
  for (const url of endpoints) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ 'receipt-data': receiptData, 'password': sharedSecret, 'exclude-old-transactions': true }),
      });
      const data = await resp.json();
      if (data.status === 21007) continue;
      if (data.status !== 0) return false;
      const now = Date.now();
      return (data.latest_receipt_info || []).some(r => {
        if (!validIds.includes(r.product_id)) return false;
        const expiry = parseInt(r.expires_date_ms || '0', 10);
        return expiry > 0 ? expiry > now : true;
      });
    } catch (e) { console.error('Receipt error:', e); }
  }
  return false;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
function corsHeaders(env) {
  return {
    'Access-Control-Allow-Origin': (env?.ALLOWED_ORIGIN) || '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type, x-app-secret, x-tier, x-apple-receipt',
    'Access-Control-Max-Age': '86400',
  };
}

function corsResponse(body, status, env) {
  return new Response(
    body !== null ? JSON.stringify(body) : null,
    { status, headers: { ...corsHeaders(env), 'content-type': 'application/json' } }
  );
}
