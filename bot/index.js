// TrustLock Bot v3.0 - Admin Panel
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

// Get deal with case-insensitive matching
async function getDeal(dealId) {
  const normalized = dealId.toUpperCase().trim();
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .ilike('deal_id', normalized)
    .single();
  return { deal: data, error };
}

// Check if user is botmaster
function isBotmaster(username) {
  return BOTMASTER_USERNAMES.includes(username?.toLowerCase());
}

// Check if user is moderator
async function isModerator(telegramId) {
  const { data } = await supabase
    .from('moderators')
    .select('*')
    .eq('telegram_id', telegramId)
    .eq('is_active', true)
    .single();
  return !!data;
}

// Check if user is any admin (botmaster or moderator)
async function isAnyAdmin(ctx) {
  if (isBotmaster(ctx.from.username)) return { isAdmin: true, role: 'botmaster' };
  if (await isModerator(ctx.from.id)) return { isAdmin: true, role: 'moderator' };
  return { isAdmin: false, role: null };
}

// Log admin action
async function logAdminAction(action, dealId, adminTelegramId, adminUsername, targetUser, details) {
  try {
    await supabase.from('admin_logs').insert({
      action,
      deal_id: dealId,
      admin_telegram_id: adminTelegramId,
      admin_username: adminUsername,
      target_user: targetUser,
      details
    });
  } catch (e) {
    console.error('Failed to log admin action:', e.message);
  }
}

// Notify parties about dispute status (without revealing admin identity)
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

// ============ USER COMMANDS ============

// /start
bot.command('start', async (ctx) => {
  const param = ctx.message.text.split(' ')[1]?.toLowerCase();

  if (param === 'newdeal') {
    await ctx.reply(`
💰 CREATE A NEW DEAL

Step 1️⃣ - Register your wallet (one time):
/wallet 0xYourWalletAddress

Step 2️⃣ - Create the deal:
/new @buyerUsername amount description

Example:
/new @john 50 Logo design work

Need help? /help
    `);
    return;
  }

  if (param?.startsWith('dispute_')) {
    const dealId = param.replace('dispute_', '').toUpperCase();
    await ctx.reply(`
⚠️ Open Dispute for ${dealId}

Command: /dispute ${dealId} [reason]

Example:
/dispute ${dealId} Seller not responding
    `);
    return;
  }

  await ctx.reply(`
🔒 TrustLock - Secure Crypto Escrow

How it works:
1. Seller: /new @buyer 50 Logo design
2. Buyer: /fund TL-XXXX → deposits USDC
3. Seller delivers goods/service
4. Buyer: /release TL-XXXX → pays seller

Commands: /help
Network: Base Sepolia
  `);
});

// /help
bot.command('help', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);

  let adminNote = '';
  if (role === 'botmaster') adminNote = '\n\n👑 Botmaster: /adminhelp';
  else if (role === 'moderator') adminNote = '\n\n🛡️ Moderator: /modhelp';

  await ctx.reply(`
📖 TrustLock Commands

SETUP
/wallet 0x... - Register wallet

DEALS
/new @buyer 100 desc - Create deal
/fund TL-XXXX - Deposit link
/status TL-XXXX - Check status
/deals - Your deals
/release TL-XXXX - Pay seller
/cancel TL-XXXX - Cancel

DISPUTES
/dispute TL-XXXX reason - Open dispute
/evidence TL-XXXX msg - Add evidence
/viewevidence TL-XXXX - View evidence
/canceldispute TL-XXXX - Cancel dispute

RATINGS
/review TL-XXXX 5 Great! - Leave review
/rep @user - Check reputation${adminNote}
  `);
});

// /wallet
bot.command('wallet', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/wallet\s+(0x[a-fA-F0-9]{40})$/i);

  if (!match) {
    const { data: user } = await supabase.from('users').select('wallet_address').eq('telegram_id', userId).single();
    await ctx.reply(user?.wallet_address ? `Your wallet: ${user.wallet_address}` : 'Usage: /wallet 0xYourAddress');
    return;
  }

  const { error } = await supabase.from('users').upsert({
    telegram_id: userId,
    username: username,
    wallet_address: match[1].toLowerCase()
  }, { onConflict: 'telegram_id' });

  await ctx.reply(error ? 'Failed to save.' : `✅ Wallet registered: ${match[1]}`);
});

