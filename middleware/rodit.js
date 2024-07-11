// Copyright (c) 2023 Cableguard, Inc. All rights reserved.
// SPDX-License-Identifier: BSD-3-Clause

const nacl = require('tweetnacl');
nacl.util = require('tweetnacl-util');
const { base64encode } = require('base64-js'); // Replace with your base64 encoding library

// Constants
const CONSTANTS = {
    SMART_CONTRACT: "09313-cableguard-org.testnet",
    BLOCKCHAIN_NETWORK: ".testnet", // IMPORTANT: Values here must be either "testnet." for testnet or "." for mainnet
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
        this.approved_account_ids = null;
        this.royalty = null;
        this.metadata = {
            issuername: "",
            description: "",
            notafter: "",
            notbefore: "",
            cidrblock: "",
            listenport: "",
            dns: "",
            allowedips: "",
            subjectuniqueidentifierurl: "",
            serviceproviderid: "",
            serviceprovidersignature: ""
        };
    }
}

async function verify_isthererodit_getit(rodit_id, base64_rodit_id_signature) {
    const slice_roditid = rodit_id.slice();
    const string_roditid = Buffer.from(slice_roditid).toString('utf8').replace(/\0/g, '');
    const account_idargs = `{"token_id": "${string_roditid}"}`;

    try {
        // Ensure rodit_id and rodit_id_signature are Uint8Array
        const bytes_rodit_id = new Uint8Array(Buffer.from(rodit_id));
        const bytes_ed25519_signature = new Uint8Array(Buffer.from(base64_rodit_id_signature, 'base64'));

        const fetched_rodit = await nearorg_rpc_token(CONSTANTS.BLOCKCHAIN_NETWORK, CONSTANTS.SMART_CONTRACT, "nft_token", account_idargs);
        
        // Convert the owner_id string to a Uint8Array by decoding it from hex
        const fetched_bytes_ed25519_public_key = new Uint8Array(Buffer.from(fetched_rodit.owner_id, 'hex'));

        const isVerified = nacl.sign.detached.verify(bytes_rodit_id, bytes_ed25519_signature, fetched_bytes_ed25519_public_key);

        if (isVerified) {
            console.debug('verify Rodit object:', fetched_rodit.metadata.issuername);
            console.trace('Info: Peer RODiT possession check confirmed');
            return fetched_rodit;
        } else {
            console.trace('Error: Peer RODiT possession check failed');
            throw new Error('PeerEd25519SignatureVerificationFailure');
        }
    } catch (err) {
        console.trace(`Error: There is no Peer RODiT associated with the account: ${err}`);
        throw new Error('PeerEd25519RoditMissing');
    }
}

async function nearorg_rpc_token(xnet, id, method_name, args) {
    const url = `https://rpc${xnet}.near.org`;

    if (xnet === '.') {
        console.debug('Info: Blockchain Directory Network is mainnet (nearorg_rpc_token)');
    } else {
        console.debug(`Info: Blockchain Directory Network is ${xnet} nearorg_rpc_token`);
    }

    const json_data = {
        jsonrpc: '2.0',
        id: id,
        method: 'query',
        params: {
            request_type: 'call_function',
            finality: 'final',
            account_id: id,
            method_name: method_name,
            args_base64: Buffer.from(args).toString('base64'),
        },
    };

    const response = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(json_data),
    })

    const json_response = await response.json();

    // Handle error response
    if (json_response.error) {
        throw new Error(`Error: ${json_response.error.message}`);
    }

    const result_array = json_response.result.result;

    if (!Array.isArray(result_array)) {
        throw new Error('Error: Result is not an array');
    }

    const result_bytes = result_array.map(v => v);

    const result_string = Buffer.from(result_bytes).toString('utf8');

    const rodit = new Rodit(); // Assuming Rodit constructor or deserialization method
    Object.assign(rodit, JSON.parse(result_string)); // Deserialize JSON string to Rodit object
    console.debug('nearorg Rodit object:', rodit.metadata.issuername);
    return rodit;
}

module.exports = {
    verify_isthererodit_getit, Rodit
};