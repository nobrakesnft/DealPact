// TrustLock Bot v3.2 - All Fixes
require('dotenv').config();

const { Bot } = require('grammy');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

// Initialize
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const provider = new ethers.JsonRpcProvider('https://sepolia.base.org');
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

// Botmaster usernames (full power)
const BOTMASTER_USERNAMES = (process.env.ADMIN_USERNAMES || 'nobrakesnft').toLowerCase().split(',').map(s => s.trim());

// ============ HELPER FUNCTIONS ============

function generateDealId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `TL-${code}`;
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

function isBotmaster(username) {
  return BOTMASTER_USERNAMES.includes(username?.toLowerCase());
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
  if (isBotmaster(ctx.from.username)) return { isAdmin: true, role: 'botmaster' };
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
    return ctx.reply(`💰 CREATE A NEW DEAL\n\nStep 1: /wallet 0xYourAddress\nStep 2: /new @buyer 50 Description\n\nNeed help? /help`);
  }

  if (param?.startsWith('dispute_')) {
    const dealId = param.replace('dispute_', '').toUpperCase();
    return ctx.reply(`⚠️ Open Dispute for ${dealId}\n\nCommand: /dispute ${dealId} [reason]`);
  }

  await ctx.reply(`🔒 TrustLock - Secure Crypto Escrow\n\nTrustLock acts as a neutral escrow intermediary.\nFunds are held on-chain and released only by buyer action or admin resolution.\n\n1. Seller: /new @buyer 50 desc\n2. Buyer: /fund TL-XXXX\n3. Deliver goods\n4. Buyer: /release TL-XXXX\n\nCommands: /help\n\n⚠️ Admins will NEVER DM you first.\nOnly interact with admins inside this bot.`);
});

bot.command('help', async (ctx) => {
  const { role } = await isAnyAdmin(ctx);
  let adminNote = '';
  if (role === 'botmaster') adminNote = '\n\n👑 Botmaster: /adminhelp';
  else if (role === 'moderator') adminNote = '\n\n🛡️ Moderator: /modhelp';

  await ctx.reply(`📖 TrustLock Commands

SETUP: /wallet 0x...

DEALS
/new @buyer 100 desc
/fund TL-XXXX
/status TL-XXXX
/deals
/release TL-XXXX
/cancel TL-XXXX

DISPUTES
/dispute TL-XXXX reason
/evidence TL-XXXX msg
/viewevidence TL-XXXX
/canceldispute TL-XXXX

RATINGS
/review TL-XXXX 5 Great!
/rep @user\n\n🔐 Safety: TrustLock admins will never DM you first.${adminNote}`);
});

bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/wallet\s+(0x[a-fA-F0-9]{40})$/i);

  if (!match) {
    const { data: user } = await supabase.from('users').select('wallet_address').eq('telegram_id', userId).single();
    return ctx.reply(user?.wallet_address ? `Your wallet: ${user.wallet_address}` : 'Usage: /wallet 0xYourAddress');
  }

  const { error } = await supabase.from('users').upsert({
    telegram_id: userId,
    username: username,
    wallet_address: match[1].toLowerCase()
  }, { onConflict: 'telegram_id' });

  await ctx.reply(error ? `Failed: ${error.message}` : `✅ Wallet registered: ${match[1]}`);
});

bot.command('new', async (ctx) => {
  const senderId = ctx.from.id;
  const senderUsername = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/new\s+@(\w+)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);

  if (!match) return ctx.reply('Format: /new @buyer 50 description');

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

  if (error) return ctx.reply(`Failed: ${error.message}`);

  await ctx.reply(`✅ Deal Created: ${dealId}\n\nSeller: @${senderUsername}\nBuyer: @${buyerUsername}\nAmount: ${amount} USDC\n\n@${buyerUsername} → /fund ${dealId}\n\n⚠️ Escrow Rules\n• Seller must deliver as agreed\n• Buyer must release or dispute after delivery\n• Either party may dispute at any time\n• Unreleased deals may be reviewed by admins`);
});

