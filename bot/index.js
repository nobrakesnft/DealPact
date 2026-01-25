// Load environment variables
require('dotenv').config();

// Import dependencies
const { Bot } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

// Initialize Supabase
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// Initialize blockchain connection
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

// Contract ABI
const ESCROW_ABI = [
  "function createDeal(string calldata _externalId, address _seller, address _buyer, uint256 _amount) external returns (uint256)",
  "function getDealByExternalId(string calldata _externalId) external view returns (tuple(string externalId, address seller, address buyer, uint256 amount, uint8 status, uint256 createdAt, uint256 completedAt))",
  "function externalIdToDealId(string calldata) external view returns (uint256)",
  "function deals(uint256) external view returns (string, address, address, uint256, uint8, uint256, uint256)",
  "function dispute(uint256 _dealId) external",
  "function resolveRelease(uint256 _dealId) external",
  "function refund(uint256 _dealId) external",
  "event DealFunded(uint256 indexed dealId, address buyer, uint256 amount)",
  "event DealCompleted(uint256 indexed dealId, address seller, uint256 amount, uint256 fee)"
];

const escrowContract = new ethers.Contract(CONTRACT_ADDRESS, ESCROW_ABI, wallet);

// Create bot instance
const bot = new Bot(process.env.BOT_TOKEN);

// Admin usernames (comma-separated in env)
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'nobrakesnft').toLowerCase().split(',');

// Generate short deal ID (e.g., "TL-A7X9")
function generateDealId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `TL-${code}`;
}

// Validate Ethereum address
function isValidAddress(address) {
  return ethers.isAddress(address);
}

// /start command
bot.command('start', async (ctx) => {
  await ctx.reply(`
Welcome to TrustLock!

Secure crypto escrow on Base.

How it works:
1. Register wallet: /wallet 0x...
2. Seller creates deal: /new @buyer amount description
3. Buyer deposits USDC
4. Seller delivers
5. Buyer releases funds

Commands:
/wallet 0x... - Register wallet
/new @buyer 50 Logo - Create deal
/fund TL-XXXX - Fund deal
/status TL-XXXX - Check status
/deals - Your deals
/release TL-XXXX - Release funds
/dispute TL-XXXX reason - Open dispute
/help - More help

Network: Base Sepolia (Testnet)
  `);
});

// /help command
bot.command('help', async (ctx) => {
  await ctx.reply(`
TrustLock Help

SETUP
/wallet 0x... - Register your wallet

DEALS
/new @buyer 100 desc - Create escrow
/fund TL-XXXX - Get deposit link
/status TL-XXXX - Check deal
/deals - View your deals
/release TL-XXXX - Release funds
/cancel TL-XXXX - Cancel deal

DISPUTES
/dispute TL-XXXX reason - Open dispute
/evidence TL-XXXX msg - Submit evidence
/viewevidence TL-XXXX - View evidence
/canceldispute TL-XXXX - Cancel dispute

FLOW
1. Seller: /new @buyer 50 Logo
2. Buyer: /fund TL-XXXX
3. Seller delivers
4. Buyer: /release TL-XXXX

Web: nobrakesnft.github.io/TrustLock
  `);
});

// /wallet command
bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'Anonymous';
  const text = ctx.message.text;
  const match = text.match(/^\/wallet\s+(0x[a-fA-F0-9]{40})$/i);

  if (!match) {
    const { data: user } = await supabase
      .from('users')
      .select('wallet_address')
      .eq('telegram_id', userId)
      .single();

    if (user?.wallet_address) {
      await ctx.reply(`Your wallet: ${user.wallet_address}\n\nTo change: /wallet 0xNewAddress`);
    } else {
      await ctx.reply('Register wallet:\n/wallet 0xYourAddress');
    }
    return;
  }

  const walletAddress = match[1];

  if (!isValidAddress(walletAddress)) {
    await ctx.reply('Invalid wallet address.');
    return;
  }

  const { error } = await supabase
    .from('users')
    .upsert({
      telegram_id: userId,
      username: username,
      wallet_address: walletAddress.toLowerCase()
    }, { onConflict: 'telegram_id' });

  if (error) {
    await ctx.reply('Failed to save wallet. Try again.');
    return;
  }

  await ctx.reply(`✅ Wallet registered!\n\nAddress: ${walletAddress}\nNetwork: Base Sepolia`);
});