// /new
bot.command('new', async (ctx) => {
  const senderId = ctx.from.id;
  const senderUsername = ctx.from.username || 'Anonymous';
  const match = ctx.message.text.match(/^\/new\s+@(\w+)\s+(\d+(?:\.\d+)?)\s+(.+)$/i);

  if (!match) {
    await ctx.reply('Format: /new @buyer amount description\nExample: /new @john 50 Logo design');
    return;
  }

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

  if (error) return ctx.reply('Failed to create deal.');

  await ctx.reply(`
✅ Deal Created: ${dealId}

Seller: @${senderUsername}
Buyer: @${buyerUsername}
Amount: ${amount} USDC
Desc: ${description}

@${buyerUsername} → /fund ${dealId}
  `);
});

// /status
bot.command('status', async (ctx) => {
  const match = ctx.message.text.match(/^\/status\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /status TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[deal.status] || '❓';

  let disputeInfo = '';
  if (deal.status === 'disputed') {
    disputeInfo = `\n\n⚠️ DISPUTED\nReason: ${deal.dispute_reason || 'N/A'}`;
    if (deal.assigned_to_username) {
      disputeInfo += '\nStatus: Being reviewed by Admin Team';
    } else {
      disputeInfo += '\nStatus: Awaiting admin assignment';
    }
  }

  await ctx.reply(`
${emoji} ${deal.deal_id} - ${deal.status.replace('_', ' ').toUpperCase()}

Seller: @${deal.seller_username}
Buyer: @${deal.buyer_username}
Amount: ${deal.amount} USDC
Desc: ${deal.description}${disputeInfo}
  `);
});

// /deals
bot.command('deals', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;

  const { data } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_telegram_id.eq.${userId},buyer_username.ilike.${username}`)
    .order('created_at', { ascending: false })
    .limit(10);

  if (!data?.length) return ctx.reply('No deals. Create: /new');

  let msg = 'Your Deals:\n\n';
  for (const d of data) {
    const emoji = { pending_deposit: '⏳', funded: '💰', completed: '✅', disputed: '⚠️', cancelled: '❌', refunded: '↩️' }[d.status] || '❓';
    const role = d.seller_telegram_id === userId ? 'S' : 'B';
    msg += `${emoji} ${d.deal_id} | ${d.amount} USDC | ${role}\n`;
  }
  await ctx.reply(msg + '\n/status TL-XXXX for details');
});

// /fund
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

  if (!sellerUser?.wallet_address) return ctx.reply(`Seller needs wallet: /wallet`);
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
    await ctx.reply(`Failed: ${e.message}`);
  }
});

// /release
bot.command('release', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/release\s+(TL-\w+)(?:\s+(confirm))?$/i);
  if (!match) return ctx.reply('Usage: /release TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.buyer_username.toLowerCase() !== username?.toLowerCase()) return ctx.reply('Only buyer can release.');

  const forceConfirm = match[2]?.toLowerCase() === 'confirm';

  if (deal.status === 'disputed' && !forceConfirm) {
    return ctx.reply(`⚠️ Deal is disputed!\n\nTo release anyway: /release ${deal.deal_id} confirm`);
  }

  if (deal.status !== 'funded' && deal.status !== 'disputed') {
    return ctx.reply(`Cannot release. Current status: ${deal.status}`);
  }

  await ctx.reply(`
📤 Release Funds

Deal: ${deal.deal_id}
Amount: ${deal.amount} USDC

👇 TAP TO RELEASE:
https://nobrakesnft.github.io/TrustLock?deal=${deal.deal_id}&action=release
  `);
});

// /cancel
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

  const { error } = await supabase.from('deals').update({ status: 'cancelled' }).ilike('deal_id', deal.deal_id);
  if (error) return ctx.reply('Failed to cancel. Try again.');
  await ctx.reply(`❌ ${deal.deal_id} cancelled.${deal.status === 'funded' ? '\nContact admin for on-chain refund.' : ''}`);
});

// /dispute - FIXED: now stores telegram_id too
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
  if (deal.status !== 'funded') return ctx.reply(`Cannot dispute. Current status: ${deal.status}\n\nOnly funded deals can be disputed.`);

  const reason = match[2] || 'No reason provided';

  // Update status - store both username AND telegram_id
  const { error } = await supabase.from('deals').update({
    status: 'disputed',
    disputed_by: username,
    disputed_by_telegram_id: userId,
    dispute_reason: reason,
    disputed_at: new Date().toISOString()
  }).ilike('deal_id', deal.deal_id);

  if (error) {
    console.error('Dispute update error:', error);
    return ctx.reply('Failed to open dispute. Try again.');
  }

  await ctx.reply(`
⚠️ DISPUTE OPENED

Deal: ${deal.deal_id}
Reason: ${reason}

Your dispute is now being reviewed by the Admin Team.

NEXT STEPS:
• /evidence ${deal.deal_id} [your proof]
• Send photos with caption: ${deal.deal_id} description
• /viewevidence ${deal.deal_id}

You'll be notified when an admin responds.
  `);

  // Notify other party
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  const otherPartyId = isSeller ? buyerUser?.telegram_id : deal.seller_telegram_id;

  if (otherPartyId) {
    try {
      await bot.api.sendMessage(otherPartyId, `
⚠️ DISPUTE on ${deal.deal_id}

The other party has opened a dispute.
Reason: ${reason}

The Admin Team will review this case.

Submit your evidence: /evidence ${deal.deal_id} [msg]
Or send photos with caption: ${deal.deal_id} description
      `);
    } catch (e) {}
  }

  // Notify all botmasters
  for (const admin of BOTMASTER_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
    if (adminUser?.telegram_id) {
      try {
        await bot.api.sendMessage(adminUser.telegram_id, `
🔔 NEW DISPUTE: ${deal.deal_id}

Amount: ${deal.amount} USDC
Seller: @${deal.seller_username}
Buyer: @${deal.buyer_username}
By: @${username}
Reason: ${reason}

/assign ${deal.deal_id} @moderator
/resolve ${deal.deal_id} release|refund
        `);
      } catch (e) {}
    }
  }
});

// /evidence
bot.command('evidence', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/evidence\s+(TL-\w+)(?:\s+(.+))?$/i);

  if (!match) return ctx.reply('Usage: /evidence TL-XXXX your message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') {
    return ctx.reply(`Cannot submit evidence.\n\nDeal status: ${deal.status}\nOnly disputed deals accept evidence.`);
  }

  const evidence = match[2];
  if (!evidence) return ctx.reply(`Usage: /evidence ${deal.deal_id} your message here`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);

  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');

  const { error: insertError } = await supabase.from('evidence').insert({
    deal_id: deal.deal_id,
    submitted_by: username,
    role,
    content: evidence,
    telegram_id: userId
  });

  if (insertError) {
    console.error('Evidence insert error:', insertError);
    return ctx.reply(`Failed to save evidence: ${insertError.message}`);
  }

  await ctx.reply(`✅ Evidence submitted for ${deal.deal_id}`);

  // Forward to assigned moderator or botmasters
  if (deal.assigned_to_telegram_id) {
    try {
      await bot.api.sendMessage(deal.assigned_to_telegram_id, `📋 Evidence: ${deal.deal_id}\nFrom: @${username} (${role})\n"${evidence}"`);
    } catch (e) {}
  } else {
    for (const admin of BOTMASTER_USERNAMES) {
      const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
      if (adminUser?.telegram_id && adminUser.telegram_id !== userId) {
        try {
          await bot.api.sendMessage(adminUser.telegram_id, `📋 Evidence: ${deal.deal_id}\nFrom: @${username} (${role})\n"${evidence}"`);
        } catch (e) {}
      }
    }
  }
});

// Photo evidence handler
bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const caption = ctx.message.caption || '';

  const match = caption.match(/^(TL-\w+)(?:\s+(.*))?$/i);
  if (!match) {
    return ctx.reply(`📸 To submit photo evidence:\n\nSend photo with caption: TL-XXXX description`);
  }

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') {
    return ctx.reply(`Cannot submit evidence. Deal status: ${deal.status}`);
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');
  const description = match[2]?.trim() || 'Photo evidence';
  const photo = ctx.message.photo[ctx.message.photo.length - 1];

  const { error: insertError } = await supabase.from('evidence').insert({
    deal_id: deal.deal_id,
    submitted_by: username,
    role,
    content: description,
    file_id: photo.file_id,
    file_type: 'photo',
    telegram_id: userId
  });

  if (insertError) {
    return ctx.reply(`Failed to save photo: ${insertError.message}`);
  }

  await ctx.reply(`✅ Photo evidence submitted for ${deal.deal_id}`);

  // Forward to assigned mod or botmasters
  if (deal.assigned_to_telegram_id) {
    try {
      await bot.api.sendPhoto(deal.assigned_to_telegram_id, photo.file_id, { caption: `📸 ${deal.deal_id}\nFrom: @${username} (${role})\n"${description}"` });
    } catch (e) {}
  } else {
    for (const admin of BOTMASTER_USERNAMES) {
      const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
      if (adminUser?.telegram_id && adminUser.telegram_id !== userId) {
        try {
          await bot.api.sendPhoto(adminUser.telegram_id, photo.file_id, { caption: `📸 ${deal.deal_id}\nFrom: @${username} (${role})\n"${description}"` });
        } catch (e) {}
      }
    }
  }
});

// /viewevidence
bot.command('viewevidence', async (ctx) => {
  const match = ctx.message.text.match(/^\/viewevidence\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /viewevidence TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const { data: evidence } = await supabase.from('evidence').select('*').ilike('deal_id', deal.deal_id).order('created_at', { ascending: true });

  if (!evidence?.length) {
    return ctx.reply(`📋 Evidence: ${deal.deal_id}\nStatus: ${deal.status}\n\nNo evidence yet.`);
  }

  let msg = `📋 Evidence: ${deal.deal_id}\nStatus: ${deal.status}\nReason: ${deal.dispute_reason || 'N/A'}\n\n`;

  for (const e of evidence) {
    const icon = e.file_type === 'photo' ? '📸' : '📝';
    msg += `${icon} [${e.role}] @${e.submitted_by}\n"${e.content}"\n\n`;
  }

  await ctx.reply(msg);

  for (const e of evidence) {
    if (e.file_id && e.file_type === 'photo') {
      try {
        await bot.api.sendPhoto(ctx.chat.id, e.file_id, { caption: `[${e.role}] @${e.submitted_by}` });
      } catch (err) {}
    }
  }
});

// /canceldispute - FIXED: check by telegram_id OR username, allow admins
bot.command('canceldispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/canceldispute\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /canceldispute TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Deal is not disputed. Status: ${deal.status}`);

  // Check if user is the one who opened dispute OR is an admin
  const isDisputer = deal.disputed_by_telegram_id === userId ||
                     deal.disputed_by?.toLowerCase() === username?.toLowerCase();
  const { isAdmin } = await isAnyAdmin(ctx);

  if (!isDisputer && !isAdmin) {
    return ctx.reply(`Only the person who opened the dispute or an admin can cancel it.`);
  }

  const { error } = await supabase.from('deals').update({ status: 'funded' }).ilike('deal_id', deal.deal_id);
  if (error) {
    return ctx.reply('Failed to cancel dispute. Try again.');
  }

  await logAdminAction('cancel_dispute', deal.deal_id, userId, username, null, 'Dispute cancelled');
  await ctx.reply(`✅ Dispute cancelled. ${deal.deal_id} back to funded.`);

  // Notify parties
  await notifyParties(deal, `✅ Dispute on ${deal.deal_id} has been cancelled.\n\nDeal is back to funded status.`);
});

