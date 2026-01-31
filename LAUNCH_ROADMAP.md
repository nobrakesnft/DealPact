## Full Launch Checklist (Your Phases)

Since you're finishing unit tests, you're entering **Phase 3: Code Complete**. Here's where you are and what's left:

### Phase 3: Code Complete (YOU ARE HERE)

**Security Audit (P0 - Do First)**
- [x] Run `npm audit` — 0 vulnerabilities (bot), 1 medium dev-only (contracts)
- [x] Scan git history for leaked keys — git filter-repo done, history clean
- [x] Validate/sanitize ALL bot command inputs (regex on all commands, username partial)
- [x] Rate limit bot commands (3s per-user cooldown with cleanup)
- [x] Private key management — keys in env vars, validated on startup
- [x] Remove all `console.log` that print sensitive data — removed BOTMASTER_IDS log
- [x] Check smart contract for reentrancy, overflow, and access control — all PASS
- [x] Added existence check in release() — require(deal.buyer != address(0))
- [x] Added 60s timeout on all tx.wait() calls — bot no longer hangs on RPC stall
- [ ] Deal timeout/expiry in contract — deferred, requires redeploy
- [ ] Reputation bug on resolveRelease() — deferred, requires redeploy

**Integration Testing (P0)**
- [x] Test full escrow flow end-to-end on **testnet** (create → fund → release) — PASS
- [x] Test dispute flow (create → fund → dispute → admin resolve) — PASS
- [x] Test edge cases: wrong user release/dispute, cancel funded deal, double fund, release completed — ALL PASS
- [x] Patched: /cancel now restricted to pending_deposit only, seller only
- [x] Patched: /viewevidence restricted to assigned moderators
- [x] Patched: website release locked behind bot gatekeeper (?action=release)
- [ ] Test with a real second person in a private Telegram group
- [ ] Run 5-10 complete cycles — log every failure

**Error Handling (P1)**
- [x] What happens when RPC provider is down? — tx.wait() now times out after 60s, catch blocks reply to user
- [ ] What happens when Supabase is unreachable? (graceful failure)
- [x] What happens when user sends invalid command format? — regex validation + help text on all commands
- [ ] What happens when gas estimation fails? (inform user)
- [ ] What happens on insufficient funds? (clear error)

**Legal (P1)**
- [ ] Terms of Service (even basic — you're handling money)
- [ ] Privacy Policy (you store Telegram IDs, wallet addresses)
- [ ] Disclaimer about crypto risks

### Phase 4: Mainnet & Soft Launch

**Deploy (P0)**
- [ ] Deploy smart contract to mainnet
- [ ] Update `.env` with mainnet RPC, contract address
- [ ] Do ONE small real transaction yourself ($5-10)
- [ ] Verify transaction on block explorer
- [ ] Deploy bot to a VPS or cloud (Railway, Render, or a cheap VPS)
- [ ] Set up `pm2` or similar to keep the bot alive

**Monitoring (P0)**
- [ ] Basic error logging (write errors to Supabase or a log file)
- [ ] Send yourself a Telegram alert when a deal is created/completed/disputed
- [ ] Monitor wallet balance (gas fund for bot operations)

**Soft Launch (P1)**
- [ ] Invite 5-10 trusted people from crypto Telegram groups
- [ ] Watch logs live during first 10 real deals
- [ ] Collect feedback — what confused them? What broke?
- [ ] Fix critical bugs immediately

### Phase 5: Public Launch

- [ ] Post in crypto Telegram groups (OTC, trading communities)
- [ ] Post on Crypto Twitter with a demo video/GIF
- [ ] Consider a Show HN post if the tech angle is interesting
- [ ] Set up a simple landing page (even a Telegram channel describing the bot)
- [ ] Track: deals created, deals completed, deal volume, disputes

---

## Deep Dive: Key Steps

### 1. Security Review (Critical for a money-handling bot)

**Smart Contract Side:**
- Use `ReentrancyGuard` from OpenZeppelin if not already
- Ensure only the escrow parties + admin can call release/refund
- Test what happens if someone sends ETH directly to the contract (not through the bot)
- Consider getting a basic audit from a peer (even another dev reviewing it)

**Bot Side:**
- Never interpolate user input into database queries — use parameterized queries
- Validate Telegram user IDs match deal participants before allowing actions
- Rate limit: max X commands per user per minute
- Timeout deals that aren't funded within N hours (prevent stuck state)

**Infra Side:**
- Bot token in `.env`, never in code
- Private key for the bot's wallet: consider using a separate hot wallet with only gas funds
- If you use a webhook, validate that requests actually come from Telegram (check the secret token)

### 2. Testnet Strategy

```
Step 1: Solo testing
  - Create deals between two wallets you control
  - Test every command: /create, /fund, /release, /dispute, /cancel
  - Test with wrong amounts, expired deals, unauthorized users

Step 2: Partner testing
  - Get one friend to test with you in a private group
  - Don't tell them the commands — see if the UX is clear
  - Log every question they ask (that's a UX gap)

Step 3: Stress test
  - Create 10 deals in rapid succession
  - Fund 5, let 5 expire
  - Release 3, dispute 2
  - Verify database state matches contract state
```

### 3. Going Live Checklist (Mainnet)

1. Deploy contract to mainnet (double-check constructor args)
2. Verify contract source on Etherscan/block explorer
3. Update all config to point to mainnet
4. Fund bot wallet with gas (start small, ~$20)
5. Do a real $5 test deal end-to-end
6. Deploy bot to always-on hosting (Railway/Render/VPS + pm2)
7. Set up the self-alert system (bot messages you on every event)