bot.command('status', async (ctx) => {
  const match = ctx.message.text.match(/^\/status\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /status TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[deal.status] || '❓';

  let extra = '';
  if (deal.status === 'disputed') {
    extra = `\n\n⚠️ DISPUTED\nReason: ${deal.dispute_reason || 'N/A'}`;
    extra += deal.assigned_to_username ? '\nStatus: Being reviewed' : '\nStatus: Awaiting review';
  } else if (deal.status === 'funded' && deal.funded_at) {
    const msLeft = new Date(deal.funded_at).getTime() + 24 * 60 * 60 * 1000 - Date.now();
    if (msLeft > 0) {
      const h = Math.floor(msLeft / 3600000);
      const m = Math.floor((msLeft % 3600000) / 60000);
      extra = `\n\n⏱️ Release window: ${h}h ${m}m remaining`;
    } else {
      extra = `\n\n⏱️ Release window expired — please /release ${deal.deal_id} or /dispute ${deal.deal_id}`;
    }
  }

  await ctx.reply(`${emoji} ${deal.deal_id} - ${deal.status.toUpperCase()}\n\nSeller: @${deal.seller_username}\nBuyer: @${deal.buyer_username}\nAmount: ${deal.amount} USDC\nDesc: ${deal.description}${extra}`);
});

bot.command('deals', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_telegram_id.eq.${userId},buyer_username.ilike.${username}`)
    .order('created_at', { ascending: false })
    .limit(15);

  if (error) return ctx.reply(`Error: ${error.message}`);
  if (!data?.length) return ctx.reply('No deals. Create: /new');

  let msg = 'Your Deals:\n\n';
  for (const d of data) {
    const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[d.status] || '❓';
    const role = d.seller_telegram_id === userId ? 'S' : 'B';
    msg += `${emoji} ${d.deal_id} | ${d.amount} USDC | ${role}\n`;
  }
  await ctx.reply(msg);
});

bot.command('fund', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/fund\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /fund TL-XXXX');

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
      return ctx.reply(`👇 TAP TO DEPOSIT:\nhttps://nobrakesnft.github.io/TrustLock?deal=${deal.deal_id}`);
    }
  } catch (e) {}

  await ctx.reply('Creating on-chain deal...');

  try {
    const tx = await escrowContract.createDeal(deal.deal_id, sellerUser.wallet_address, buyerUser.wallet_address, BigInt(Math.floor(deal.amount * 1e6)));
    await ctx.reply(`Tx: https://sepolia.basescan.org/tx/${tx.hash}`);
    await tx.wait();
    await supabase.from('deals').update({ contract_deal_id: deal.deal_id, tx_hash: tx.hash }).ilike('deal_id', deal.deal_id);
    await ctx.reply(`✅ Ready!\n\n👇 TAP TO DEPOSIT:\nhttps://nobrakesnft.github.io/TrustLock?deal=${deal.deal_id}`);
  } catch (e) {
    await ctx.reply(`Failed: ${e.shortMessage || e.message}`);
  }
});

bot.command('release', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/release\s+(TL-\w+)(?:\s+(confirm))?$/i);
  if (!match) return ctx.reply('Usage: /release TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('Only buyer can release.');

  if (deal.status === 'disputed' && !match[2]) {
    return ctx.reply(`⚠️ Deal is disputed!\n\nTo release anyway: /release ${deal.deal_id} confirm`);
  }

  if (deal.status !== 'funded' && deal.status !== 'disputed') {
    return ctx.reply(`Cannot release. Status: ${deal.status}`);
  }

  await ctx.reply(`📤 Release: ${deal.deal_id}\nAmount: ${deal.amount} USDC\n\n👇 TAP TO RELEASE:\nhttps://nobrakesnft.github.io/TrustLock?deal=${deal.deal_id}&action=release`);
});

bot.command('cancel', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/cancel\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /cancel TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');
  if (!['pending_deposit', 'funded'].includes(deal.status)) return ctx.reply(`Cannot cancel. Status: ${deal.status}`);

  await supabase.from('deals').update({ status: 'cancelled' }).ilike('deal_id', deal.deal_id);
  await ctx.reply(`❌ ${deal.deal_id} cancelled.`);
});