// /new command - Create deal
bot.command('new', async (ctx) => {
  const senderId = ctx.from.id;
  const senderUsername = ctx.from.username || 'Anonymous';
  const text = ctx.message.text;
  const match = text.match(/^\/new\s+@(\w+)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);

  if (!match) {
    await ctx.reply('Format: /new @buyer amount description\nExample: /new @john 50 Logo design');
    return;
  }

  const buyerUsername = match[1];
  const amount = parseFloat(match[2]);
  const description = match[3].trim();

  if (amount < 1 || amount > 500) {
    await ctx.reply('Amount must be 1-500 USDC.');
    return;
  }

  if (buyerUsername.toLowerCase() === senderUsername.toLowerCase()) {
    await ctx.reply("Can't create deal with yourself.");
    return;
  }

  const { data: seller } = await supabase
    .from('users')
    .select('wallet_address')
    .eq('telegram_id', senderId)
    .single();

  if (!seller?.wallet_address) {
    await ctx.reply('Register wallet first: /wallet 0xYourAddress');
    return;
  }

  const dealId = generateDealId();

  const { error } = await supabase.from('deals').insert({
    deal_id: dealId,
    seller_telegram_id: senderId,
    seller_username: senderUsername,
    buyer_telegram_id: 0,
    buyer_username: buyerUsername,
    amount: amount,
    description: description,
    status: 'pending_deposit'
  });

  if (error) {
    await ctx.reply('Failed to create deal. Try again.');
    return;
  }

  await ctx.reply(`
✅ Deal Created!

ID: ${dealId}
Seller: @${senderUsername}
Buyer: @${buyerUsername}
Amount: ${amount} USDC
Desc: ${description}

@${buyerUsername} - To fund:
1. /wallet 0xYourAddress
2. /fund ${dealId}
  `);
});

// /status command
bot.command('status', async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(/^\/status\s+(TL-\w+)$/i);

  if (!match) {
    await ctx.reply('Usage: /status TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();

  const { data: deal } = await supabase
    .from('deals')
    .select('*')
    .eq('deal_id', dealId)
    .single();

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  const emoji = {
    'pending_deposit': '⏳',
    'funded': '💰',
    'completed': '✅',
    'disputed': '⚠️',
    'cancelled': '❌',
    'refunded': '↩️'
  }[deal.status] || '❓';

  await ctx.reply(`
${emoji} ${deal.deal_id}

Status: ${deal.status.replace('_', ' ')}
Seller: @${deal.seller_username}
Buyer: @${deal.buyer_username}
Amount: ${deal.amount} USDC
Desc: ${deal.description}
  `);
});

// /deals command
bot.command('deals', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { data } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_telegram_id.eq.${userId},buyer_username.eq.${username}`)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!data || data.length === 0) {
    await ctx.reply('No deals found. Create one: /new');
    return;
  }

  let message = 'Your Deals:\n\n';
  for (const deal of data) {
    const role = deal.seller_telegram_id === userId ? 'S' : 'B';
    const emoji = { 'pending_deposit': '⏳', 'funded': '💰', 'completed': '✅', 'disputed': '⚠️', 'cancelled': '❌', 'refunded': '↩️' }[deal.status] || '❓';
    message += `${emoji} ${deal.deal_id} | ${deal.amount} USDC | ${role}\n`;
  }
  message += '\n/status TL-XXXX for details';

  await ctx.reply(message);
});

// /release command
bot.command('release', async (ctx) => {
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/release\s+(TL-\w+)(?:\s+(confirm))?$/i);

  if (!match) {
    await ctx.reply('Usage: /release TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();
  const forceConfirm = match[2]?.toLowerCase() === 'confirm';

  const { data: deal } = await supabase
    .from('deals')
    .select('*')
    .eq('deal_id', dealId)
    .single();

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) {
    await ctx.reply('Only buyer can release.');
    return;
  }

  if (deal.status === 'disputed' && !forceConfirm) {
    await ctx.reply(`Deal is disputed. To release anyway:\n/release ${dealId} confirm`);
    return;
  } else if (deal.status !== 'funded' && deal.status !== 'disputed') {
    await ctx.reply(`Cannot release. Status: ${deal.status}`);
    return;
  }

  const releaseLink = `https://nobrakesnft.github.io/TrustLock?deal=${dealId}&action=release`;

  await ctx.reply(`
📤 Release Funds

Deal: ${dealId}
Amount: ${deal.amount} USDC

👇 TAP TO RELEASE:
${releaseLink}

Connect wallet & confirm transaction.
  `);
});

