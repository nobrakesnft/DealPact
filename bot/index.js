// TrustLock Bot v2.1 - With Ratings
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
const ADMIN_USERNAMES = (process.env.ADMIN_USERNAMES || 'nobrakesnft').toLowerCase().split(',').map(s => s.trim());

// Helpers
function generateDealId() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
  return `TL-${code}`;
}

// Get deal helper with case-insensitive matching
async function getDeal(dealId) {
  const normalized = dealId.toUpperCase().trim();
  const { data, error } = await supabase
    .from('deals')
    .select('*')
    .ilike('deal_id', normalized)
    .single();
  return { deal: data, error };
}

// /start - Handle deep link parameters
bot.command('start', async (ctx) => {
  const param = ctx.message.text.split(' ')[1]?.toLowerCase();

  // Handle newdeal deep link from website
  if (param === 'newdeal') {
    await ctx.reply(`
💰 CREATE A NEW DEAL

Step 1️⃣ - Register your wallet (one time):
/wallet 0xYourWalletAddress

Step 2️⃣ - Create the deal:
/new @buyerUsername amount description

Example:
/new @john 50 Logo design work

📋 Quick Guide:
• amount = USDC (1-500)
• @buyer = their Telegram username
• description = what you're selling

Need help? /help
    `);
    return;
  }

  // Handle dispute deep link
  if (param?.startsWith('dispute_')) {
    const dealId = param.replace('dispute_', '').toUpperCase();
    await ctx.reply(`
⚠️ Open Dispute for ${dealId}

Command: /dispute ${dealId} [reason]

Example:
/dispute ${dealId} Seller not responding

This will flag the deal for admin review.
    `);
    return;
  }

  // Default welcome message
  await ctx.reply(`
🔒 TrustLock - Secure Crypto Escrow

How it works:
1. Seller: /new @buyer 50 Logo design
2. Buyer: /fund TL-XXXX → deposits USDC
3. Seller delivers goods/service
4. Buyer: /release TL-XXXX → pays seller
5. Both: /review TL-XXXX 5 Great!

Commands: /help
Network: Base Sepolia

🆕 Create deal now → /new
  `);
});

