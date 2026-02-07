import { createWeb3Modal, defaultConfig } from '@web3modal/ethers'
import { BrowserProvider, Contract, formatUnits } from 'ethers'

// =============================================================================
// CONFIGURATION
// =============================================================================

// Get your project ID from https://cloud.walletconnect.com (free)
const PROJECT_ID = '7572c506a9fd3bc7d1b5c9cf3422d4a2' // <-- REPLACE THIS

const CONFIG = {
  CONTRACT: '0x116511753bf00671bc321f2e3364159Fe502ed22',
  USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  RPC: 'https://mainnet.base.org',
  CHAIN_ID: 8453,
  EXPLORER: 'https://basescan.org'
}

// Base Mainnet chain config
const baseMainnet = {
  chainId: 8453,
  name: 'Base',
  currency: 'ETH',
  explorerUrl: 'https://basescan.org',
  rpcUrl: 'https://mainnet.base.org'
}

// App metadata for wallet display
const metadata = {
  name: 'DealPact',
  description: 'Secure Escrow Payment on Base',
  url: 'https://nobrakesnft.github.io/DealPact',
  icons: ['https://nobrakesnft.github.io/DealPact/logo.png']
}

// ABIs
const ESCROW_ABI = [
  'function deposit(uint256 _dealId) external',
  'function getDealByExternalId(string) view returns (tuple(string,address,address,uint256,uint8,uint256,uint256))',
  'function externalIdToDealId(string) view returns (uint256)'
]
const RELEASE_ABI = [
  'function release(uint256 _dealId) external'
]
const ERC20_ABI = [
  'function approve(address,uint256) returns (bool)',
  'function allowance(address,address) view returns (uint256)',
  'function balanceOf(address) view returns (uint256)'
]

// =============================================================================
// WEB3MODAL SETUP
// =============================================================================

const ethersConfig = defaultConfig({
  metadata,
  enableEIP6963: true,      // Detect all installed wallets
  enableInjected: true,     // MetaMask, etc.
  enableCoinbase: true,     // Coinbase Wallet
  rpcUrl: CONFIG.RPC,
  defaultChainId: CONFIG.CHAIN_ID
})

const modal = createWeb3Modal({
  ethersConfig,
  chains: [baseMainnet],
  projectId: PROJECT_ID,
  enableAnalytics: false,
  themeMode: 'dark',
  themeVariables: {
    '--w3m-accent': '#00d9ff',
    '--w3m-border-radius-master': '12px'
  }
})

// =============================================================================
// STATE
// =============================================================================

let state = {
  deal: null,
  signer: null,
  address: null,
  action: 'deposit'
}

// =============================================================================
// HELPERS
// =============================================================================

const $ = id => document.getElementById(id)
const show = id => $(id)?.classList.remove('hidden')
const hide = id => $(id)?.classList.add('hidden')
const short = addr => addr ? `${addr.slice(0,6)}...${addr.slice(-4)}` : ''

function showAlert(id, msg, type) {
  const el = $(id)
  if (el) el.innerHTML = `<div class="alert alert-${type}">${msg}</div>`
}

function clearAlert(id) {
  const el = $(id)
  if (el) el.innerHTML = ''
}

function setLoading(btnId, loading) {
  const btn = $(btnId)
  if (!btn) return
  btn.disabled = loading
  loading ? btn.classList.add('btn-loading') : btn.classList.remove('btn-loading')
}

function setStep(num) {
  for (let i = 1; i <= 3; i++) {
    const step = $(`step-${i}`)
    if (!step) continue
    step.classList.remove('active', 'done')
    if (i < num) step.classList.add('done')
    if (i === num) step.classList.add('active')
  }
}

// =============================================================================
// READ-ONLY PROVIDER (for searching deals)
// =============================================================================

async function getReadOnlyProvider() {
  const { JsonRpcProvider } = await import('ethers')
  return new JsonRpcProvider(CONFIG.RPC)
}

// =============================================================================
// SEARCH DEAL
// =============================================================================

