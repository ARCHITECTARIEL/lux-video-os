import Stripe from 'stripe';

const DEFAULT_STRIPE_ACCOUNT = 'acct_1CW7vBJL3SekJtVV';

const PACKAGES = [
  {
    packageId: 'credits_500',
    credits: 500,
    name: 'LUX Video OS - Starter Pack (500 Credits)',
    description: '500 rendering credits for LUX Video OS (up to 5 Standard or Premium AI video renders).',
    amountCents: 3000, // $30.00
    envVar: 'STRIPE_PRICE_ID_500',
  },
  {
    packageId: 'credits_1000',
    credits: 1000,
    name: 'LUX Video OS - Growth Pack (1,000 Credits)',
    description: '1,000 rendering credits for LUX Video OS (up to 11 Standard or Premium AI video renders).',
    amountCents: 4800, // $48.00
    envVar: 'STRIPE_PRICE_ID_1000',
  },
  {
    packageId: 'credits_2000',
    credits: 2000,
    name: 'LUX Video OS - Studio Pack (2,000 Credits)',
    description: '2,000 rendering credits for LUX Video OS (up to 22 Standard or Premium AI video renders).',
    amountCents: 9600, // $96.00
    envVar: 'STRIPE_PRICE_ID_2000',
  },
];

async function main() {
  const apiKey = String(process.env.STRIPE_SECRET_KEY || '').trim();
  const accountId = String(process.env.STRIPE_ACCOUNT_ID || DEFAULT_STRIPE_ACCOUNT).trim();

  if (!apiKey) {
    console.error('----------------------------------------------------------------');
    console.error('ERROR: STRIPE_SECRET_KEY environment variable is not set.');
    console.error('Please run:');
    console.error('  $env:STRIPE_SECRET_KEY="sk_live_..." (or sk_test_...)');
    console.error('  node tools/setup-stripe-products.mjs');
    console.error('----------------------------------------------------------------');
    process.exit(1);
  }

  const isLive = apiKey.startsWith('sk_live_') || apiKey.startsWith('rk_live_');
  console.log(`[stripe-setup] Initializing Stripe client (${isLive ? 'LIVE' : 'TEST'} mode)...`);
  console.log(`[stripe-setup] Target account: ${accountId}`);

  // Create Stripe client with optional stripeAccount header if operating via platform or direct
  const stripeOptions = {};
  // If the key is a platform key, stripeAccount routes it to the connected account.
  // If the key is already specific to the account, stripeAccount is ignored or direct.
  const stripe = new Stripe(apiKey, stripeOptions);

  const priceResults = {};

  for (const pack of PACKAGES) {
    console.log(`\n[stripe-setup] Processing ${pack.name}...`);

    // 1. Search for existing product with matching metadata
    const products = await stripe.products.search({
      query: `metadata['packageId']:'${pack.packageId}' AND active:'true'`,
    }).catch(async () => {
      // Fallback to list search if search index is not yet populated
      const list = await stripe.products.list({ limit: 50, active: true });
      return { data: list.data.filter((p) => p.metadata?.packageId === pack.packageId || p.name === pack.name) };
    });

    let product = products.data?.[0];
    if (!product) {
      console.log(`  Creating new product for ${pack.packageId}...`);
      product = await stripe.products.create({
        name: pack.name,
        description: pack.description,
        metadata: {
          packageId: pack.packageId,
          credits: String(pack.credits),
          platform: 'lux-video-os',
        },
      });
      console.log(`  Created Product ID: ${product.id}`);
    } else {
      console.log(`  Found existing Product ID: ${product.id}`);
    }

    // 2. Search for existing matching price
    const existingPrices = await stripe.prices.list({
      product: product.id,
      active: true,
      currency: 'usd',
    });

    let price = existingPrices.data.find(
      (p) => p.unit_amount === pack.amountCents && p.type === 'one_time'
    );

    if (!price) {
      console.log(`  Creating one-time Price of $${(pack.amountCents / 100).toFixed(2)} USD...`);
      price = await stripe.prices.create({
        product: product.id,
        unit_amount: pack.amountCents,
        currency: 'usd',
        metadata: {
          packageId: pack.packageId,
          credits: String(pack.credits),
        },
      });
      console.log(`  Created Price ID: ${price.id}`);
    } else {
      console.log(`  Found existing Price ID: ${price.id}`);
    }

    priceResults[pack.envVar] = price.id;
  }

  console.log('\n================================================================');
  console.log('                 STRIPE CONFIGURATION SUMMARY                    ');
  console.log('================================================================');
  console.log('Copy and paste these environment variables into your Vercel Production');
  console.log('and Local environment settings:');
  console.log('----------------------------------------------------------------');
  console.log(`STRIPE_PRICE_ID_500=${priceResults.STRIPE_PRICE_ID_500}`);
  console.log(`STRIPE_PRICE_ID_1000=${priceResults.STRIPE_PRICE_ID_1000}`);
  console.log(`STRIPE_PRICE_ID_2000=${priceResults.STRIPE_PRICE_ID_2000}`);
  console.log(`STRIPE_EXPECT_LIVEMODE=${isLive ? 'true' : 'false'}`);
  console.log(`VIDEO_OS_BILLING_ENABLED=true`);
  console.log('----------------------------------------------------------------');
  console.log('Webhook Endpoint to configure in Stripe Dashboard:');
  console.log('  URL: https://lux-video-os.vercel.app/api/video-os-lite/stripe-webhook');
  console.log('  Events to listen to: checkout.session.completed');
  console.log('  Signing secret from webhook will become: STRIPE_WEBHOOK_SECRET=whsec_...');
  console.log('================================================================\n');
}

main().catch((err) => {
  console.error('[stripe-setup] Failed:', err);
  process.exit(1);
});