// /cancel command
bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/cancel\s+(TL-\w+)$/i);

  if (!match) {
    await ctx.reply('Usage: /cancel TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();

  const { data: deal } = await supabase
    .from('deals')
    .select('*')
    .eq('deal_id', dealId)
    .single();

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();

  if (!isSeller && !isBuyer) {
    await ctx.reply('Not your deal.');
    return;
  }

  if (!['pending_deposit', 'funded'].includes(deal.status)) {
    await ctx.reply(`Cannot cancel. Status: ${deal.status}`);
    return;
  }

  await supabase.from('deals').update({ status: 'cancelled' }).eq('deal_id', dealId);

  await ctx.reply(`❌ Deal ${dealId} cancelled.${deal.status === 'funded' ? '\n\nContact admin for on-chain refund.' : ''}`);
});

// /fund command
bot.command('fund', async (ctx) => {
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/fund\s+(TL-\w+)$/i);

  if (!match) {
    await ctx.reply('Usage: /fund TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) {
    await ctx.reply('Only buyer can fund.');
    return;
  }

  if (deal.status !== 'pending_deposit') {
    await ctx.reply(`Cannot fund. Status: ${deal.status}`);
    return;
  }

  const { data: sellerUser } = await supabase.from('users').select('wallet_address').eq('telegram_id', deal.seller_telegram_id).single();
  const { data: buyerUser } = await supabase.from('users').select('wallet_address').eq('username', username).single();

  if (!sellerUser?.wallet_address) {
    await ctx.reply(`Seller @${deal.seller_username} needs to register wallet.`);
    return;
  }

  if (!buyerUser?.wallet_address) {
    await ctx.reply('Register wallet first: /wallet 0xYourAddress');
    return;
  }

  // Check if on-chain
  try {
    const existingId = await escrowContract.externalIdToDealId(dealId);
    if (existingId.toString() !== '0') {
      await supabase.from('deals').update({ contract_deal_id: dealId }).eq('deal_id', dealId);
      await ctx.reply(`👇 TAP TO DEPOSIT:\nhttps://nobrakesnft.github.io/TrustLock?deal=${dealId}`);
      return;
    }
  } catch (e) {}

  await ctx.reply('Creating on-chain deal...');

  try {
    const amountWei = BigInt(Math.floor(deal.amount * 1e6));
    const tx = await escrowContract.createDeal(dealId, sellerUser.wallet_address, buyerUser.wallet_address, amountWei);
    await ctx.reply(`Tx: https://sepolia.basescan.org/tx/${tx.hash}`);
    await tx.wait();

    await supabase.from('deals').update({ contract_deal_id: dealId, tx_hash: tx.hash }).eq('deal_id', dealId);

    await ctx.reply(`
✅ Deal on blockchain!

👇 TAP TO DEPOSIT:
https://nobrakesnft.github.io/TrustLock?deal=${dealId}
    `);
  } catch (error) {
    await ctx.reply(`Failed: ${error.message}`);
  }
});