// /help
bot.command('help', async (ctx) => {
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
/rep @user - Check reputation

Web: nobrakesnft.github.io/TrustLock
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

  await ctx.reply(`
${emoji} ${deal.deal_id} - ${deal.status.replace('_', ' ')}

Seller: @${deal.seller_username}
Buyer: @${deal.buyer_username}
Amount: ${deal.amount} USDC
Desc: ${deal.description}
${deal.status === 'disputed' ? `\nDispute by: @${deal.disputed_by}\nReason: ${deal.dispute_reason}` : ''}
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

  // Check if on-chain
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

// /dispute
bot.command('dispute', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/dispute\s+(TL-\w+)(?:\s+(.+))?$/i);
  if (!match) return ctx.reply('Usage: /dispute TL-XXXX reason');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');
  if (deal.status !== 'funded') return ctx.reply(`Cannot dispute. Current status: ${deal.status}\n\nOnly funded deals can be disputed.`);

  const reason = match[2] || 'No reason provided';

  // Update status - use ilike for case-insensitive match
  const { error } = await supabase.from('deals').update({
    status: 'disputed',
    disputed_by: username,
    dispute_reason: reason,
    disputed_at: new Date().toISOString()
  }).ilike('deal_id', deal.deal_id);

  if (error) {
    console.error('Dispute update error:', error);
    return ctx.reply('Failed to open dispute. Try again.');
  }

  // Verify update worked
  const { deal: verifyDeal } = await getDeal(deal.deal_id);
  if (verifyDeal?.status !== 'disputed') {
    console.error('Dispute update verification failed:', verifyDeal?.status);
    return ctx.reply('Dispute may not have saved. Try again or contact admin.');
  }

  await ctx.reply(`
⚠️ DISPUTE OPENED

Deal: ${deal.deal_id}
By: @${username}
Reason: ${reason}

NEXT STEPS:
• /evidence ${deal.deal_id} [your proof]
• /viewevidence ${deal.deal_id}
• /canceldispute ${deal.deal_id} (to cancel)

Admin will review and resolve.
  `);

  // Notify other party
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  const otherPartyId = isSeller ? buyerUser?.telegram_id : deal.seller_telegram_id;

  if (otherPartyId) {
    try {
      await bot.api.sendMessage(otherPartyId, `⚠️ DISPUTE on ${deal.deal_id}\n\nBy: @${username}\nReason: ${reason}\n\nSubmit evidence: /evidence ${deal.deal_id} [msg]`);
    } catch (e) {}
  }

  // Notify admins
  for (const admin of ADMIN_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
    if (adminUser?.telegram_id) {
      try {
        await bot.api.sendMessage(adminUser.telegram_id, `🔔 DISPUTE: ${deal.deal_id}\n${deal.amount} USDC\n@${deal.seller_username} vs @${deal.buyer_username}\nReason: ${reason}\n\n/resolve ${deal.deal_id} release|refund`);
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

  if (!deal) return ctx.reply('Deal not found. Check the deal ID.');

  if (deal.status !== 'disputed') {
    return ctx.reply(`Cannot submit evidence.\n\nDeal status: ${deal.status}\nOnly disputed deals accept evidence.`);
  }

  const evidence = match[2];
  if (!evidence) return ctx.reply(`Usage: /evidence ${deal.deal_id} your message here`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const isAdmin = ADMIN_USERNAMES.includes(username?.toLowerCase());

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
    return ctx.reply(`Failed to save evidence: ${insertError.message}\n\nTry again or contact admin.`);
  }

  await ctx.reply(`✅ Evidence submitted for ${deal.deal_id}\n\nView all: /viewevidence ${deal.deal_id}`);

  // Forward to others
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  const parties = [deal.seller_telegram_id, buyerUser?.telegram_id].filter(id => id && id !== userId);

  for (const partyId of parties) {
    try {
      await bot.api.sendMessage(partyId, `📋 Evidence for ${deal.deal_id}\n\nFrom: @${username} (${role})\n"${evidence}"`);
    } catch (e) {}
  }

  // Notify admins
  for (const admin of ADMIN_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
    if (adminUser?.telegram_id && adminUser.telegram_id !== userId) {
      try {
        await bot.api.sendMessage(adminUser.telegram_id, `📋 Evidence: ${deal.deal_id}\nFrom: @${username} (${role})\n"${evidence}"`);
      } catch (e) {}
    }
  }
});

// Photo evidence handler - send photo with caption: TL-XXXX description
bot.on('message:photo', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const caption = ctx.message.caption || '';

  // Check if caption contains a deal ID
  const match = caption.match(/^(TL-\w+)(?:\s+(.*))?$/i);
  if (!match) {
    return ctx.reply(`📸 To submit photo evidence:\n\n1. Send a photo\n2. Add caption: TL-XXXX your description\n\nExample caption: TL-A7X9 Screenshot of payment confirmation`);
  }

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found. Check the deal ID in your caption.');
  if (deal.status !== 'disputed') {
    return ctx.reply(`Cannot submit evidence.\n\nDeal status: ${deal.status}\nOnly disputed deals accept evidence.`);
  }

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  const isAdmin = ADMIN_USERNAMES.includes(username?.toLowerCase());
  if (!isSeller && !isBuyer && !isAdmin) return ctx.reply('Not your deal.');

  const role = isSeller ? 'Seller' : (isBuyer ? 'Buyer' : 'Admin');
  const description = match[2]?.trim() || 'Photo evidence';
  const photo = ctx.message.photo[ctx.message.photo.length - 1]; // Highest resolution

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
    console.error('Photo evidence insert error:', insertError);
    return ctx.reply(`Failed to save photo evidence: ${insertError.message}`);
  }

  await ctx.reply(`✅ Photo evidence submitted for ${deal.deal_id}\n\nView all: /viewevidence ${deal.deal_id}`);

  // Forward photo to other parties
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  const parties = [deal.seller_telegram_id, buyerUser?.telegram_id].filter(id => id && id !== userId);

  for (const partyId of parties) {
    try {
      await bot.api.sendPhoto(partyId, photo.file_id, { caption: `📸 Evidence for ${deal.deal_id}\n\nFrom: @${username} (${role})\n"${description}"` });
    } catch (e) {}
  }

  // Notify admins with photo
  for (const admin of ADMIN_USERNAMES) {
    const { data: adminUser } = await supabase.from('users').select('telegram_id').ilike('username', admin).single();
    if (adminUser?.telegram_id && adminUser.telegram_id !== userId) {
      try {
        await bot.api.sendPhoto(adminUser.telegram_id, photo.file_id, { caption: `📸 Evidence: ${deal.deal_id}\nFrom: @${username} (${role})\n"${description}"` });
      } catch (e) {}
    }
  }
});

// /viewevidence
bot.command('viewevidence', async (ctx) => {
  const match = ctx.message.text.match(/^\/viewevidence\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /viewevidence TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');

  const { data: evidence } = await supabase.from('evidence').select('*').eq('deal_id', deal.deal_id).order('created_at', { ascending: true });

  if (!evidence?.length) {
    return ctx.reply(`📋 Evidence: ${deal.deal_id}\nStatus: ${deal.status}\nReason: ${deal.dispute_reason || 'N/A'}\n\nNo evidence yet.\n\n📝 Text: /evidence ${deal.deal_id} [msg]\n📸 Photo: Send photo with caption "${deal.deal_id} description"`);
  }

  // Send text summary first
  let msg = `📋 Evidence: ${deal.deal_id}\nStatus: ${deal.status}\nReason: ${deal.dispute_reason || 'N/A'}\n\n`;

  let photoCount = 0;
  for (const e of evidence) {
    if (e.file_type === 'photo') {
      photoCount++;
      msg += `📸 [${e.role}] @${e.submitted_by}: "${e.content}"\n\n`;
    } else {
      msg += `📝 [${e.role}] @${e.submitted_by}\n"${e.content}"\n\n`;
    }
  }

  await ctx.reply(msg);

  // Send photos separately
  for (const e of evidence) {
    if (e.file_id && e.file_type === 'photo') {
      try {
        await bot.api.sendPhoto(ctx.chat.id, e.file_id, { caption: `[${e.role}] @${e.submitted_by}: ${e.content}` });
      } catch (err) {
        console.error('Failed to send evidence photo:', err.message);
      }
    }
  }
});

// /canceldispute
bot.command('canceldispute', async (ctx) => {
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/canceldispute\s+(TL-\w+)$/i);
  if (!match) return ctx.reply('Usage: /canceldispute TL-XXXX');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Deal is not disputed. Status: ${deal.status}`);
  if (deal.disputed_by?.toLowerCase() !== username?.toLowerCase()) return ctx.reply(`Only @${deal.disputed_by} can cancel.`);

  const { error } = await supabase.from('deals').update({ status: 'funded' }).ilike('deal_id', deal.deal_id);
  if (error) {
    console.error('Cancel dispute error:', error);
    return ctx.reply('Failed to cancel dispute. Try again.');
  }
  await ctx.reply(`✅ Dispute cancelled. ${deal.deal_id} back to funded.`);
});