async function searchDeal() {
  const input = $('deal-input').value.trim().toUpperCase()

  if (!input.match(/^DP-[A-Z0-9]{4}$/)) {
    showAlert('search-alert', 'Enter a valid deal ID (DP-XXXX)', 'error')
    return
  }

  setLoading('search-btn', true)
  clearAlert('search-alert')

  try {
    const provider = await getReadOnlyProvider()
    const contract = new Contract(CONFIG.CONTRACT, ESCROW_ABI, provider)

    const chainId = await contract.externalIdToDealId(input)

    if (chainId.toString() === '0') {
      showAlert('search-alert', 'Deal not on blockchain yet. Ask seller to run /fund first.', 'warning')
      setLoading('search-btn', false)
      return
    }

    const deal = await contract.getDealByExternalId(input)
    const status = Number(deal[4])
    const statuses = ['Pending', 'Funded', 'Completed', 'Refunded', 'Disputed', 'Cancelled']

    // Check if this is a release action
    const params = new URLSearchParams(window.location.search)
    const actionParam = params.get('action')
    state.action = actionParam === 'release' ? 'release' : 'deposit'

    // Check if this is a bot-initiated release
    if (state.action === 'release') {
      if (status !== 1) {
        showAlert('search-alert', `Cannot release. Deal status is "${statuses[status]}".`, 'warning')
        setLoading('search-btn', false)
        return
      }
    }

    // Save deal info
    state.deal = {
      id: input,
      chainId: chainId.toString(),
      seller: deal[1],
      buyer: deal[2],
      amount: deal[3],
      status: status
    }

    // Update UI
    $('disp-deal-id').textContent = input
    $('disp-amount').textContent = formatUnits(deal[3], 6)
    $('disp-seller').textContent = short(deal[1])
    $('disp-buyer').textContent = short(deal[2])

    // Update status badge
    const statusBadge = document.querySelector('.deal-status')
    const statusStyles = {
      0: { text: 'Awaiting Payment', bg: 'rgba(255,193,7,0.2)', color: '#ffc107' },
      1: { text: 'Funded', bg: 'rgba(0,217,255,0.2)', color: '#00d9ff' },
      2: { text: 'Completed', bg: 'rgba(0,255,136,0.2)', color: '#00ff88' },
      3: { text: 'Refunded', bg: 'rgba(255,71,87,0.2)', color: '#ff4757' },
      4: { text: 'Disputed', bg: 'rgba(255,193,7,0.2)', color: '#ffc107' },
      5: { text: 'Cancelled', bg: 'rgba(255,71,87,0.2)', color: '#ff4757' }
    }
    const style = statusStyles[status] || statusStyles[0]
    statusBadge.textContent = style.text
    statusBadge.style.background = style.bg
    statusBadge.style.color = style.color

    // Show deal section
    hide('search-section')
    show('deal-section')

    // Handle what the user can do based on status
    if (state.action === 'release' && status === 1) {
      $('step-2').querySelector('.step-text').textContent = 'Confirm'
      $('step-3').querySelector('.step-text').textContent = 'Release'
      setStep(1)
    } else if (status === 0) {
      setStep(1)
    } else {
      hide('connect-section')
      const statusMessages = {
        1: 'Funds locked. After delivery, use <strong>/release ' + input + '</strong> in the bot to get your release link.',
        2: 'This deal is complete. Funds have been released to the seller.',
        3: 'This deal has been refunded to the buyer.',
        4: 'This deal is under dispute. Awaiting admin resolution.',
        5: 'This deal has been cancelled.'
      }
      showAlert('action-alert', statusMessages[status], status === 2 ? 'success' : 'info')
    }

  } catch (e) {
    console.error('Search error:', e)
    showAlert('search-alert', 'Error: ' + (e.reason || e.message || 'Connection failed. Check your internet.'), 'error')
  }

  setLoading('search-btn', false)
}

// =============================================================================
// CONNECT WALLET (via Web3Modal)
// =============================================================================

async function openConnectModal() {
  modal.open()
}

