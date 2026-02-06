// DealPact Bot v3.2 - All Fixes
require('dotenv').config();

const { Bot, InlineKeyboard } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

// Validate required env vars on startup
const REQUIRED_ENV = ['BOT_TOKEN', 'SUPABASE_URL', 'SUPABASE_KEY', 'CONTRACT_ADDRESS', 'PRIVATE_KEY', 'ADMIN_TELEGRAM_IDS'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length) {
  console.error('FATAL: Missing required env vars:', missingEnv.join(', '));
  process.exit(1);
}

// Initialize
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const CONTRACT_ADDRESS = process.env.CONTRACT_ADDRESS;

const ESCROW_ABI = [
  "function createDeal(string calldata _externalId, address _seller, address _buyer, uint256 _amount) external returns (uint256)",
  "function getDealByExternalId(string calldata _externalId) external view returns (tuple(string externalId, address seller, address buyer, uint256 amount, uint8 status, uint256 createdAt, uint256 completedAt))",
  "function externalIdToDealId(string calldata) external view returns (uint256)",
  "function deals(uint256) external view returns (string, address, address, uint256, uint8, uint256, uint256)",
  "function dispute(uint256 _dealId) external",
  "function resolveRelease(uint256 _dealId) external",
  "function refund(uint256 _dealId) external"
];

const escrowContract = new ethers.Contract(CONTRACT_ADDRESS, ESCROW_ABI, wallet);
const bot = new Bot(process.env.BOT_TOKEN);

// Botmaster Telegram IDs (not usernames — IDs are immutable and can't be spoofed)
const BOTMASTER_IDS = (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim()).filter(Boolean).map(Number);

// Frontend URL (don't hardcode GitHub Pages)
const FRONTEND_URL = process.env.FRONTEND_URL || 'https://nobrakesnft.github.io/DealPact';

// Rate limiting: per-user cooldown map
const rateLimitMap = new Map();
function isRateLimited(userId, cooldownMs = 3000) {
  const now = Date.now();
  const last = rateLimitMap.get(userId) || 0;
  if (now - last < cooldownMs) return true;
  rateLimitMap.set(userId, now);
  return false;
}
// Cleanup stale entries every 5 minutes
setInterval(() => {
  const cutoff = Date.now() - 60000;
  for (const [k, v] of rateLimitMap) {
    if (v < cutoff) rateLimitMap.delete(k);
  }
}, 300000);

// ============ HELPER FUNCTIONS ============

function generateDealId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `DP-${code}`;
}

async function getDeal(dealId) {
  const normalized = dealId.toUpperCase().trim();
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .ilike('deal_id', normalized)
    .single();
  return { deal: data, error };
}

function isBotmaster(telegramId) {
  return BOTMASTER_IDS.includes(telegramId);
}

async function isModerator(telegramId) {
  try {
    const { data } = await supabase
      .from('moderators')
      .select('*')
      .eq('telegram_id', telegramId)
      .eq('is_active', true)
      .single();
    return !!data;
  } catch (e) {
    return false;
  }
}

async function isAnyAdmin(ctx) {
  if (isBotmaster(ctx.from.id)) return { isAdmin: true, role: 'botmaster' };
  if (await isModerator(ctx.from.id)) return { isAdmin: true, role: 'moderator' };
  return { isAdmin: false, role: null };
}

async function logAdminAction(action, dealId, adminTelegramId, adminUsername, targetUser, details) {
  try {
    const { error } = await supabase.from('admin_logs').insert({
      action,
      deal_id: dealId,
      admin_telegram_id: adminTelegramId,
      admin_username: adminUsername,
      target_user: targetUser,
      details
    });
    if (error) console.error('Log insert error:', error.message);
  } catch (e) {
    console.error('Log error:', e.message);
  }
}

async function notifyParties(deal, message) {
  try {
    if (deal.seller_telegram_id) {
      await bot.api.sendMessage(deal.seller_telegram_id, message);
    }
  } catch (e) {}
  try {
    const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
    if (buyerUser?.telegram_id) {
      await bot.api.sendMessage(buyerUser.telegram_id, message);
    }
  } catch (e) {}
}

// Timeout wrapper for tx.wait() — prevents bot from hanging if RPC stalls
async function waitWithTimeout(tx, ms = 60000) {
  return Promise.race([
    tx.wait(),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Transaction timed out')), ms))
  ]);
}

// Get on-chain deal status
async function getOnChainStatus(dealId) {
  try {
    const chainId = await escrowContract.externalIdToDealId(dealId);
    if (chainId.toString() === '0') return { exists: false };
    const deal = await escrowContract.deals(chainId);
    // Status: 0=Pending, 1=Funded, 2=Completed, 3=Refunded, 4=Disputed, 5=Cancelled
    return { exists: true, chainId, status: Number(deal[4]) };
  } catch (e) {
    return { exists: false, error: e.message };
  }
}

// ============ USER COMMANDS ============

