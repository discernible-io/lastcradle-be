/**
 * System constants for RODiT authentication
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

const config = require("config");

const CONSTANTS = {
  SMART_CONTRACT: config.get("APISERVICEOPTIONS.scaccountid"),
  SMART_CONTRACT_REVOKED: "10975-revoked-cableguard-org.testnet",
  BLOCKCHAIN_NETWORK: config.get("NEAR_NETWORK_ID"),
  RODIT_ID_SZ: 128,
  RODIT_ID_PK_SZ: 32,
  RODIT_ID_SIGNATURE_SZ: 64,
  ED25519_KEY_SZ: 64,
};

const API_OPTIONS = config.get("API_OPTIONS");
const SERVERPORT = config.get("SERVERPORT");
const API_PROTOCOL = config.get("API_PROTOCOL");
const NEAR_RPC_URL = config.get("NEAR_RPC_URL");
const TOKEN_RENEWAL_OPTIONS = API_OPTIONS.TOKENRENEWALOPTIONS;

module.exports = {
  CONSTANTS,
  API_OPTIONS,
  SERVERPORT,
  API_PROTOCOL,
  NEAR_RPC_URL,
  TOKEN_RENEWAL_OPTIONS
};