# DealPact

> Telegram-native escrow for crypto freelancers and digital goods sellers.

## What is this?

A Telegram bot that lets you get paid in crypto without getting scammed. Funds are locked in a smart contract until both parties are happy.

## Project Structure

```
TrustLock/
├── docs/
│   └── PRD.md          # Product requirements (your blueprint)
├── bot/
│   └── (Telegram bot code)
└── contracts/
    └── (Solidity smart contracts)
```

## Tech Stack

- **Bot**: Node.js + grammY
- **Blockchain**: Base (Solidity)
- **Database**: Supabase
- **Hosting**: Railway

## Status

🚧 Under development

## Commands (Planned)

- `/start` - Welcome message
- `/new @user amount "description"` - Create escrow
- `/status deal_id` - Check deal status
- `/release deal_id` - Release funds to seller
- `/dispute deal_id` - Flag a problem
- `/rep @user` - Check reputation

---

Built with Claude Code