bot.command('start', async (ctx) => {
  const param = ctx.message.text.split(' ')[1]?.toLowerCase();

  if (param === 'newdeal') {
    const kb = new InlineKeyboard().text('Help', 'guide_help');
    return ctx.reply(`*Create a New Deal*\n\n1. Register wallet: \`/wallet 0xYourAddress\`\n2. Create deal: \`/new @buyer amount description\``, { reply_markup: kb, parse_mode: 'Markdown' });
  }

  if (param?.startsWith('dispute_')) {
    const dealId = param.replace('dispute_', '').toUpperCase();
    return ctx.reply(`⚠️ Open Dispute for ${dealId}\n\nType: \`/dispute ${dealId} your reason\``, { parse_mode: 'Markdown' });
  }

  const kb = new InlineKeyboard()
    .text('Sell', 'guide_sell')
    .text('Buy', 'guide_buy')
    .row()
    .text('Fund Deal', 'guide_fund')
    .text('Release', 'guide_release')
    .row()
    .text('Check Status', 'guide_status')
    .text('My Deals', 'guide_deals')
    .row()
    .text('Check Rep', 'guide_rep')
    .text('Help', 'guide_help');

  await ctx.reply(
    `*Welcome to DealPact* 🔒\n\nCrypto escrow service for Telegram.\n\nFunds are held in a smart contract until the deal is complete. Dispute resolution available.\n\nWhat would you like to do?`,
    { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.command('help', async (ctx) => {
  const { role } = await isAnyAdmin(ctx);
  let adminNote = '';
  if (role === 'botmaster') adminNote = '\n\n*Admin:* /adminhelp';
  else if (role === 'moderator') adminNote = '\n\n*Mod:* /modhelp';

  const kb = new InlineKeyboard()
    .text('Sell', 'guide_sell')
    .text('Buy', 'guide_buy')
    .row()
    .text('Check Deal', 'guide_status')
    .text('My Deals', 'guide_deals');

  await ctx.reply(`*DealPact Help*

*First time?* Register wallet:
\`/wallet 0xYourWalletAddress\`

*Selling:*
1. Create deal → \`/new @buyer amount description\`
2. Wait for buyer to deposit
3. Deliver your service/item
4. Buyer releases funds to you ✅

*Buying:*
1. Seller creates the deal for you
2. Fund it → \`/fund DP-XXXX\`
3. Receive the service/item
4. Release funds → \`/release DP-XXXX\`

*Problem?*
\`/dispute DP-XXXX reason\`

*After deal is done:*
\`/review DP-XXXX 5 Great seller!\`
\`/rep @username\`

⚠️ Admins will NEVER DM you first.${adminNote}`, { reply_markup: kb, parse_mode: 'Markdown' });
});

// ============ BUTTON HANDLERS ============

bot.callbackQuery('guide_sell', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('wallet_address').eq('telegram_id', userId).single();

  if (!user?.wallet_address) {
    const kb = new InlineKeyboard().text('Main Menu', 'main_menu');
    return ctx.reply(
      `*Step 1: Register Your Wallet*\n\nType:\n\`/wallet 0xYourWalletAddress\`\n\nNo wallet? Download MetaMask or Rabby.`, { reply_markup: kb, parse_mode: 'Markdown' }
    );
  }

  const kb = new InlineKeyboard().text('My Deals', 'guide_deals').text('Main Menu', 'main_menu');
  await ctx.reply(
    `✅ *Wallet registered!*\n\nTo create a deal:\n\`/new @buyer amount description\`\n\nExample:\n\`/new @john 25 Logo design\`\n\nBuyer deposits → You deliver → They release funds.`, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_buy', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const { data: user } = await supabase.from('users').select('wallet_address').eq('telegram_id', userId).single();

  if (!user?.wallet_address) {
    const kb = new InlineKeyboard().text('Main Menu', 'main_menu');
    return ctx.reply(
      `*Step 1: Register Your Wallet*\n\nType:\n\`/wallet 0xYourWalletAddress\`\n\nNo wallet? Download MetaMask or Rabby.`, { reply_markup: kb, parse_mode: 'Markdown' }
    );
  }

  const kb = new InlineKeyboard().text('My Deals', 'guide_deals').text('Main Menu', 'main_menu');
  await ctx.reply(
    `✅ *Wallet registered!*\n\n1. Ask seller to create deal for you\n2. Fund it: \`/fund DP-XXXX\`\n3. Receive service/item\n4. Release: \`/release DP-XXXX\`\n\nProblem? \`/dispute DP-XXXX reason\``, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_status', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('My Deals', 'guide_deals').text('Main Menu', 'main_menu');
  await ctx.reply(
    `*Check a Deal*\n\nType: \`/status DP-XXXX\`\n\nReplace DP-XXXX with your deal ID (e.g. DP-A7X9).`, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_fund', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('My Deals', 'guide_deals').text('Main Menu', 'main_menu');
  await ctx.reply(
    `*Fund a Deal*\n\nType: \`/fund DP-XXXX\`\n\nReplace DP-XXXX with your deal ID from the seller.`, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_release', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('My Deals', 'guide_deals').text('Main Menu', 'main_menu');
  await ctx.reply(
    `*Release Funds*\n\nType: \`/release DP-XXXX\`\n\nOnly release after you receive the service/item.`, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_rep', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('My Rep', 'my_rep').text('Main Menu', 'main_menu');
  await ctx.reply(
    `*Check Reputation*\n\nSend a username (e.g. @john)`, { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('my_rep', async (ctx) => {
  await ctx.answerCallbackQuery();
  const username = ctx.from.username;
  if (!username) return ctx.reply('You need a Telegram username to have a reputation.');

  const { data: deals } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_username.ilike.${username},buyer_username.ilike.${username}`)
    .eq('status', 'completed');

  const total = deals?.length || 0;
  const volume = deals?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;

  let badge = 'New';
  if (total >= 50) badge = '💎 Elite';
  else if (total >= 25) badge = '🏆 Pro';
  else if (total >= 10) badge = '⭐ Proven';
  else if (total >= 4) badge = 'Established';
  else if (total >= 2) badge = 'Active';

  let reviews = '';
  for (const d of (deals || []).slice(0, 5)) {
    const isSeller = d.seller_username.toLowerCase() === username.toLowerCase();
    const rating = isSeller ? d.buyer_rating : d.seller_rating;
    const comment = isSeller ? d.buyer_review : d.seller_review;
    const reviewer = isSeller ? d.buyer_username : d.seller_username;
    if (rating) reviews += `${'⭐'.repeat(rating)} by @${reviewer}${comment ? ` - "${comment}"` : ''}\n`;
  }

  const kb = new InlineKeyboard().text('Main Menu', 'main_menu');
  let msg = `*@${username}*\n\n${badge}\nDeals: ${total}\nVolume: ${volume.toFixed(0)} USDC`;
  if (reviews) msg += `\n\n*Reviews:*\n${reviews.trim()}`;
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('main_menu', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('Sell', 'guide_sell')
    .text('Buy', 'guide_buy')
    .row()
    .text('Fund Deal', 'guide_fund')
    .text('Release', 'guide_release')
    .row()
    .text('Check Status', 'guide_status')
    .text('My Deals', 'guide_deals')
    .row()
    .text('Check Rep', 'guide_rep')
    .text('Help', 'guide_help');

  await ctx.reply(
    `*DealPact* 🔒\n\nWhat would you like to do?`,
    { reply_markup: kb, parse_mode: 'Markdown' }
  );
});

bot.callbackQuery('guide_deals', async (ctx) => {
  await ctx.answerCallbackQuery();
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { data } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_telegram_id.eq.${userId},buyer_username.ilike.${username}`)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!data?.length) {
    const kb = new InlineKeyboard().text('Sell', 'guide_sell').text('Buy', 'guide_buy').row().text('Main Menu', 'main_menu');
    return ctx.reply('No deals yet.\n\nTap below to get started.', { reply_markup: kb });
  }

  let msg = '*Your Deals:*\n\n';
  const kb = new InlineKeyboard();
  let btnCount = 0;

  for (const d of data) {
    const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[d.status] || '❓';
    const role = d.seller_telegram_id === userId ? 'Seller' : 'Buyer';
    msg += `${emoji} \`${d.deal_id}\` | ${d.amount} USDC | ${role}\n`;

    if (btnCount < 5 && (d.status === 'pending_deposit' || d.status === 'funded' || d.status === 'disputed')) {
      kb.text(`${emoji} ${d.deal_id}`, `status_${d.deal_id}`).row();
      btnCount++;
    }
  }

  kb.text('Main Menu', 'main_menu');
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('guide_help', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('Sell', 'guide_sell')
    .text('Buy', 'guide_buy')
    .row()
    .text('My Deals', 'guide_deals')
    .text('Main Menu', 'main_menu');

  await ctx.reply(`*DealPact Help*

*First time?* Register wallet:
\`/wallet 0xYourWalletAddress\`

*Selling:*
1. Create deal → \`/new @buyer amount description\`
2. Wait for buyer to deposit
3. Deliver your service/item
4. Buyer releases funds ✅

*Buying:*
1. Seller creates the deal for you
2. Fund it → \`/fund DP-XXXX\`
3. Receive the service/item
4. Release funds → \`/release DP-XXXX\`

*Cancel:* \`/cancel DP-XXXX\` (before funded)

*Problem?* \`/dispute DP-XXXX reason\`

*Done?* \`/review DP-XXXX 5 Great seller!\`

⚠️ Admins will NEVER DM you first.`, { reply_markup: kb, parse_mode: 'Markdown' });
});

// Dynamic callback handlers for deal actions
bot.callbackQuery(/^fund_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  const username = ctx.from.username;

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('❌ Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('🚫 Only the buyer can fund this deal.');
  if (deal.status !== 'pending_deposit') return ctx.reply(`⚠️ Cannot fund. Status: ${deal.status}`);

  const { data: sellerUser } = await supabase.from('users').select('wallet_address').eq('telegram_id', deal.seller_telegram_id).single();
  const { data: buyerUser } = await supabase.from('users').select('wallet_address').ilike('username', username).single();

  if (!sellerUser?.wallet_address) return ctx.reply('⚠️ Seller needs to register wallet first.');
  if (!buyerUser?.wallet_address) return ctx.reply('⚠️ Register your wallet first: /wallet 0xYourAddress');

  try {
    const existingId = await escrowContract.externalIdToDealId(deal.deal_id);
    if (existingId.toString() !== '0') {
      await supabase.from('deals').update({ contract_deal_id: deal.deal_id }).ilike('deal_id', deal.deal_id);
      const fundKb = new InlineKeyboard().url('💳 Deposit Now', `${FRONTEND_URL}?deal=${deal.deal_id}`);
      return ctx.reply(`💰 *Ready to deposit!*\n\nAmount: *${deal.amount} USDC*\n\n👇 Tap below to pay securely:`, { reply_markup: fundKb, parse_mode: 'Markdown' });
    }
  } catch (e) {}

  await ctx.reply('⏳ Creating on-chain deal...');

  try {
    const tx = await escrowContract.createDeal(deal.deal_id, sellerUser.wallet_address, buyerUser.wallet_address, BigInt(Math.floor(deal.amount * 1e6)));
    await ctx.reply(`🔗 Tx: https://basescan.org/tx/${tx.hash}`);
    await waitWithTimeout(tx);
    await supabase.from('deals').update({ contract_deal_id: deal.deal_id, tx_hash: tx.hash }).ilike('deal_id', deal.deal_id);
    const fundKb2 = new InlineKeyboard().url('💳 Deposit Now', `${FRONTEND_URL}?deal=${deal.deal_id}`);
    await ctx.reply(`✅ *Ready to deposit!*\n\nAmount: *${deal.amount} USDC*\n\n👇 Tap below to pay securely:`, { reply_markup: fundKb2, parse_mode: 'Markdown' });
  } catch (e) {
    await ctx.reply('❌ Something went wrong. Please try again shortly.');
  }
});

bot.callbackQuery(/^status_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('❌ Deal not found.');

  const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[deal.status] || '❓';
  const statusText = { pending_deposit: 'Awaiting Deposit', funded: 'Funded & Active', completed: 'Completed', disputed: 'Disputed', cancelled: 'Cancelled', refunded: 'Refunded' }[deal.status] || deal.status;

  let kb = new InlineKeyboard();
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();

  if (deal.status === 'pending_deposit') {
    if (isBuyer) kb.text('Fund Deal', `fund_${deal.deal_id}`);
    if (isSeller) kb.text('Cancel Deal', `cancel_${deal.deal_id}`);
  } else if (deal.status === 'funded') {
    if (isBuyer) kb.text('Release Funds', `release_${deal.deal_id}`);
    kb.row().text('Open Dispute', `dispute_${deal.deal_id}`);
  } else if (deal.status === 'completed' || deal.status === 'refunded') {
    kb.text('Leave Review', `review_${deal.deal_id}`);
  }

  let extra = '';
  if (deal.status === 'disputed') {
    extra = `\n\n⚠️ *DISPUTED*\nReason: ${deal.dispute_reason || 'N/A'}`;
    extra += deal.assigned_to_username ? '\n🔍 Status: Being reviewed' : '\n⏳ Status: Awaiting review';
  } else if (deal.status === 'funded' && deal.funded_at) {
    const msLeft = new Date(deal.funded_at).getTime() + 24 * 60 * 60 * 1000 - Date.now();
    if (msLeft > 0) {
      const h = Math.floor(msLeft / 3600000);
      const m = Math.floor((msLeft % 3600000) / 60000);
      extra = `\n\n⏱️ Release window: *${h}h ${m}m* remaining`;
    } else {
      extra = `\n\n⏱️ Release window expired`;
    }
  }

  await ctx.reply(`${emoji} *${deal.deal_id}* — ${statusText}\n\n👤 Seller: @${deal.seller_username}\n👤 Buyer: @${deal.buyer_username}\n💵 Amount: *${deal.amount} USDC*\n📝 ${deal.description}${extra}`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery(/^release_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  const username = ctx.from.username;

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('❌ Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('🚫 Only buyer can release.');
  if (deal.status !== 'funded' && deal.status !== 'disputed') return ctx.reply(`⚠️ Cannot release. Status: ${deal.status}`);

  const releaseKb = new InlineKeyboard().url('✅ Confirm Release', `${FRONTEND_URL}?deal=${deal.deal_id}&action=release`);
  await ctx.reply(`📤 *Release Funds*\n\nDeal: *${deal.deal_id}*\nAmount: *${deal.amount} USDC*\nTo: @${deal.seller_username}\n\n👇 Tap to confirm in your wallet:`, { reply_markup: releaseKb, parse_mode: 'Markdown' });
});

bot.callbackQuery(/^dispute_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  await ctx.reply(`⚠️ *Open Dispute for ${dealId}*\n\nTo open a dispute, type:\n\`/dispute ${dealId} your reason here\`\n\nExample:\n\`/dispute ${dealId} Seller not responding\``, { parse_mode: 'Markdown' });
});

bot.callbackQuery(/^cancel_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  const userId = ctx.from.id;

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.seller_telegram_id !== userId) return ctx.reply('Only seller can cancel.');
  if (deal.status !== 'pending_deposit') return ctx.reply(`Cannot cancel. Status: ${deal.status}`);

  await supabase.from('deals').update({ status: 'cancelled' }).ilike('deal_id', deal.deal_id);
  const kb = new InlineKeyboard().text('Main Menu', 'main_menu');
  await ctx.reply(`❌ Deal ${deal.deal_id} cancelled.`, { reply_markup: kb });
});

bot.callbackQuery(/^review_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');

  const targetUser = isSeller ? deal.buyer_username : deal.seller_username;
  const targetRole = isSeller ? 'buyer' : 'seller';

  const kb = new InlineKeyboard()
    .text('1 ⭐', `rate_${dealId}_1`)
    .text('2 ⭐', `rate_${dealId}_2`)
    .text('3 ⭐', `rate_${dealId}_3`)
    .text('4 ⭐', `rate_${dealId}_4`)
    .text('5 ⭐', `rate_${dealId}_5`)
    .row()
    .text('Main Menu', 'main_menu');

  await ctx.reply(`*Rate the ${targetRole} @${targetUser}*\n\nDeal: ${dealId}`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery(/^rate_(.+)_(\d)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const dealId = ctx.match[1];
  const rating = parseInt(ctx.match[2]);
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { deal } = await getDeal(dealId);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');

  const field = isSeller ? 'seller_rating' : 'buyer_rating';
  if (deal[field]) return ctx.reply('Already reviewed.');

  // Store rating temporarily, wait for comment
  await supabase.from('deals').update({ [field]: rating }).ilike('deal_id', deal.deal_id);

  const kb = new InlineKeyboard()
    .text('Skip Comment', `skip_review_${dealId}`)
    .row()
    .text('Main Menu', 'main_menu');

  await ctx.reply(`Rating: ${'⭐'.repeat(rating)}\n\nAdd a comment (just type it) or tap Skip:`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery(/^skip_review_(.+)$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard().text('Main Menu', 'main_menu');
  await ctx.reply(`✅ Review submitted!`, { reply_markup: kb });
});

bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/wallet\s+(0x[a-fA-F0-9]{40})$/i);

  if (!match) {
    const { data: user } = await supabase.from('users').select('wallet_address').eq('telegram_id', userId).single();
    return ctx.reply(user?.wallet_address ? `Your wallet: ${user.wallet_address}` : 'Usage: /wallet 0xYourAddress');
  }

  const walletAddress = match[1].toLowerCase();

  // Check if wallet is already registered to another user
  const { data: existing } = await supabase.from('users').select('telegram_id').eq('wallet_address', walletAddress).single();
  if (existing && existing.telegram_id !== userId) {
    return ctx.reply('This wallet is already registered to another user.');
  }

  const { error } = await supabase.from('users').upsert({
    telegram_id: userId,
    username: username,
    wallet_address: walletAddress
  }, { onConflict: 'telegram_id' });

  await ctx.reply(error ? 'Something went wrong. Please try again shortly.' : `✅ Wallet registered: ${match[1]}`);
});

bot.command('new', async (ctx) => {
  const senderId = ctx.from.id;
  const senderUsername = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/new\s+@(\w+)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);

  if (!match) return ctx.reply('Format: /new @buyer amount description');

  const [, buyerUsername, amountStr, description] = match;
  const amount = parseFloat(amountStr);

  if (amount < 1 || amount > 500) return ctx.reply('Amount: 1-500 USDC');
  if (buyerUsername.toLowerCase() === senderUsername.toLowerCase()) return ctx.reply("Can't deal with yourself");

  const { data: seller } = await supabase.from('users').select('wallet_address').eq('telegram_id', senderId).single();
  if (!seller?.wallet_address) return ctx.reply('Register wallet first: /wallet 0xYourAddress');

  const dealId = generateDealId();
  const { error } = await supabase.from('deals').insert({
    deal_id: dealId,
    seller_telegram_id: senderId,
    seller_username: senderUsername,
    buyer_telegram_id: 0,
    buyer_username: buyerUsername,
    amount, description,
    status: 'pending_deposit'
  });

  if (error) return ctx.reply('Something went wrong. Please try again shortly.');

  const sellerKb = new InlineKeyboard().text('Check Status', `status_${dealId}`).text('Main Menu', 'main_menu');

  await ctx.reply(
    `✅ *Deal Created!*\n\nDeal ID: \`${dealId}\`\nSeller: @${senderUsername}\nBuyer: @${buyerUsername}\nAmount: ${amount} USDC\nFor: ${description}\n\nShare this Deal ID with @${buyerUsername} to fund.`,
    { reply_markup: sellerKb, parse_mode: 'Markdown' }
  );

  // Notify buyer if they have telegram_id
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', buyerUsername).single();
  if (buyerUser?.telegram_id) {
    const buyerKb = new InlineKeyboard().text('Fund Deal', `fund_${dealId}`).text('Check Status', `status_${dealId}`);
    try {
      await bot.api.sendMessage(buyerUser.telegram_id, `*New Deal for You*\n\nDeal ID: \`${dealId}\`\nSeller: @${senderUsername}\nAmount: ${amount} USDC\nFor: ${description}\n\nTap below to fund:`, { reply_markup: buyerKb, parse_mode: 'Markdown' });
    } catch (e) {}
  }
});

bot.command('status', async (ctx) => {
  const match = ctx.message.text.match(/^\/status\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('❌ Usage: `/status DP-XXXX`', { parse_mode: 'Markdown' });

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('❌ Deal not found.');

  const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[deal.status] || '❓';
  const statusText = { pending_deposit: 'Awaiting Deposit', funded: 'Funded & Active', completed: 'Completed', disputed: 'Disputed', cancelled: 'Cancelled', refunded: 'Refunded' }[deal.status] || deal.status;

  const userId = ctx.from.id;
  const username = ctx.from.username;
  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();

  let kb = new InlineKeyboard();
  if (deal.status === 'pending_deposit' && isBuyer) {
    kb.text('💳 Fund This Deal', `fund_${deal.deal_id}`);
  } else if (deal.status === 'funded') {
    if (isBuyer) kb.text('✅ Release Funds', `release_${deal.deal_id}`);
    if (isSeller || isBuyer) kb.row().text('⚠️ Open Dispute', `dispute_${deal.deal_id}`);
  } else if ((deal.status === 'completed' || deal.status === 'refunded') && (isSeller || isBuyer)) {
    kb.text('⭐ Leave Review', `review_${deal.deal_id}`);
  }

  let extra = '';
  if (deal.status === 'disputed') {
    extra = `\n\n⚠️ *DISPUTED*\nReason: ${deal.dispute_reason || 'N/A'}`;
    extra += deal.assigned_to_username ? '\n🔍 Status: Being reviewed' : '\n⏳ Status: Awaiting review';
  } else if (deal.status === 'funded' && deal.funded_at) {
    const msLeft = new Date(deal.funded_at).getTime() + 24 * 60 * 60 * 1000 - Date.now();
    if (msLeft > 0) {
      const h = Math.floor(msLeft / 3600000);
      const m = Math.floor((msLeft % 3600000) / 60000);
      extra = `\n\n⏱️ Release window: *${h}h ${m}m* remaining`;
    } else {
      extra = `\n\n⏱️ Release window expired`;
    }
  }

  await ctx.reply(`${emoji} *${deal.deal_id}* — ${statusText}\n\n👤 Seller: @${deal.seller_username}\n👤 Buyer: @${deal.buyer_username}\n💵 Amount: *${deal.amount} USDC*\n📝 ${deal.description}${extra}`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.command('deals', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_telegram_id.eq.${userId},buyer_username.ilike.${username}`)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) return ctx.reply('❌ Something went wrong. Please try again shortly.');
  if (!data?.length) {
    const kb = new InlineKeyboard().text('💰 Create a Deal', 'guide_sell');
    return ctx.reply('📭 You have no deals yet.\n\nTap below to get started!', { reply_markup: kb });
  }

  let msg = '📋 *Your Deals:*\n\n';
  const kb = new InlineKeyboard();
  let btnCount = 0;

  for (const d of data) {
    const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[d.status] || '❓';
    const role = d.seller_telegram_id === userId ? '💰 Seller' : '🛒 Buyer';
    msg += `${emoji} \`${d.deal_id}\` • *${d.amount}* USDC • ${role}\n`;

    // Add buttons for active deals (max 5)
    if (btnCount < 5 && (d.status === 'pending_deposit' || d.status === 'funded' || d.status === 'disputed')) {
      kb.text(`${emoji} ${d.deal_id}`, `status_${d.deal_id}`).row();
      btnCount++;
    }
  }

  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.command('fund', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/fund\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('Usage: /fund DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('Only buyer can fund.');
  if (deal.status !== 'pending_deposit') return ctx.reply(`Cannot fund. Status: ${deal.status}`);

  const { data: sellerUser } = await supabase.from('users').select('wallet_address').eq('telegram_id', deal.seller_telegram_id).single();
  const { data: buyerUser } = await supabase.from('users').select('wallet_address').ilike('username', username).single();

  if (!sellerUser?.wallet_address) return ctx.reply('Seller needs wallet first.');
  if (!buyerUser?.wallet_address) return ctx.reply('Register wallet: /wallet 0xYourAddress');

  try {
    const existingId = await escrowContract.externalIdToDealId(deal.deal_id);
    if (existingId.toString() !== '0') {
      await supabase.from('deals').update({ contract_deal_id: deal.deal_id }).ilike('deal_id', deal.deal_id);
      const fundKb = new InlineKeyboard().url('Deposit Now', `${FRONTEND_URL}?deal=${deal.deal_id}`);
      return ctx.reply(`Ready to deposit!\n\nTap the button below to pay ${deal.amount} USDC.\nYou'll approve the transaction in your wallet.`, { reply_markup: fundKb });
    }
  } catch (e) {}

  await ctx.reply('Creating on-chain deal...');

  try {
    const tx = await escrowContract.createDeal(deal.deal_id, sellerUser.wallet_address, buyerUser.wallet_address, BigInt(Math.floor(deal.amount * 1e6)));
    await ctx.reply(`Tx: https://basescan.org/tx/${tx.hash}`);
    await waitWithTimeout(tx);
    await supabase.from('deals').update({ contract_deal_id: deal.deal_id, tx_hash: tx.hash }).ilike('deal_id', deal.deal_id);
    const fundKb2 = new InlineKeyboard().url('Deposit Now', `${FRONTEND_URL}?deal=${deal.deal_id}`);
    await ctx.reply(`✅ Ready to deposit!\n\nTap the button below to pay ${deal.amount} USDC.\nYou'll approve the transaction in your wallet.`, { reply_markup: fundKb2 });
  } catch (e) {
    await ctx.reply('Something went wrong. Please try again shortly.');
  }
});

bot.command('release', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/release\s+(DP-\w+)(?:\s+(confirm))?$/i);
  if (!match) return ctx.reply('Usage: /release DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('Only buyer can release.');

  if (deal.status === 'disputed' && !match[2]) {
    return ctx.reply(`⚠️ Deal is disputed!\n\nTo release anyway: /release ${deal.deal_id} confirm`);
  }

  if (deal.status !== 'funded' && deal.status !== 'disputed') {
    return ctx.reply(`Cannot release. Status: ${deal.status}`);
  }

  await ctx.reply(`📤 Release: ${deal.deal_id}\nAmount: ${deal.amount} USDC\n\n👇 TAP TO RELEASE:\n${FRONTEND_URL}?deal=${deal.deal_id}&action=release`);
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/cancel\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('Usage: /cancel DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');
  if (deal.status !== 'pending_deposit') return ctx.reply(`Cannot cancel. Status: ${deal.status}`);
  if (!isSeller) return ctx.reply('Only the seller can cancel a pending deal.');

  await supabase.from('deals').update({ status: 'cancelled' }).ilike('deal_id', deal.deal_id);
  await ctx.reply(`❌ ${deal.deal_id} cancelled.`);
});

// /dispute - Opens dispute and marks on-chain
bot.command('dispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || `user_${userId}`;
  const match = ctx.message.text.match(/^\/dispute\s+(DP-\w+)(?:\s+(.+))?$/i);
  if (!match) return ctx.reply('Usage: /dispute DP-XXXX reason');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');
  if (deal.status !== 'funded') return ctx.reply(`Cannot dispute. Status: ${deal.status}`);

  const reason = match[2] || 'No reason provided';

  // Mark as disputed on-chain FIRST
  try {
    const chainId = await escrowContract.externalIdToDealId(deal.deal_id);
    if (chainId.toString() !== '0') {
      const onChain = await escrowContract.deals(chainId);
      const onChainStatus = Number(onChain[4]);

      // Only call dispute if not already disputed on-chain (status 4)
      if (onChainStatus === 1) { // Funded
        await ctx.reply('Marking dispute on-chain...');
        const tx = await escrowContract.dispute(chainId);
        await waitWithTimeout(tx);
        await ctx.reply('✅ On-chain dispute recorded.');
      }
    }
  } catch (e) {
    console.error('On-chain dispute error:', e.message);
    // Continue anyway - we can still track in DB
  }

  // Update database
  const { error } = await supabase.from('deals').update({
    status: 'disputed',
    disputed_by: username,
    disputed_by_telegram_id: userId,
    dispute_reason: reason,
    disputed_at: new Date().toISOString()
  }).ilike('deal_id', deal.deal_id);

  if (error) {
    console.error('Dispute update error:', error);
    return ctx.reply('Something went wrong. Please try again shortly.');
  }

  await ctx.reply(`⚠️ DISPUTE OPENED\n\nDeal: ${deal.deal_id}\nReason: ${reason}\n\nAdmin Team will review.\n\nSubmit evidence: /evidence ${deal.deal_id} [msg]`);

  // Notify other party
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  const otherPartyId = isSeller ? buyerUser?.telegram_id : deal.seller_telegram_id;
  if (otherPartyId) {
    try {
      await bot.api.sendMessage(otherPartyId, `⚠️ DISPUTE on ${deal.deal_id}\n\nReason: ${reason}\n\nSubmit evidence: /evidence ${deal.deal_id} [msg]`);
    } catch (e) {}
  }

  // Notify botmasters by ID (no DB lookup needed)
  for (const adminId of BOTMASTER_IDS) {
    try {
      await bot.api.sendMessage(adminId, `🔔 DISPUTE: ${deal.deal_id}\n\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\nBy: @${username}\nReason: ${reason}\n\n/disputes to view all`);
    } catch (e) {}
  }
});

bot.command('evidence', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/evidence\s+(DP-\w+)(?:\s+(.+))?$/i);

  if (!match) return ctx.reply('Usage: /evidence DP-XXXX your message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Deal not disputed. Status: ${deal.status}`);

  const evidence = match[2];
  if (!evidence) return ctx.reply(`Usage: /evidence ${deal.deal_id} your message`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');

  const { error } = await supabase.from('evidence').insert({
    deal_id: deal.deal_id,
    submitted_by: username,
    role,
    content: evidence,
    telegram_id: userId
  });

  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  await ctx.reply(`✅ Evidence submitted for ${deal.deal_id}`);
});

bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const caption = ctx.message.caption || '';

  const match = caption.match(/^(DP-\w+)(?:\s+(.*))?$/i);
  if (!match) return ctx.reply(`📸 Photo evidence: Send with caption DP-XXXX description`);

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Deal not disputed. Status: ${deal.status}`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  const { error } = await supabase.from('evidence').insert({
    deal_id: deal.deal_id,
    submitted_by: username,
    role,
    content: match[2]?.trim() || 'Photo',
    file_id: photo.file_id,
    file_type: 'photo',
    telegram_id: userId
  });

  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  await ctx.reply(`✅ Photo evidence submitted for ${deal.deal_id}`);
});

bot.command('viewevidence', async (ctx) => {
  const match = ctx.message.text.match(/^\/viewevidence\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('Usage: /viewevidence DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const userId = ctx.from.id;
  const username = ctx.from.username;
  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');
  if (role === 'moderator' && deal.assigned_to_telegram_id !== userId) return ctx.reply('Only assigned disputes.');

  const { data: evidence, error } = await supabase.from('evidence').select('*').ilike('deal_id', deal.deal_id).order('created_at', { ascending: true });

  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  if (!evidence?.length) return ctx.reply(`No evidence for ${deal.deal_id}`);

  let msg = `📋 Evidence: ${deal.deal_id}\nReason: ${deal.dispute_reason || 'N/A'}\n\n`;
  for (const e of evidence) {
    msg += `${e.file_type === 'photo' ? '📸' : '📝'} [${e.role}] @${e.submitted_by}: "${e.content}"\n\n`;
  }
  await ctx.reply(msg);

  for (const e of evidence) {
    if (e.file_id) {
      try { await bot.api.sendPhoto(ctx.chat.id, e.file_id, { caption: `[${e.role}] @${e.submitted_by}` }); } catch (err) {}
    }
  }
});

bot.command('canceldispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/canceldispute\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('Usage: /canceldispute DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Not disputed. Status: ${deal.status}`);

  const isDisputer = deal.disputed_by_telegram_id === userId || deal.disputed_by?.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isDisputer && !isAdmin) return ctx.reply('Only disputer or admin can cancel.');

  await supabase.from('deals').update({ status: 'funded' }).ilike('deal_id', deal.deal_id);
  await ctx.reply(`✅ Dispute cancelled. ${deal.deal_id} back to funded.`);
  await notifyParties(deal, `✅ Dispute on ${deal.deal_id} cancelled.`);
});

bot.command('review', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/review\s+(DP-\w+)\s+([1-5])(?:\s+(.+))?$/i);
  if (!match) return ctx.reply('Usage: /review DP-XXXX 5 comment');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  // Allow reviews for completed OR refunded deals (both are finished states)
  if (deal.status !== 'completed' && deal.status !== 'refunded') {
    return ctx.reply(`Can only review finished deals. Current status: ${deal.status}`);
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');

  const rating = parseInt(match[2]);
  const field = isSeller ? 'seller_review' : 'buyer_review';
  if (deal[field]) return ctx.reply('Already reviewed.');

  await supabase.from('deals').update({
    [field]: match[3] || 'No comment',
    [`${isSeller ? 'seller' : 'buyer'}_rating`]: rating
  }).ilike('deal_id', deal.deal_id);

  await ctx.reply(`✅ Review: ${'⭐'.repeat(rating)}`);
});

bot.command('rep', async (ctx) => {
  const match = ctx.message.text.match(/^\/rep(?:@\w+)?(?:\s+@(\w+))?$/i);
  const targetUsername = match?.[1] || ctx.from.username;

  const { data: deals } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_username.ilike.${targetUsername},buyer_username.ilike.${targetUsername}`)
    .eq('status', 'completed');

  const total = deals?.length || 0;
  const volume = deals?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;

  let badge = '🆕 New';
  if (total >= 50) badge = '💎 Elite';
  else if (total >= 25) badge = '🏆 Pro Trader';
  else if (total >= 10) badge = '⭐ Proven Trader';
  else if (total >= 4) badge = '📈 Established';
  else if (total >= 2) badge = '👤 Active';

  let reviews = '';
  for (const d of deals || []) {
    const isSeller = d.seller_username.toLowerCase() === targetUsername.toLowerCase();
    const rating = isSeller ? d.buyer_rating : d.seller_rating;
    const comment = isSeller ? d.buyer_review : d.seller_review;
    const reviewer = isSeller ? d.buyer_username : d.seller_username;
    if (rating) reviews += `${'⭐'.repeat(rating)} by @${reviewer}${comment ? ` - ${comment}` : ''}\n`;
  }

  let msg = `📊 @${targetUsername}\n\n${badge}\nDeals: ${total}\nVolume: ${volume.toFixed(0)} USDC`;
  if (reviews) msg += `\n\nReviews:\n${reviews.trim()}`;
  await ctx.reply(msg);
});

// ============ ADMIN COMMANDS ============

bot.command('adminhelp', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const kb = new InlineKeyboard()
    .text('Disputes', 'admin_disputes')
    .text('Mods', 'admin_mods')
    .row()
    .text('Add Mod', 'admin_addmod')
    .text('Logs', 'admin_logs');

  await ctx.reply(`*Admin Panel* 👑\n\nSelect an action or use commands:\n\n/addmod @user • /removemod @user\n/assign DP-XXXX @mod • /unassign DP-XXXX\n/resolve DP-XXXX release|refund\n/msg DP-XXXX seller|buyer [msg]`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('admin_disputes', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isBotmaster(ctx.from.id)) return;

  const { data } = await supabase.from('deals').select('*').eq('status', 'disputed').order('created_at', { ascending: false });
  if (!data?.length) return ctx.reply('No open disputes.');

  let msg = `*Open Disputes (${data.length}):*\n\n`;
  for (const d of data) {
    const assigned = d.assigned_to_username ? `@${d.assigned_to_username}` : 'Unassigned';
    msg += `\`${d.deal_id}\` | ${d.amount} USDC | ${assigned}\n`;
  }
  const kb = new InlineKeyboard().text('Back', 'admin_back');
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('admin_mods', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isBotmaster(ctx.from.id)) return;

  const { data } = await supabase.from('moderators').select('*').eq('is_active', true);
  if (!data?.length) return ctx.reply('No moderators. Use /addmod @username');

  let msg = '*Moderators:*\n\n';
  for (const m of data) msg += `@${m.username}\n`;
  const kb = new InlineKeyboard().text('Add Mod', 'admin_addmod').text('Back', 'admin_back');
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('admin_addmod', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isBotmaster(ctx.from.id)) return;
  const kb = new InlineKeyboard().text('Back', 'admin_back');
  await ctx.reply(`*Add Moderator*\n\nType: \`/addmod @username\``, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('admin_logs', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isBotmaster(ctx.from.id)) return;

  const { data } = await supabase.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(10);
  if (!data?.length) return ctx.reply('No logs found.');

  let msg = '*Recent Logs:*\n\n';
  for (const l of data) {
    msg += `@${l.admin_username}: ${l.action}${l.deal_id ? ` (${l.deal_id})` : ''}\n`;
  }
  const kb = new InlineKeyboard().text('Back', 'admin_back');
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('admin_back', async (ctx) => {
  await ctx.answerCallbackQuery();
  if (!isBotmaster(ctx.from.id)) return;
  const kb = new InlineKeyboard()
    .text('Disputes', 'admin_disputes')
    .text('Mods', 'admin_mods')
    .row()
    .text('Add Mod', 'admin_addmod')
    .text('Logs', 'admin_logs');
  await ctx.reply(`*Admin Panel* 👑`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.command('modhelp', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const kb = new InlineKeyboard()
    .text('My Disputes', 'mod_mydisputes')
    .text('Help', 'guide_help');

  await ctx.reply(`*Mod Panel* 🛡️\n\nCommands:\n/mydisputes • /viewevidence DP-XXXX\n/msg DP-XXXX seller|buyer [msg]\n/resolve DP-XXXX release|refund`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('mod_mydisputes', async (ctx) => {
  await ctx.answerCallbackQuery();
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return;

  const { data } = await supabase.from('deals').select('*').eq('status', 'disputed').eq('assigned_to_telegram_id', ctx.from.id);
  if (!data?.length) return ctx.reply('No disputes assigned to you.');

  let msg = `*Your Disputes (${data.length}):*\n\n`;
  for (const d of data) {
    msg += `\`${d.deal_id}\` | ${d.amount} USDC\n@${d.seller_username} vs @${d.buyer_username}\n\n`;
  }
  const kb = new InlineKeyboard().text('Back', 'mod_back');
  await ctx.reply(msg, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.callbackQuery('mod_back', async (ctx) => {
  await ctx.answerCallbackQuery();
  const kb = new InlineKeyboard()
    .text('My Disputes', 'mod_mydisputes')
    .text('Help', 'guide_help');
  await ctx.reply(`*Mod Panel* 🛡️`, { reply_markup: kb, parse_mode: 'Markdown' });
});

bot.command('addmod', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/addmod\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /addmod @username');

  const modUsername = match[1];
  const { data: user } = await supabase.from('users').select('telegram_id').ilike('username', modUsername).single();
  if (!user) return ctx.reply(`@${modUsername} not found. They need to /wallet first.`);

  // Use insert with on conflict instead of upsert
  const { error } = await supabase.from('moderators').insert({
    telegram_id: user.telegram_id,
    username: modUsername,
    added_by: ctx.from.username,
    is_active: true
  });

  // If duplicate, update instead
  if (error?.code === '23505') {
    const { error: updateError } = await supabase.from('moderators')
      .update({ is_active: true, username: modUsername, added_by: ctx.from.username })
      .eq('telegram_id', user.telegram_id);
    if (updateError) return ctx.reply('Something went wrong. Please try again shortly.');
  } else if (error) {
    return ctx.reply('Something went wrong. Please try again shortly.');
  }

  await logAdminAction('add_mod', null, ctx.from.id, ctx.from.username, modUsername, 'Added moderator');
  await ctx.reply(`✅ @${modUsername} is now a moderator.`);

  try {
    await bot.api.sendMessage(user.telegram_id, `🛡️ You are now a DealPact Moderator!\n\n/modhelp for commands.`);
  } catch (e) {}
});

bot.command('removemod', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/removemod\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /removemod @username');

  const { error } = await supabase.from('moderators').update({ is_active: false }).ilike('username', match[1]);
  if (error) return ctx.reply('Something went wrong. Please try again shortly.');

  await logAdminAction('remove_mod', null, ctx.from.id, ctx.from.username, match[1], 'Removed moderator');
  await ctx.reply(`✅ @${match[1]} removed from moderators.`);
});

bot.command('mods', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const { data, error } = await supabase.from('moderators').select('*').eq('is_active', true);
  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  if (!data?.length) return ctx.reply('No moderators. /addmod @username');

  let msg = '🛡️ Moderators:\n\n';
  for (const m of data) msg += `@${m.username}\n`;
  await ctx.reply(msg);
});

bot.command('disputes', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  let query = supabase.from('deals').select('*').eq('status', 'disputed').order('created_at', { ascending: false });

  if (role === 'moderator') {
    query = query.eq('assigned_to_telegram_id', ctx.from.id);
  }

  const { data, error } = await query;
  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  if (!data?.length) return ctx.reply('No open disputes.');

  let msg = `⚠️ Open Disputes (${data.length}):\n\n`;
  for (const d of data) {
    const assigned = d.assigned_to_username ? `@${d.assigned_to_username}` : '❌ Unassigned';
    msg += `${d.deal_id} | ${d.amount} USDC\n`;
    msg += `  @${d.seller_username} vs @${d.buyer_username}\n`;
    msg += `  Assigned: ${assigned}\n`;
    msg += `  Reason: ${(d.dispute_reason || 'N/A').substring(0, 30)}\n\n`;
  }
  await ctx.reply(msg);
});

bot.command('mydisputes', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const { data, error } = await supabase.from('deals').select('*').eq('status', 'disputed').eq('assigned_to_telegram_id', ctx.from.id);
  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  if (!data?.length) return ctx.reply('No disputes assigned to you.');

  let msg = `🛡️ Your Disputes (${data.length}):\n\n`;
  for (const d of data) {
    msg += `${d.deal_id} | ${d.amount} USDC\n  @${d.seller_username} vs @${d.buyer_username}\n\n`;
  }
  await ctx.reply(msg);
});

bot.command('assign', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/assign\s+(DP-\w+)\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /assign DP-XXXX @moderator');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Not disputed. Status: ${deal.status}`);

  const modUsername = match[2];
  const { data: modUser } = await supabase.from('users').select('telegram_id').ilike('username', modUsername).single();
  if (!modUser) return ctx.reply(`@${modUsername} not found.`);

  const { error } = await supabase.from('deals').update({
    assigned_to_telegram_id: modUser.telegram_id,
    assigned_to_username: modUsername,
    assigned_at: new Date().toISOString(),
    assigned_by: ctx.from.username
  }).ilike('deal_id', deal.deal_id);

  if (error) return ctx.reply('Something went wrong. Please try again shortly.');

  await logAdminAction('assign', deal.deal_id, ctx.from.id, ctx.from.username, modUsername, 'Assigned');
  await ctx.reply(`✅ ${deal.deal_id} assigned to @${modUsername}`);

  try {
    await bot.api.sendMessage(modUser.telegram_id, `🛡️ Dispute assigned: ${deal.deal_id}\n\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\n\n/viewevidence ${deal.deal_id}`);
  } catch (e) {}

  await notifyParties(deal, `📋 ${deal.deal_id}: Now being reviewed by Admin Team.`);
});

bot.command('unassign', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/unassign\s+(DP-\w+)$/i);
  if (!match) return ctx.reply('Usage: /unassign DP-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  await supabase.from('deals').update({
    assigned_to_telegram_id: null,
    assigned_to_username: null
  }).ilike('deal_id', deal.deal_id);

  await logAdminAction('unassign', deal.deal_id, ctx.from.id, ctx.from.username, deal.assigned_to_username, 'Unassigned');
  await ctx.reply(`✅ ${deal.deal_id} unassigned.`);
});

bot.command('msg', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/msg\s+(DP-\w+)\s+(seller|buyer)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /msg DP-XXXX seller|buyer message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  if (role === 'moderator' && deal.assigned_to_telegram_id !== ctx.from.id) {
    return ctx.reply('Only assigned disputes.');
  }

  const target = match[2].toLowerCase();
  let targetId = target === 'seller' ? deal.seller_telegram_id : null;
  if (target === 'buyer') {
    const { data } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
    targetId = data?.telegram_id;
  }

  if (!targetId) return ctx.reply(`Cannot find ${target}.`);

  try {
    await bot.api.sendMessage(targetId, `📨 Admin Team (${deal.deal_id}):\n\n${match[3]}`);
    await logAdminAction('msg', deal.deal_id, ctx.from.id, ctx.from.username, target, match[3]);
    await ctx.reply(`✅ Sent to ${target}.`);
  } catch (e) {
    await ctx.reply('Something went wrong. Please try again shortly.');
  }
});

bot.command('broadcast', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/broadcast\s+(DP-\w+)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /broadcast DP-XXXX message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  await notifyParties(deal, `📢 Admin (${deal.deal_id}):\n\n${match[2]}`);
  await logAdminAction('broadcast', deal.deal_id, ctx.from.id, ctx.from.username, 'both', match[2]);
  await ctx.reply('✅ Sent to both parties.');
});

bot.command('resolve', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/resolve\s+(DP-\w+)\s+(release|refund)$/i);
  if (!match) return ctx.reply('Usage: /resolve DP-XXXX release|refund');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Not disputed. Status: ${deal.status}`);

  if (role === 'moderator' && deal.assigned_to_telegram_id !== ctx.from.id) {
    return ctx.reply('Only assigned disputes.');
  }

  const decision = match[2].toLowerCase();

  // Get on-chain status first
  const onChain = await getOnChainStatus(deal.deal_id);

  if (onChain.exists) {
    await ctx.reply(`On-chain status: ${onChain.status} (4=Disputed)\nResolving...`);

    try {
      let tx;
      if (decision === 'release') {
        tx = await escrowContract.resolveRelease(onChain.chainId);
      } else {
        tx = await escrowContract.refund(onChain.chainId);
      }
      await ctx.reply(`Tx: https://basescan.org/tx/${tx.hash}`);
      await waitWithTimeout(tx);
      await ctx.reply('✅ On-chain resolved.');
    } catch (e) {
      await ctx.reply('On-chain transaction failed. Updating database anyway...');
    }
  }

  const newStatus = decision === 'release' ? 'completed' : 'refunded';
  const { error: updateError } = await supabase.from('deals').update({
    status: newStatus,
    resolved_by: ctx.from.username,
    completed_at: new Date().toISOString()
  }).ilike('deal_id', deal.deal_id);

  if (updateError) {
    console.error('Resolve update error:', updateError);
    return ctx.reply(`Failed to update database: ${updateError.message}`);
  }

  await logAdminAction('resolve', deal.deal_id, ctx.from.id, ctx.from.username, null, decision);
  await ctx.reply(`⚖️ ${deal.deal_id}: ${decision === 'release' ? 'Released to seller' : 'Refunded to buyer'}\n\nStatus updated to: ${newStatus}`);

  const resolveReviewKb = new InlineKeyboard().text('Review this deal', `review_${deal.deal_id}`);
  const sellerMsg = decision === 'release' ? '✅ Funds released to you!' : '❌ Refunded to buyer.';
  const buyerMsg = decision === 'refund' ? '✅ Funds refunded to you!' : '❌ Released to seller.';

  try { await bot.api.sendMessage(deal.seller_telegram_id, `⚖️ ${deal.deal_id}\n\n${sellerMsg}`, { reply_markup: resolveReviewKb }); } catch (e) {}

  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  if (buyerUser?.telegram_id) {
    try { await bot.api.sendMessage(buyerUser.telegram_id, `⚖️ ${deal.deal_id}\n\n${buyerMsg}`, { reply_markup: resolveReviewKb }); } catch (e) {}
  }
});

bot.command('logs', async (ctx) => {
  if (!isBotmaster(ctx.from.id)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/logs(?:@\w+)?(?:\s+(DP-\w+))?$/i);
  const dealId = match?.[1];

  let query = supabase.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(15);
  if (dealId) query = query.ilike('deal_id', dealId);

  const { data, error } = await query;
  if (error) return ctx.reply('Something went wrong. Please try again shortly.');
  if (!data?.length) return ctx.reply('No logs found.');

  let msg = `📋 Logs${dealId ? ` for ${dealId.toUpperCase()}` : ''}:\n\n`;
  for (const l of data) {
    const date = new Date(l.created_at).toLocaleString();
    msg += `${date} @${l.admin_username}: ${l.action}`;
    if (l.deal_id) msg += ` (${l.deal_id})`;
    if (l.target_user) msg += ` → ${l.target_user}`;
    msg += '\n';
  }
  await ctx.reply(msg);
});

// Catch-all (rate limited to prevent spam/DoS)
bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) {
    if (!isRateLimited(ctx.from.id, 5000)) {
      await ctx.reply('Unknown command. Try /help');
    }
  }
});