// /dispute command
bot.command('dispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/dispute\s+(TL-\w+)(?:\s+(.+))?$/i);

  if (!match) {
    await ctx.reply('Usage: /dispute TL-XXXX reason');
    return;
  }

  const dealId = match[1].toUpperCase();
  const reason = match[2] || 'No reason';

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();

  if (!isSeller && !isBuyer) {
    await ctx.reply('Not your deal.');
    return;
  }

  if (deal.status !== 'funded') {
    await ctx.reply(`Cannot dispute. Status: ${deal.status}`);
    return;
  }

  await supabase.from('deals').update({
    status: 'disputed',
    disputed_by: username,
    dispute_reason: reason,
    disputed_at: new Date().toISOString()
  }).eq('deal_id', dealId);

  await ctx.reply(`
⚠️ Dispute Filed

Deal: ${dealId}
Reason: ${reason}

Submit evidence: /evidence ${dealId} [message]
View evidence: /viewevidence ${dealId}
Cancel: /canceldispute ${dealId}
  `);

  // Notify other party
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').eq('username', deal.buyer_username).single();
  const otherPartyId = isSeller ? buyerUser?.telegram_id : deal.seller_telegram_id;

  if (otherPartyId) {
    try {
      await bot.api.sendMessage(otherPartyId, `⚠️ Dispute on ${dealId}\n\nBy: @${username}\nReason: ${reason}\n\nSubmit evidence: /evidence ${dealId} [msg]`);
    } catch (e) {}
  }

  // Notify admins
  for (const admin of ADMIN_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').eq('username', admin.trim()).single();
    if (adminUser?.telegram_id) {
      try {
        await bot.api.sendMessage(adminUser.telegram_id, `🔔 DISPUTE: ${dealId}\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\n\n/resolve ${dealId} release|refund`);
      } catch (e) {}
    }
  }
});

// /evidence command
bot.command('evidence', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/evidence\s+(TL-\w+)(?:\s+(.+))?$/i);

  if (!match || !match[2]) {
    await ctx.reply('Usage: /evidence TL-XXXX your message');
    return;
  }

  const dealId = match[1].toUpperCase();
  const evidence = match[2];

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();

  if (!deal || deal.status !== 'disputed') {
    await ctx.reply('Deal not found or not disputed.');
    return;
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const isAdmin = ADMIN_USERNAMES.includes(username?.toLowerCase());

  if (!isSeller && !isBuyer && !isAdmin) {
    await ctx.reply('Not your deal.');
    return;
  }

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');

  await supabase.from('evidence').insert({
    deal_id: dealId,
    submitted_by: username,
    role: role,
    content: evidence,
    telegram_id: userId
  });

  await ctx.reply(`✅ Evidence submitted for ${dealId}`);

  // Forward to others
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').eq('username', deal.buyer_username).single();
  const parties = [deal.seller_telegram_id, buyerUser?.telegram_id].filter(id => id && id !== userId);

  for (const partyId of parties) {
    try {
      await bot.api.sendMessage(partyId, `📋 Evidence for ${dealId}\n\nFrom: @${username} (${role})\n"${evidence}"`);
    } catch (e) {}
  }
});