// /review
bot.command('review', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/review\s+(TL-\w+)\s+([1-5])(?:\s+(.+))?$/i);

  if (!match) {
    return ctx.reply(`📝 Leave a Review\n\nUsage: /review TL-XXXX [1-5] [comment]\n\nExample: /review TL-ABCD 5 Great seller!`);
  }

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'completed') return ctx.reply(`Can only review completed deals.`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');

  const rating = parseInt(match[2]);
  const comment = match[3]?.trim() || '';

  const field = isSeller ? 'seller_review' : 'buyer_review';
  if (deal[field]) return ctx.reply('You already reviewed this deal.');

  const update = {
    [field]: comment || 'No comment',
    [`${isSeller ? 'seller' : 'buyer'}_rating`]: rating
  };
  await supabase.from('deals').update(update).ilike('deal_id', deal.deal_id);

  await ctx.reply(`✅ Review submitted! Rating: ${'⭐'.repeat(rating)}`);
});

// /rep
bot.command('rep', async (ctx) => {
  const match = ctx.message.text.match(/^\/rep(?:\s+@(\w+))?$/i);
  const targetUsername = match?.[1] || ctx.from.username;

  const { data: user } = await supabase.from('users').select('*').ilike('username', targetUsername).single();
  if (!user) return ctx.reply(`@${targetUsername} not found.`);

  const { data: deals } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_username.ilike.${targetUsername},buyer_username.ilike.${targetUsername}`)
    .eq('status', 'completed');

  const totalDeals = deals?.length || 0;
  const totalVolume = deals?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;

  let badge = '🆕 New';
  if (totalDeals >= 50) badge = '💎 Elite';
  else if (totalDeals >= 25) badge = '🏆 Top Trader';
  else if (totalDeals >= 10) badge = '⭐ Trusted';
  else if (totalDeals >= 3) badge = '✓ Verified';
  else if (totalDeals >= 1) badge = '👤 Active';

  await ctx.reply(`📊 @${targetUsername}\n\n${badge}\n\nDeals: ${totalDeals}\nVolume: ${totalVolume.toFixed(0)} USDC`);
});

// ============ ADMIN COMMANDS ============

// /adminhelp - Botmaster only
bot.command('adminhelp', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) {
    return ctx.reply('Botmaster only.');
  }

  await ctx.reply(`
👑 BOTMASTER COMMANDS

MODERATOR MANAGEMENT
/addmod @user - Add moderator
/removemod @user - Remove moderator
/mods - List all moderators

DISPUTE MANAGEMENT
/disputes - List ALL open disputes
/disputes mine - Your assigned disputes
/assign TL-XXXX @mod - Assign to moderator
/unassign TL-XXXX - Remove assignment
/viewevidence TL-XXXX - View all evidence
/resolve TL-XXXX release|refund - Resolve

COMMUNICATION
/msg TL-XXXX seller|buyer [message] - DM a party
/broadcast TL-XXXX [message] - Message both parties

AUDIT
/logs - Recent admin actions
/logs TL-XXXX - Actions for specific deal
  `);
});

// /modhelp - Moderator help
bot.command('modhelp', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  await ctx.reply(`
🛡️ MODERATOR COMMANDS

/mydisputes - Your assigned disputes
/viewevidence TL-XXXX - View evidence
/msg TL-XXXX seller|buyer [message] - Message a party
/resolve TL-XXXX release|refund - Resolve assigned dispute
${role === 'botmaster' ? '\n👑 Full admin: /adminhelp' : ''}
  `);
});

// /addmod - Botmaster only
bot.command('addmod', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/addmod\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /addmod @username');

  const modUsername = match[1];

  // Get their telegram ID from users table
  const { data: user } = await supabase.from('users').select('telegram_id').ilike('username', modUsername).single();
  if (!user) return ctx.reply(`@${modUsername} not found. They must /wallet first.`);

  const { error } = await supabase.from('moderators').upsert({
    telegram_id: user.telegram_id,
    username: modUsername,
    added_by: ctx.from.username,
    is_active: true
  }, { onConflict: 'telegram_id' });

  if (error) return ctx.reply('Failed to add moderator.');

  await logAdminAction('add_moderator', null, ctx.from.id, ctx.from.username, modUsername, 'Added as moderator');
  await ctx.reply(`✅ @${modUsername} is now a moderator.`);

  // Notify the new mod
  try {
    await bot.api.sendMessage(user.telegram_id, `🛡️ You are now a TrustLock Moderator!\n\nUse /modhelp to see your commands.`);
  } catch (e) {}
});

// /removemod - Botmaster only
bot.command('removemod', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/removemod\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /removemod @username');

  const modUsername = match[1];

  const { error } = await supabase.from('moderators').update({ is_active: false }).ilike('username', modUsername);
  if (error) return ctx.reply('Failed to remove moderator.');

  await logAdminAction('remove_moderator', null, ctx.from.id, ctx.from.username, modUsername, 'Removed from moderators');
  await ctx.reply(`✅ @${modUsername} is no longer a moderator.`);
});

// /mods - List moderators
bot.command('mods', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const { data: mods } = await supabase.from('moderators').select('*').eq('is_active', true);

  if (!mods?.length) return ctx.reply('No moderators. Add with /addmod @username');

  let msg = '🛡️ Active Moderators:\n\n';
  for (const m of mods) {
    msg += `@${m.username} (added by @${m.added_by})\n`;
  }
  await ctx.reply(msg);
});

// /disputes - List disputes
bot.command('disputes', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const showMine = ctx.message.text.toLowerCase().includes('mine');

  let query = supabase.from('deals').select('*').eq('status', 'disputed').order('disputed_at', { ascending: false });

  // Moderators can only see their assigned disputes
  if (role === 'moderator' || showMine) {
    query = query.eq('assigned_to_telegram_id', ctx.from.id);
  }

  const { data: disputes } = await query;

  if (!disputes?.length) {
    return ctx.reply(showMine ? 'No disputes assigned to you.' : 'No open disputes.');
  }

  let msg = `⚠️ ${showMine ? 'Your' : 'Open'} Disputes (${disputes.length}):\n\n`;

  for (const d of disputes) {
    const assigned = d.assigned_to_username ? `→ @${d.assigned_to_username}` : '⚡ Unassigned';
    msg += `${d.deal_id} | ${d.amount} USDC | ${assigned}\n`;
    msg += `  @${d.seller_username} vs @${d.buyer_username}\n\n`;
  }

  msg += role === 'botmaster' ? '\n/assign TL-XXXX @mod\n/resolve TL-XXXX release|refund' : '\n/resolve TL-XXXX release|refund';
  await ctx.reply(msg);
});

// /mydisputes - Moderator's assigned disputes
bot.command('mydisputes', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const { data: disputes } = await supabase
    .from('deals')
    .select('*')
    .eq('status', 'disputed')
    .eq('assigned_to_telegram_id', ctx.from.id)
    .order('disputed_at', { ascending: false });

  if (!disputes?.length) return ctx.reply('No disputes assigned to you.');

  let msg = `🛡️ Your Disputes (${disputes.length}):\n\n`;
  for (const d of disputes) {
    msg += `${d.deal_id} | ${d.amount} USDC\n`;
    msg += `  @${d.seller_username} vs @${d.buyer_username}\n`;
    msg += `  Reason: ${d.dispute_reason || 'N/A'}\n\n`;
  }
  await ctx.reply(msg + '\n/viewevidence TL-XXXX\n/resolve TL-XXXX release|refund');
});

// /assign - Botmaster assigns dispute to moderator
bot.command('assign', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/assign\s+(TL-\w+)\s+@(\w+)$/i);
  if (!match) return ctx.reply('Usage: /assign TL-XXXX @moderator');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Deal is not disputed. Status: ${deal.status}`);

  const modUsername = match[2];

  // Check if they're a moderator or botmaster
  const { data: mod } = await supabase.from('moderators').select('*').ilike('username', modUsername).eq('is_active', true).single();
  const isMod = !!mod || isBotmaster(modUsername);

  if (!isMod) return ctx.reply(`@${modUsername} is not a moderator. Add with /addmod @${modUsername}`);

  // Get mod's telegram ID
  const { data: modUser } = await supabase.from('users').select('telegram_id').ilike('username', modUsername).single();
  if (!modUser) return ctx.reply(`@${modUsername} not found in users.`);

  // Assign
  const { error } = await supabase.from('deals').update({
    assigned_to_telegram_id: modUser.telegram_id,
    assigned_to_username: modUsername,
    assigned_at: new Date().toISOString(),
    assigned_by: ctx.from.username
  }).ilike('deal_id', deal.deal_id);

  if (error) return ctx.reply('Failed to assign.');

  await logAdminAction('assign_dispute', deal.deal_id, ctx.from.id, ctx.from.username, modUsername, 'Assigned to moderator');
  await ctx.reply(`✅ ${deal.deal_id} assigned to @${modUsername}`);

  // Notify moderator
  try {
    await bot.api.sendMessage(modUser.telegram_id, `
🛡️ Dispute Assigned to You

Deal: ${deal.deal_id}
Amount: ${deal.amount} USDC
Seller: @${deal.seller_username}
Buyer: @${deal.buyer_username}
Reason: ${deal.dispute_reason || 'N/A'}

/viewevidence ${deal.deal_id}
/msg ${deal.deal_id} seller|buyer [message]
/resolve ${deal.deal_id} release|refund
    `);
  } catch (e) {}

  // Notify parties (without revealing moderator identity)
  await notifyParties(deal, `📋 ${deal.deal_id}\n\nYour dispute is now being reviewed by the Admin Team.\n\nYou'll be notified of updates.`);
});