// Poll for funded deals
async function pollDeals() {
  try {
    const { data: pending } = await supabase
      .from('deals')
      .select('*')
      .eq('status', 'pending_deposit')
      .not('contract_deal_id', 'is', null);

    for (const deal of pending || []) {
      try {
        const chainId = await escrowContract.externalIdToDealId(deal.deal_id);
        if (chainId.toString() === '0') continue;

        const onChain = await escrowContract.deals(chainId);
        if (Number(onChain[4]) === 1) {
          console.log(`Funded: ${deal.deal_id}`);
          await supabase.from('deals').update({ status: 'funded', funded_at: new Date().toISOString() }).ilike('deal_id', deal.deal_id);

          if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `💰 ${deal.deal_id} FUNDED!\n\n${deal.amount} USDC locked.`); } catch (e) {}

          const { data: buyer } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
          if (buyer?.telegram_id) {
            const fundedKb = new InlineKeyboard().text('Release Funds', `release_${deal.deal_id}`).text('Dispute', `dispute_${deal.deal_id}`);
            try { await bot.api.sendMessage(buyer.telegram_id, `✅ *${deal.deal_id} Funded!*\n\nAmount: ${deal.amount} USDC\n\nOnce you receive the service/item, tap Release. If there's a problem, tap Dispute.`, { reply_markup: fundedKb, parse_mode: 'Markdown' }); } catch (e) {}
          }
        }
      } catch (e) {}
    }

    const { data: funded } = await supabase
      .from('deals')
      .select('*')
      .eq('status', 'funded')
      .not('contract_deal_id', 'is', null);

    for (const deal of funded || []) {
      try {
        const chainId = await escrowContract.externalIdToDealId(deal.deal_id);
        if (chainId.toString() === '0') continue;

        const onChain = await escrowContract.deals(chainId);
        if (Number(onChain[4]) === 2) {
          console.log(`Completed on-chain: ${deal.deal_id}`);
          await supabase.from('deals').update({ status: 'completed', completed_at: new Date().toISOString() }).ilike('deal_id', deal.deal_id);

          const reviewKb = new InlineKeyboard().text(`Review this deal`, `review_${deal.deal_id}`);
          if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `✅ ${deal.deal_id} — Deal Complete!\n\nFunds released to you.\n\nLeave a review for the buyer:`, { reply_markup: reviewKb }); } catch (e) {}

          const { data: buyer } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
          if (buyer?.telegram_id) try { await bot.api.sendMessage(buyer.telegram_id, `✅ ${deal.deal_id} — Deal Complete!\n\nFunds released to seller.\n\nLeave a review for the seller:`, { reply_markup: reviewKb }); } catch (e) {}
        }
      } catch (e) {}
    }

    for (const deal of funded || []) {
      if (deal.release_reminder_sent || !deal.funded_at) continue;
      const elapsed = Date.now() - new Date(deal.funded_at).getTime();
      if (elapsed >= 24 * 60 * 60 * 1000) {
        await supabase.from('deals').update({ release_reminder_sent: true }).ilike('deal_id', deal.deal_id);

        const { data: buyer } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
        if (buyer?.telegram_id) try { await bot.api.sendMessage(buyer.telegram_id, `⏱️ ${deal.deal_id} — 24hr release window has expired.\n\nPlease /release ${deal.deal_id} or /dispute ${deal.deal_id}.`); } catch (e) {}
        if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `⏱️ ${deal.deal_id} — 24hr release window has expired. Buyer has been reminded.\n\nYou may /dispute ${deal.deal_id} if needed.`); } catch (e) {}
      }
    }
  } catch (e) {
    console.error('Poll:', e.message);
  }
}

// Error handler
bot.catch(async (err) => {
  console.error('Bot error:', err.message);
  try {
    await err.ctx?.reply('Something went wrong. Please try again shortly.');
  } catch (e) {}
});

// Start
bot.start();
console.log('DealPact v3.2 running!');
console.log('Contract:', CONTRACT_ADDRESS);
setInterval(pollDeals, 30000);
pollDeals();