// /resolve - Admin
bot.command('resolve', async (ctx) => {
  const username = ctx.from.username;
  if (!ADMIN_USERNAMES.includes(username?.toLowerCase())) return ctx.reply('Admin only.');

  const match = ctx.message.text.match(/^\/resolve\s+(TL-\w+)\s+(release|refund)$/i);
  if (!match) return ctx.reply('Usage: /resolve TL-XXXX release|refund');

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'disputed') return ctx.reply(`Not disputed. Status: ${deal.status}`);

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
  await supabase.from('deals').update({ status: newStatus, resolved_by: username, completed_at: new Date().toISOString() }).ilike('deal_id', deal.deal_id);

  await ctx.reply(`⚖️ Resolved: ${decision === 'release' ? 'Funds → Seller' : 'Refund → Buyer'}`);

  // Notify
  const { data: buyerUser } = await supabase.from('users').select('telegram_id').ilike('username', deal.buyer_username).single();
  if (deal.seller_telegram_id) try { await bot.api.sendMessage(deal.seller_telegram_id, `⚖️ ${deal.deal_id}: ${decision === 'release' ? '✅ Funds to you!' : '❌ Refunded'}`); } catch (e) {}
  if (buyerUser?.telegram_id) try { await bot.api.sendMessage(buyerUser.telegram_id, `⚖️ ${deal.deal_id}: ${decision === 'refund' ? '✅ Refunded!' : '❌ Released to seller'}`); } catch (e) {}
});