// /unassign - Botmaster removes assignment
bot.command('unassign', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/unassign\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /unassign TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const { error } = await supabase.from('deals').update({
    assigned_to_telegram_id: null,
    assigned_to_username: null,
    assigned_at: null,
    assigned_by: null
  }).ilike('deal_id', deal.deal_id);

  if (error) return ctx.reply('Failed to unassign.');

  await logAdminAction('unassign_dispute', deal.deal_id, ctx.from.id, ctx.from.username, deal.assigned_to_username, 'Removed assignment');
  await ctx.reply(`✅ ${deal.deal_id} unassigned.`);
});

// /msg - Message a party
bot.command('msg', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/msg\s+(TL-\w+)\s+(seller|buyer)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /msg TL-XXXX seller|buyer Your message here');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  // Moderators can only message their assigned disputes
  if (role === 'moderator' && deal.assigned_to_telegram_id !== ctx.from.id) {
    return ctx.reply('You can only message parties in disputes assigned to you.');
  }

  const target = match[2].toLowerCase();
  const message = match[3];

  let targetId;
  if (target === 'seller') {
    targetId = deal.seller_telegram_id;
  } else {
    const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
    targetId = buyerUser?.telegram_id;
  }

  if (!targetId) return ctx.reply(`Cannot find ${target}'s Telegram.`);

  try {
    await bot.api.sendMessage(targetId, `
📨 Message from Admin Team

Re: ${deal.deal_id}

${message}

Reply with /evidence ${deal.deal_id} [your response]
    `);
    await logAdminAction('message_party', deal.deal_id, ctx.from.id, ctx.from.username, target, message);
    await ctx.reply(`✅ Message sent to ${target}.`);
  } catch (e) {
    await ctx.reply(`Failed to send message: ${e.message}`);
  }
});

