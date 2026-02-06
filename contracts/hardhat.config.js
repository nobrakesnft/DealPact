require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const hasValidKey = PRIVATE_KEY && PRIVATE_KEY.length === 64;

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  networks: {
    hardhat: {},
    baseSepolia: {
      url: "https://sepolia.base.org",
      accounts: hasValidKey ? [PRIVATE_KEY] : [],
      chainId: 84532
    },
    base: {
      url: "https://mainnet.base.org",
      accounts: hasValidKey ? [PRIVATE_KEY] : [],
      chainId: 8453
    }
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || ""
  },
  sourcify: {
    enabled: true
  }
};