// Handle wallet connection state changes
modal.subscribeProvider(async ({ provider, address, chainId }) => {
  console.log('Provider state changed:', { address, chainId })

  if (provider && address) {
    // Wallet connected
    try {
      // Check if we're on the right chain
      if (chainId !== CONFIG.CHAIN_ID) {
        showAlert('action-alert', 'Switching to Base...', 'info')
        try {
          await modal.switchNetwork(CONFIG.CHAIN_ID)
        } catch (switchErr) {
          showAlert('action-alert', 'Please switch to Base network in your wallet.', 'error')
          return
        }
      }

      // Get ethers provider and signer
      const ethersProvider = new BrowserProvider(provider)
      state.signer = await ethersProvider.getSigner()
      state.address = address

      // Check if we have a deal loaded
      if (!state.deal) {
        showAlert('action-alert', 'Wallet connected! Search for a deal first.', 'info')
        return
      }

      // Verify buyer address
      if (state.address.toLowerCase() !== state.deal.buyer.toLowerCase()) {
        showAlert('action-alert', `Wrong wallet! This deal requires: ${short(state.deal.buyer)}`, 'error')
        return
      }

      // Update wallet display
      $('wallet-addr').textContent = short(state.address)

      // Handle release vs deposit flow
      if (state.action === 'release') {
        hide('connect-section')
        show('action-section')
        hide('approve-btn')
        hide('deposit-btn')
        show('release-btn')
        document.querySelector('.balance-card').style.display = 'none'
        setStep(3)
        showAlert('action-alert', 'Ready to release funds to seller. Click the button below.', 'success')
      } else {
        // Deposit mode - check balance and allowance
        const usdc = new Contract(CONFIG.USDC, ERC20_ABI, state.signer)
        const balance = await usdc.balanceOf(state.address)
        const balanceNum = parseFloat(formatUnits(balance, 6))
        const requiredNum = parseFloat(formatUnits(state.deal.amount, 6))

        $('balance-val').textContent = `${balanceNum.toFixed(2)} USDC`

        if (balance < state.deal.amount) {
          $('balance-val').classList.add('balance-low')
          $('balance-val').classList.remove('balance-ok')
          showAlert('action-alert', `Insufficient balance! You need ${requiredNum} USDC.`, 'error')
          hide('connect-section')
          show('action-section')
          $('approve-btn').disabled = true
          return
        }

        $('balance-val').classList.add('balance-ok')
        $('balance-val').classList.remove('balance-low')

        // Check allowance
        const allowance = await usdc.allowance(state.address, CONFIG.CONTRACT)

        hide('connect-section')
        show('action-section')

        if (allowance >= state.deal.amount) {
          hide('approve-btn')
          show('deposit-btn')
          setStep(3)
          showAlert('action-alert', 'USDC already approved. Ready to deposit!', 'success')
        } else {
          show('approve-btn')
          hide('deposit-btn')
          setStep(2)
          showAlert('action-alert', 'Wallet connected! Now approve USDC.', 'success')
        }
      }
    } catch (e) {
      console.error('Connection handling error:', e)
      showAlert('action-alert', 'Error setting up wallet. Try again.', 'error')
    }
  } else {
    // Wallet disconnected
    state.signer = null
    state.address = null
    if ($('action-section') && !$('action-section').classList.contains('hidden')) {
      hide('action-section')
      show('connect-section')
      setStep(1)
    }
  }
})

// =============================================================================
// APPROVE USDC
// =============================================================================

async function approveUSDC() {
  if (!state.signer) {
    showAlert('action-alert', 'Please connect wallet first.', 'error')
    return
  }

  setLoading('approve-btn', true)
  showAlert('action-alert', 'Confirm approval in your wallet...', 'info')

  try {
    const usdc = new Contract(CONFIG.USDC, ERC20_ABI, state.signer)
    const tx = await usdc.approve(CONFIG.CONTRACT, state.deal.amount)

    showAlert('action-alert', 'Waiting for confirmation...', 'info')
    await tx.wait()

    hide('approve-btn')
    show('deposit-btn')
    setStep(3)
    showAlert('action-alert', 'Approved! Now deposit to lock funds.', 'success')

  } catch (e) {
    console.error(e)
    if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
      showAlert('action-alert', 'Transaction cancelled', 'warning')
    } else {
      showAlert('action-alert', 'Approval failed. Try again.', 'error')
    }
  }

  setLoading('approve-btn', false)
}

// =============================================================================
// DEPOSIT USDC
// =============================================================================