// /dispute - Opens dispute and marks on-chain
bot.command('dispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || `user_${userId}`;
  const match = ctx.message.text.match(/^\/dispute\s+(TL-\w+)(?:\s+(.+))?$/i);
  if (!match) return ctx.reply('Usage: /dispute TL-XXXX reason');

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
        await tx.wait();
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
    return ctx.reply(`Failed to open dispute: ${error.message}\n\nNote: Make sure you've run the latest SQL in Supabase!`);
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

  // Notify botmasters
  for (const admin of BOTMASTER_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
    if (adminUser?.telegram_id) {
      try {
        await bot.api.sendMessage(adminUser.telegram_id, `🔔 DISPUTE: ${deal.deal_id}\n\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\nBy: @${username}\nReason: ${reason}\n\n/disputes to view all`);
      } catch (e) {}
    }
  }
});

bot.command('evidence', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/evidence\s+(TL-\w+)(?:\s+(.+))?$/i);

  if (!match) return ctx.reply('Usage: /evidence TL-XXXX your message');

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

  if (error) return ctx.reply(`Failed: ${error.message}`);
  await ctx.reply(`✅ Evidence submitted for ${deal.deal_id}`);
});

bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const caption = ctx.message.caption || '';

  const match = caption.match(/^(TL-\w+)(?:\s+(.*))?$/i);
  if (!match) return ctx.reply(`📸 Photo evidence: Send with caption TL-XXXX description`);

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

  if (error) return ctx.reply(`Failed: ${error.message}`);
  await ctx.reply(`✅ Photo evidence submitted for ${deal.deal_id}`);
});

bot.command('viewevidence', async (ctx) => {
  const match = ctx.message.text.match(/^\/viewevidence\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /viewevidence TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const { data: evidence, error } = await supabase.from('evidence').select('*').ilike('deal_id', deal.deal_id).order('created_at', { ascending: true });

  if (error) return ctx.reply(`Error: ${error.message}`);
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
  const match = ctx.message.text.match(/^\/canceldispute\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /canceldispute TL-XXXX');

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
  const match = ctx.message.text.match(/^\/review\s+(TL-\w+)\s+([1-5])(?:\s+(.+))?$/i);
  if (!match) return ctx.reply('Usage: /review TL-XXXX 5 comment');

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
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  await ctx.reply(`👑 BOTMASTER COMMANDS

MOD MANAGEMENT
/addmod @user
/removemod @user
/mods

DISPUTES
/disputes - All open disputes
/assign TL-XXXX @mod
/unassign TL-XXXX
/viewevidence TL-XXXX
/resolve TL-XXXX release|refund

COMMUNICATION
/msg TL-XXXX seller|buyer [msg]
/broadcast TL-XXXX [msg]

AUDIT
/logs
/logs TL-XXXX`);
});

bot.command('modhelp', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');
  await ctx.reply(`🛡️ MOD COMMANDS\n\n/mydisputes\n/viewevidence TL-XXXX\n/msg TL-XXXX seller|buyer [msg]\n/resolve TL-XXXX release|refund`);
});

bot.command('addmod', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

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
    if (updateError) return ctx.reply(`Failed: ${updateError.message}`);
  } else if (error) {
    return ctx.reply(`Failed: ${error.message}`);
  }

  await logAdminAction('add_mod', null, ctx.from.id, ctx.from.username, modUsername, 'Added moderator');
  await ctx.reply(`✅ @${modUsername} is now a moderator.`);

  try {
    await bot.api.sendMessage(user.telegram_id, `🛡️ You are now a TrustLock Moderator!\n\n/modhelp for commands.`);
  } catch (e) {}
});

bot.command('removemod', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/removemod\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /removemod @username');

  const { error } = await supabase.from('moderators').update({ is_active: false }).ilike('username', match[1]);
  if (error) return ctx.reply(`Failed: ${error.message}`);

  await logAdminAction('remove_mod', null, ctx.from.id, ctx.from.username, match[1], 'Removed moderator');
  await ctx.reply(`✅ @${match[1]} removed from moderators.`);
});

bot.command('mods', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const { data, error } = await supabase.from('moderators').select('*').eq('is_active', true);
  if (error) return ctx.reply(`Error: ${error.message}`);
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
  if (error) return ctx.reply(`Error: ${error.message}`);
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
  if (error) return ctx.reply(`Error: ${error.message}`);
  if (!data?.length) return ctx.reply('No disputes assigned to you.');

  let msg = `🛡️ Your Disputes (${data.length}):\n\n`;
  for (const d of data) {
    msg += `${d.deal_id} | ${d.amount} USDC\n  @${d.seller_username} vs @${d.buyer_username}\n\n`;
  }
  await ctx.reply(msg);
});