// /broadcast - Message both parties
bot.command('broadcast', async (ctx) => {
  const { isAdmin } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/broadcast\s+(TL-\w+)\s+(.+)$/i);
  if (!match) return ctx.reply('Usage: /broadcast TL-XXXX Your message');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const message = match[2];

  await notifyParties(deal, `
📢 Admin Announcement

Re: ${deal.deal_id}

${message}
  `);

  await logAdminAction('broadcast', deal.deal_id, ctx.from.id, ctx.from.username, 'both', message);
  await ctx.reply('✅ Message sent to both parties.');
});

// /resolve - Resolve dispute (role-based)
bot.command('resolve', async (ctx) => {
  const { isAdmin, role } = await isAnyAdmin(ctx);
  if (!isAdmin) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/resolve\s+(TL-\w+)\s+(release|refund)$/i);
  if (!match) return ctx.reply('Usage: /resolve TL-XXXX release|refund');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Not disputed. Status: ${deal.status}`);

  // Moderators can only resolve their assigned disputes
  if (role === 'moderator' && deal.assigned_to_telegram_id !== ctx.from.id) {
    return ctx.reply('You can only resolve disputes assigned to you.');
  }

  const decision = match[2].toLowerCase();
  await ctx.reply('Resolving on-chain...');

  try {
    const chainDealId = await escrowContract.externalIdToDealId(deal.deal_id);
    if (chainDealId.toString() !== '0') {
      const tx = decision === 'release' ? await escrowContract.resolveRelease(chainDealId) : await escrowContract.refund(chainDealId);
      await ctx.reply(`Tx: https://sepolia.basescan.org/tx/${tx.hash}`);
      await tx.wait();
    }
  } catch (e) {
    await ctx.reply(`On-chain failed: ${e.shortMessage || e.message}`);
  }

  const newStatus = decision === 'release' ? 'completed' : 'refunded';
  await supabase.from('deals').update({
    status: newStatus,
    resolved_by: ctx.from.username,
    completed_at: new Date().toISOString()
  }).ilike('deal_id', deal.deal_id);

  await logAdminAction('resolve_dispute', deal.deal_id, ctx.from.id, ctx.from.username, null, `Resolved: ${decision}`);
  await ctx.reply(`⚖️ Resolved: ${decision === 'release' ? 'Funds → Seller' : 'Refund → Buyer'}`);

  // Notify parties
  const sellerMsg = decision === 'release' ? '✅ Funds released to you!' : '❌ Funds refunded to buyer.';
  const buyerMsg = decision === 'refund' ? '✅ Funds refunded to you!' : '❌ Funds released to seller.';

  try {
    await bot.api.sendMessage(deal.seller_telegram_id, `⚖️ ${deal.deal_id} Resolved\n\n${sellerMsg}`);
  } catch (e) {}

  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  if (buyerUser?.telegram_id) {
    try {
      await bot.api.sendMessage(buyerUser.telegram_id, `⚖️ ${deal.deal_id} Resolved\n\n${buyerMsg}`);
    } catch (e) {}
  }
});

