// Copyright (c) 2023 Cableguard, Inc. All rights reserved.
// SPDX-License-Identifier: BSD-3-Clause

// Constants
const CONSTANTS = {
    SMART_CONTRACT: "09313-cableguard-org.testnet",
    BLOCKCHAIN_NETWORK: ".testnet.", // IMPORTANT: Values here must be either "testnet." for testnet or "." for mainnet
    RODIT_ID_SZ: 128,
    RODIT_ID_SIGNATURE_SZ: 64,
    ED25519_KEY_SZ: 64
};

const RODIT_ID_PK_SZ = 32;

// Rodit class
class Rodit {
    constructor() {
        this.token_id = "";
        this.owner_id = "";
        this.metadata = new RoditMetadata();
        this.approved_account_ids = null;
        this.royalty = null;
    }
}

// RoditMetadata class
class RoditMetadata {
    constructor() {
        this.issuername = "";
        this.description = "";
        this.notafter = "";
        this.notbefore = "";
        this.cidrblock = "";
        this.listenport = "";
        this.dns = "";
        this.allowedips = "";
        this.subjectuniqueidentifierurl = "";
        this.serviceproviderid = "";
        this.serviceprovidersignature = "";
    }
}