// /review - Leave rating
bot.command('review', async (ctx) => {
  const userId = ctx.from.id;
  const username = ctx.from.username;
  const match = ctx.message.text.match(/^\/review\s+(TL-\w+)\s+([1-5])(?:\s+(.+))?$/i);

  if (!match) {
    return ctx.reply(`
📝 Leave a Review

Usage: /review TL-XXXX [1-5] [comment]

Example:
/review TL-ABCD 5 Great seller!
/review TL-ABCD 4 Good but slow

⭐⭐⭐⭐⭐ (5) Excellent
⭐⭐⭐⭐ (4) Good
⭐⭐⭐ (3) Average
⭐⭐ (2) Poor
⭐ (1) Bad
    `);
  }

  const { deal } = await getDeal(match[1]);
  if (!deal) return ctx.reply('Deal not found.');
  if (deal.status !== 'completed') return ctx.reply(`Can only review completed deals. Status: ${deal.status}`);

  const isSeller = deal.seller_telegram_id === userId;
  const isBuyer = deal.buyer_username.toLowerCase() === username?.toLowerCase();
  if (!isSeller && !isBuyer) return ctx.reply('Not your deal.');

  const rating = parseInt(match[2]);
  const comment = match[3]?.trim() || '';

  // Check if already reviewed
  const field = isSeller ? 'seller_review' : 'buyer_review';
  if (deal[field]) return ctx.reply('You already reviewed this deal.');

  // Save
  const update = {
    [field]: comment || 'No comment',
    [`${isSeller ? 'seller' : 'buyer'}_rating`]: rating
  };
  await supabase.from('deals').update(update).ilike('deal_id', deal.deal_id);

  const stars = '⭐'.repeat(rating);
  const reviewed = isSeller ? deal.buyer_username : deal.seller_username;

  await ctx.reply(`✅ Review submitted!\n\nFor: @${reviewed}\nRating: ${stars} (${rating}/5)\n${comment ? `Comment: "${comment}"` : ''}`);

  // Notify reviewed party
  const otherId = isSeller ? null : deal.seller_telegram_id;
  if (otherId) {
    try {
      await bot.api.sendMessage(otherId, `📝 New Review on ${deal.deal_id}\n\nFrom: @${username}\nRating: ${stars}\n${comment ? `"${comment}"` : ''}`);
    } catch (e) {}
  }
});

// /rep - Check reputation
bot.command('rep', async (ctx) => {
  const match = ctx.message.text.match(/^\/rep(?:\s+@(\w+))?$/i);
  const targetUsername = match?.[1] || ctx.from.username;

  const { data: user } = await supabase.from('users').select('*').ilike('username', targetUsername).single();
  if (!user) return ctx.reply(`@${targetUsername} not found. Register: /wallet`);

  // Get completed deals
  const { data: deals } = await supabase
    .from('deals')
    .select('*')
    .or(`seller_username.ilike.${targetUsername},buyer_username.ilike.${targetUsername}`)
    .eq('status', 'completed');

  const totalDeals = deals?.length || 0;
  const totalVolume = deals?.reduce((s, d) => s + parseFloat(d.amount), 0) || 0;

  // Ratings received
  const asSeller = deals?.filter(d => d.seller_username.toLowerCase() === targetUsername.toLowerCase()) || [];
  const asBuyer = deals?.filter(d => d.buyer_username.toLowerCase() === targetUsername.toLowerCase()) || [];

  const sellerRatings = asSeller.filter(d => d.buyer_rating).map(d => d.buyer_rating);
  const buyerRatings = asBuyer.filter(d => d.seller_rating).map(d => d.seller_rating);

  const avgSeller = sellerRatings.length ? (sellerRatings.reduce((a, b) => a + b, 0) / sellerRatings.length).toFixed(1) : null;
  const avgBuyer = buyerRatings.length ? (buyerRatings.reduce((a, b) => a + b, 0) / buyerRatings.length).toFixed(1) : null;

  // Badge
  let badge = '🆕 New';
  if (totalDeals >= 50 && totalVolume >= 5000) badge = '💎 Elite';
  else if (totalDeals >= 25 && totalVolume >= 1000) badge = '🏆 Top Trader';
  else if (totalDeals >= 10) badge = '⭐ Trusted';
  else if (totalDeals >= 3) badge = '✓ Verified';
  else if (totalDeals >= 1) badge = '👤 Active';

  const starShow = (avg) => avg ? `${'⭐'.repeat(Math.round(avg))} ${avg}/5` : 'No ratings';

  await ctx.reply(`
📊 @${targetUsername}

${badge}

Completed: ${totalDeals} deals
Volume: ${totalVolume.toFixed(0)} USDC

As Seller (${asSeller.length}): ${starShow(avgSeller)}
As Buyer (${asBuyer.length}): ${starShow(avgBuyer)}
  `);
});

// Unknown text
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
console.log('TrustLock v2.1 running!');
console.log('Contract:', CONTRACT_ADDRESS);
setInterval(pollDeals, 30000);
pollDeals();