// /logs - View admin logs
bot.command('logs', async (ctx) => {
  if (!isBotmaster(ctx.from.username)) return ctx.reply('Botmaster only.');

  const match = ctx.message.text.match(/^\/logs(?:\s+(TL-\w+))?$/i);
  const dealId = match?.[1];

  let query = supabase.from('admin_logs').select('*').order('created_at', { ascending: false }).limit(20);

  if (dealId) {
    query = query.ilike('deal_id', dealId);
  }

  const { data: logs } = await query;

  if (!logs?.length) return ctx.reply('No logs found.');

  let msg = `📋 Admin Logs${dealId ? ` for ${dealId.toUpperCase()}` : ''}:\n\n`;
  for (const l of logs) {
    const date = new Date(l.created_at).toLocaleDateString();
    msg += `${date} | @${l.admin_username}\n`;
    msg += `  ${l.action}${l.deal_id ? ` on ${l.deal_id}` : ''}\n`;
    if (l.target_user) msg += `  Target: ${l.target_user}\n`;
    msg += '\n';
  }
  await ctx.reply(msg);
});

// ============ OTHER ============

bot.on('message:text', async (ctx) => {
  if (!ctx.message.text.startsWith('/')) await ctx.reply('Use /help');
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

          if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `💰 ${deal.deal_id} FUNDED!\n\n${deal.amount} USDC locked.\nDeliver now → buyer releases.`); } catch (e) {}

          const { data: buyer } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
          if (buyer?.telegram_id) try { await bot.api.sendMessage(buyer.telegram_id, `✅ ${deal.deal_id} deposit confirmed!\n\nRelease when ready: /release ${deal.deal_id}`); } catch (e) {}
        }
      } catch (e) {}
    }
  } catch (e) {
    console.error('Poll error:', e.message);
  }
}

// Start
bot.start();
console.log('TrustLock v3.0 running!');
console.log('Contract:', CONTRACT_ADDRESS);
console.log('Botmasters:', BOTMASTER_USERNAMES.join(', '));
setInterval(pollDeals, 30000);
pollDeals();