bot.command('assign', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/assign\s+(TL-\w+)\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /assign TL-XXXX @moderator');

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

  if (error) return ctx.reply(`Failed: ${error.message}`);

  await logAdminAction('assign', deal.deal_id, ctx.from.id, ctx.from.username, modUsername, 'Assigned');
  await ctx.reply(`✅ ${deal.deal_id} assigned to @${modUsername}`);

  try {
    await bot.api.sendMessage(modUser.telegram_id, `🛡️ Dispute assigned: ${deal.deal_id}\n\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\n\n/viewevidence ${deal.deal_id}`);
  } catch (e) {}

  await notifyParties(deal, `📋 ${deal.deal_id}: Now being reviewed by Admin Team.`);
});

bot.command('unassign', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/unassign\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /unassign TL-XXXX');

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

  const match = ctx.message.text.match(/^\/msg\s+(TL-\w+)\s+(seller|buyer)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /msg TL-XXXX seller|buyer message');

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
    await ctx.reply(`Failed: ${e.message}`);
  }
});

bot.command('broadcast', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/broadcast\s+(TL-\w+)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /broadcast TL-XXXX message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  await notifyParties(deal, `📢 Admin (${deal.deal_id}):\n\n${match[2]}`);
  await logAdminAction('broadcast', deal.deal_id, ctx.from.id, ctx.from.username, 'both', match[2]);
  await ctx.reply('✅ Sent to both parties.');
});

bot.command('resolve', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/resolve\s+(TL-\w+)\s+(release|refund)$/i);
  if (!match) return ctx.reply('Usage: /resolve TL-XXXX release|refund');

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
      await ctx.reply(`Tx: https://sepolia.basescan.org/tx/${tx.hash}`);
      await tx.wait();
      await ctx.reply('✅ On-chain resolved.');
    } catch (e) {
      await ctx.reply(`On-chain error: ${e.shortMessage || e.message}\n\nUpdating database anyway...`);
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

  const sellerMsg = decision === 'release' ? '✅ Funds released to you!' : '❌ Refunded to buyer.';
  const buyerMsg = decision === 'refund' ? '✅ Funds refunded to you!' : '❌ Released to seller.';

  try { await bot.api.sendMessage(deal.seller_telegram_id, `⚖️ ${deal.deal_id}\n\n${sellerMsg}`); } catch (e) {}

  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  if (buyerUser?.telegram_id) {
    try { await bot.api.sendMessage(buyerUser.telegram_id, `⚖️ ${deal.deal_id}\n\n${buyerMsg}`); } catch (e) {}
  }
});

bot.command('logs', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/logs(?:@\w+)?(?:\s+(TL-\w+))?$/i);
  const dealId = match?.[1];

  let query = supabase.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(15);
  if (dealId) query = query.ilike('deal_id', dealId);

  const { data, error } = await query;
  if (error) return ctx.reply(`Error: ${error.message}`);
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

// Catch-all
bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) await ctx.reply('/help');
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
          if (buyer?.telegram_id) try { await bot.api.sendMessage(buyer.telegram_id, `✅ ${deal.deal_id} deposited!\n\nPlease /release ${deal.deal_id} or /dispute ${deal.deal_id} within 24 hours.`); } catch (e) {}
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

          if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `✅ ${deal.deal_id}\n\nFunds released to you!`); } catch (e) {}

          const { data: buyer } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
          if (buyer?.telegram_id) try { await bot.api.sendMessage(buyer.telegram_id, `✅ ${deal.deal_id}\n\nDeal completed! Funds released to seller.`); } catch (e) {}
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
bot.catch((err) => {
  console.error('Bot error:', err.message);
});

// Start
bot.start();
console.log('TrustLock v3.2 running!');
console.log('Contract:', CONTRACT_ADDRESS);
console.log('Botmasters:', BOTMASTER_USERNAMES.join(', '));
setInterval(pollDeals, 30000);
pollDeals();