async function depositUSDC() {
  if (!state.signer) {
    showAlert('action-alert', 'Please connect wallet first.', 'error')
    return
  }

  setLoading('deposit-btn', true)
  showAlert('action-alert', 'Confirm deposit in your wallet...', 'info')

  try {
    const escrow = new Contract(CONFIG.CONTRACT, ESCROW_ABI, state.signer)
    const tx = await escrow.deposit(state.deal.chainId)

    showAlert('action-alert', 'Processing payment...', 'info')
    await tx.wait()

    // Success!
    $('success-deal').textContent = state.deal.id
    $('success-amount').textContent = formatUnits(state.deal.amount, 6) + ' USDC'
    $('tx-link').href = `${CONFIG.EXPLORER}/tx/${tx.hash}`

    hide('deal-section')
    show('success-section')

  } catch (e) {
    console.error(e)
    if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
      showAlert('action-alert', 'Transaction cancelled', 'warning')
    } else {
      showAlert('action-alert', 'Deposit failed: ' + (e.reason || e.message), 'error')
    }
  }

  setLoading('deposit-btn', false)
}

// =============================================================================
// RELEASE FUNDS
// =============================================================================

async function releaseFunds() {
  if (!state.signer) {
    showAlert('action-alert', 'Please connect wallet first.', 'error')
    return
  }

  setLoading('release-btn', true)
  showAlert('action-alert', 'Confirm release in your wallet...', 'info')

  try {
    const escrow = new Contract(CONFIG.CONTRACT, RELEASE_ABI, state.signer)
    const tx = await escrow.release(state.deal.chainId)

    showAlert('action-alert', 'Processing release...', 'info')
    await tx.wait()

    // Success!
    $('success-deal').textContent = state.deal.id
    const amount = formatUnits(state.deal.amount, 6)
    const fee = (parseFloat(amount) * 0.015).toFixed(2)
    const sellerReceives = (parseFloat(amount) - parseFloat(fee)).toFixed(2)
    $('success-amount').textContent = `${sellerReceives} USDC (after 1.5% fee)`
    $('tx-link').href = `${CONFIG.EXPLORER}/tx/${tx.hash}`

    // Update success section text
    document.querySelector('.success-icon').textContent = '💸'
    document.querySelector('#success-section h2').textContent = 'Funds Released!'
    document.querySelector('#success-section p').textContent = 'Payment has been sent to the seller.'

    hide('deal-section')
    show('success-section')

  } catch (e) {
    console.error(e)
    if (e.code === 'ACTION_REJECTED' || e.code === 4001) {
      showAlert('action-alert', 'Transaction cancelled', 'warning')
    } else {
      showAlert('action-alert', 'Release failed: ' + (e.reason || e.message), 'error')
    }
  }

  setLoading('release-btn', false)
}

// =============================================================================
// DISCONNECT WALLET
// =============================================================================

function disconnectWallet() {
  // Disconnect via Web3Modal
  modal.disconnect()

  // Reset state
  state.signer = null
  state.address = null

  // Reset UI - show connect button, hide action section
  hide('action-section')
  show('connect-section')
  hide('release-btn')
  show('approve-btn')
  hide('deposit-btn')
  clearAlert('action-alert')
  setStep(1)

  // Reset balance card visibility
  document.querySelector('.balance-card').style.display = 'block'

  // Re-enable approve button in case it was disabled
  const approveBtn = $('approve-btn')
  if (approveBtn) approveBtn.disabled = false
}

// =============================================================================
// GO BACK
// =============================================================================

function goBack() {
  hide('deal-section')
  show('search-section')
  hide('action-section')
  show('connect-section')
  hide('release-btn')
  clearAlert('action-alert')
  setStep(1)
  state.signer = null
  state.address = null
  state.action = 'deposit'
  document.querySelector('.balance-card').style.display = 'block'

  // Disconnect wallet
  modal.disconnect()
}

// =============================================================================
// INIT
// =============================================================================

function init() {
  // Format input as user types
  const dealInput = $('deal-input')
  if (dealInput) {
    dealInput.addEventListener('input', function(e) {
      let val = e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, '')
      e.target.value = val
    })
  }

  // Auto-load from URL
  const params = new URLSearchParams(window.location.search)
  const deal = params.get('deal')
  if (deal) {
    $('deal-input').value = deal.toUpperCase()
    searchDeal()
  }
}

// Run on DOM ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init)
} else {
  init()
}

// =============================================================================
// EXPOSE TO WINDOW (for onclick handlers in HTML)
// =============================================================================

window.searchDeal = searchDeal
window.openConnectModal = openConnectModal
window.approveUSDC = approveUSDC
window.depositUSDC = depositUSDC
window.releaseFunds = releaseFunds
window.goBack = goBack
window.disconnectWallet = disconnectWallet