// /viewevidence command
bot.command('viewevidence', async (ctx) => {
  const text = ctx.message.text;
  const match = text.match(/^\/viewevidence\s+(TL-\w+)$/i);

  if (!match) {
    await ctx.reply('Usage: /viewevidence TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();
  const { data: evidence } = await supabase.from('evidence').select('*').eq('deal_id', dealId).order('created_at', { ascending: true });

  if (!deal) {
    await ctx.reply(`Deal ${dealId} not found.`);
    return;
  }

  let msg = `📋 Evidence: ${dealId}\n\nReason: ${deal.dispute_reason || 'N/A'}\n\n`;

  if (!evidence || evidence.length === 0) {
    msg += 'No evidence yet.';
  } else {
    for (const e of evidence) {
      msg += `[${e.role}] @${e.submitted_by}\n"${e.content}"\n\n`;
    }
  }

  await ctx.reply(msg);
});

// /canceldispute command
bot.command('canceldispute', async (ctx) => {
  const username = ctx.from.username;
  const text = ctx.message.text;
  const match = text.match(/^\/canceldispute\s+(TL-\w+)$/i);

  if (!match) {
    await ctx.reply('Usage: /canceldispute TL-XXXX');
    return;
  }

  const dealId = match[1].toUpperCase();

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();

  if (!deal || deal.status !== 'disputed') {
    await ctx.reply('Deal not found or not disputed.');
    return;
  }

  if (deal.disputed_by?.toLowerCase() !== username?.toLowerCase()) {
    await ctx.reply(`Only @${deal.disputed_by} can cancel.`);
    return;
  }

  await supabase.from('deals').update({ status: 'funded' }).eq('deal_id', dealId);

  await ctx.reply(`✅ Dispute cancelled. Deal ${dealId} back to funded.`);
});

// /resolve command - Admin only
bot.command('resolve', async (ctx) => {
  const username = ctx.from.username;

  if (!ADMIN_USERNAMES.includes(username?.toLowerCase())) {
    await ctx.reply('Admin only.');
    return;
  }

  const text = ctx.message.text;
  const match = text.match(/^\/resolve\s+(TL-\w+)\s+(release|refund)$/i);

  if (!match) {
    await ctx.reply('Usage: /resolve TL-XXXX release|refund');
    return;
  }

  const dealId = match[1].toUpperCase();
  const decision = match[2].toLowerCase();

  const { data: deal } = await supabase.from('deals').select('*').eq('deal_id', dealId).single();

  if (!deal || deal.status !== 'disputed') {
    await ctx.reply('Deal not found or not disputed.');
    return;
  }

  await ctx.reply('Resolving on-chain...');

  try {
    const chainDealId = await escrowContract.externalIdToDealId(dealId);
    if (chainDealId.toString() !== '0') {
      const tx = decision === 'release' ? await escrowContract.resolveRelease(chainDealId) : await escrowContract.refund(chainDealId);
      await ctx.reply(`Tx: https://sepolia.basescan.org/tx/${tx.hash}`);
      await tx.wait();
    }
  } catch (e) {
    await ctx.reply(`On-chain failed: ${e.shortMessage || e.message}`);
  }

  const newStatus = decision === 'release' ? 'completed' : 'refunded';
  await supabase.from('deals').update({ status: newStatus, resolved_by: username, completed_at: new Date().toISOString() }).eq('deal_id', dealId);

  await ctx.reply(`⚖️ Resolved: ${decision === 'release' ? 'Funds → Seller' : 'Refund → Buyer'}`);

  // Notify parties
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').eq('username', deal.buyer_username).single();

  if (deal.seller_telegram_id) {
    try { await bot.api.sendMessage(deal.seller_telegram_id, `⚖️ ${dealId} resolved: ${decision === 'release' ? '✅ Funds to you!' : '❌ Refunded to buyer'}`); } catch (e) {}
  }
  if (buyerUser?.telegram_id) {
    try { await bot.api.sendMessage(buyerUser.telegram_id, `⚖️ ${dealId} resolved: ${decision === 'refund' ? '✅ Refunded to you!' : '❌ Released to seller'}`); } catch (e) {}
  }
});

// Handle unknown text
bot.on('message:text', async (ctx) => {
  if (ctx.message.text.startsWith('/')) return;
  await ctx.reply('Use /help for commands.');
});

// Poll for deal status
async function pollPendingDeals() {
  try {
    const { data: pendingDeals } = await supabase
      .from('deals')
      .select('*')
      .eq('status', 'pending_deposit')
      .not('contract_deal_id', 'is', null);

    if (!pendingDeals) return;

    for (const dbDeal of pendingDeals) {
      try {
        const chainDealId = await escrowContract.externalIdToDealId(dbDeal.deal_id);
        if (chainDealId.toString() === '0') continue;

        const onChainDeal = await escrowContract.deals(chainDealId);
        const onChainStatus = Number(onChainDeal[4]);

        if (onChainStatus === 1) {
          console.log(`Funded: ${dbDeal.deal_id}`);

          await supabase.from('deals').update({ status: 'funded', funded_at: new Date().toISOString() }).eq('deal_id', dbDeal.deal_id);

          if (dbDeal.seller_telegram_id) {
            try { await bot.api.sendMessage(dbDeal.seller_telegram_id, `💰 ${dbDeal.deal_id} funded!\n\n${dbDeal.amount} USDC locked. Deliver now.\n\nBuyer releases: /release ${dbDeal.deal_id}`); } catch (e) {}
          }

          const { data: buyerUser } = await supabase.from('users').select('telegram_id').eq('username', dbDeal.buyer_username).single();
          if (buyerUser?.telegram_id) {
            try { await bot.api.sendMessage(buyerUser.telegram_id, `✅ ${dbDeal.deal_id} deposit confirmed!\n\nRelease when ready: /release ${dbDeal.deal_id}`); } catch (e) {}
          }
        }
      } catch (e) {
        console.error(`Poll error ${dbDeal.deal_id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// Start bot
bot.start();
console.log('TrustLock bot running!');
console.log('Contract:', CONTRACT_ADDRESS);

setInterval(pollPendingDeals, 30000);
pollPendingDeals();
console.log('Polling every 30s');
