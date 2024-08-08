// Import necessary modules
import { providers, utils } from 'near-api-js';
import { ulid } from 'ulid';
import { setupModal } from '@near-wallet-selector/modal-ui';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupMyNearWallet } from '@near-wallet-selector/my-near-wallet';
import NearIconUrl from '@near-wallet-selector/my-near-wallet/assets/my-near-wallet-icon.png';
import crypto from 'crypto';
import bs58 from 'bs58';
import nacl from 'tweetnacl';

// Constants
const THIRTY_TGAS = "12500000000000";

// Utility functions
function ensureDateIsSet(dateVar, defaultValue) {
  return dateVar || defaultValue;
}

function base64ToBase64Url(base64) {
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// Wallet class
export class Wallet {
  walletSelector;
  wallet;
  network;
  createAccessKeyFor;

  constructor({ createAccessKeyFor = undefined, network = 'testnet' }) {
    this.createAccessKeyFor = createAccessKeyFor;
    this.network = network;
  }

  async startUp() {
    this.walletSelector = await setupWalletSelector({
      network: this.network,
      modules: [setupMyNearWallet({ iconUrl: NearIconUrl })],
    });

    const isSignedIn = this.walletSelector.isSignedIn();

    if (isSignedIn) {
      this.wallet = await this.walletSelector.wallet();
      this.accountId = this.walletSelector.store.getState().accounts[0].accountId;
    }

    return isSignedIn;
  }

  signIn() {
    const pleaseselectwallet = 'Please select a wallet to sign in.';
    const modal = setupModal(this.walletSelector, { contractId: this.createAccessKeyFor, pleaseselectwallet });
    modal.show();
  }

  signOut() {
    this.wallet.signOut();
    this.wallet = this.accountId = this.createAccessKeyFor = null;
    window.location.replace(window.location.origin + window.location.pathname);
  }

  async viewMethod({ contractId, method, argVM = {} }) {
    const { network } = this.walletSelector.options;
    const provider = new providers.JsonRpcProvider({ url: network.nodeUrl });

    let res = await provider.query({
      request_type: 'call_function',
      account_id: contractId,
      method_name: method,
      args_base64: Buffer.from(JSON.stringify(argVM)).toString('hex'),
      finality: 'optimistic',
    });
    return JSON.parse(Buffer.from(res.result).toString());
  }

  async callMethod(contractId, actionset) {
    const outcome = await this.wallet.signAndSendTransaction({
      signerId: this.accountId,
      receiverId: contractId,
      actions: actionset,
    });
    return providers.getTransactionLastResult(outcome);
  }

  async getTransactionResult(txhash) {
    const { network } = this.walletSelector.options;
    const provider = new providers.JsonRpcProvider({ url: network.nodeUrl });

    const transaction = await provider.txStatus(txhash, 'unnused');
    return providers.getTransactionLastResult(transaction);
  }
}

// Contract class
export class Contract {
  constructor({ contractId, walletToUse }) {
    this.contractId = contractId;
    this.wallet = walletToUse;
  }

  async listrodits() {
    const Rodits = await this.wallet.viewMethod({
      contractId: this.contractId,
      method: "rodit_tokens",
    });
    return Rodits;
  }

  async buildsetofrodit(
    numberofclients,
    openapijsonurl,
    notafter,
    notbefore,
    maxrequests,
    maxrqwindow,
    jwtduration,
    permissionedroutes,
    subjectuniqueidentifierurl,
    base58_sp_private_key,
    owneraccountid
  ) {
    const deposit = utils.format.parseNearAmount("0.1"); // Fee per RODiT minter
    let gas = THIRTY_TGAS;
    let actionset = [];

    // Convert the private key to binary
    let bytes_sp_private_key = new Uint8Array(bs58.decode(base58_sp_private_key));
    let base64_sp_signature = Buffer.from(bytes_sp_private_key).toString("base64");

    const scaccountid = "10201-cableguard-org.testnet";
    let ulidofserver = ulid();
    console.debug(`ulidofserver`, ulidofserver);
    console.debug(`numberofclients`, numberofclients);
    let serverulid = "bc=near.org;sc=" + scaccountid + ";id=" + ulidofserver;
    
    notafter = ensureDateIsSet(notafter, '1970-01-01');
    notbefore = ensureDateIsSet(notbefore, '1970-01-01');

    for (let i = 0; i < numberofclients; i++) {
      if (i == 0) {
        let actionsrv = {
          type: "FunctionCall",
          params: {
            methodName: "rodit_mint",
            args: {
              token_id: serverulid,
              openapijson_url: openapijsonurl,
              not_after: notafter,
              not_before: notbefore,
              max_requests: maxrequests,
              maxrq_window: maxrqwindow,
              jwt_duration: jwtduration,
              permissioned_routes: permissionedroutes,
              subjectuniqueidentifier_url: subjectuniqueidentifierurl,
              serviceprovider_id: ulidofserver,
              serviceprovider_signature: 0,
              owneraccount_id: owneraccountid,
            },
            gas,
            deposit,
          },
        };

        // Create the serviceprovider signature
        let signature = nacl.sign.detached(Uint8Array.from(serverulid, (char) => char.charCodeAt(0)), bytes_sp_private_key);
        base64_sp_signature = Buffer.from(signature).toString("base64");

        // Add the signature to the actionsrv object
        actionsrv.params.args.serviceprovider_signature = base64ToBase64Url(base64_sp_signature);
        actionset.push(actionsrv);
      } else {
        let clientulid = ulid();
        console.debug(`permissionedroutes`, permissionedroutes);
        console.debug(`clientulid`, clientulid);
        let actioncli = {
          type: "FunctionCall",
          params: {
            methodName: "rodit_mint",
            args: {
              token_id: clientulid,
              openapijson_url: openapijsonurl,
              not_after: notafter,
              not_before: notbefore,
              max_requests: maxrequests,
              maxrq_window: maxrqwindow,
              jwt_duration: jwtduration,
              permissioned_routes: permissionedroutes,
              subjectuniqueidentifier_url: subjectuniqueidentifierurl,
              serviceprovider_id: serverulid,
              serviceprovider_signature: 0,
              owneraccount_id: owneraccountid,
            },
            gas,
            deposit,
          },
        };

        // Create the client signature
        let signature = nacl.sign.detached(Uint8Array.from(clientulid, (char) => char.charCodeAt(0)), bytes_sp_private_key);
        base64_sp_signature = Buffer.from(signature).toString("base64");

        // Add the signature to the actioncli object
        actioncli.params.args.serviceprovider_signature = base64ToBase64Url(base64_sp_signature);
        actionset.push(actioncli);
      }
    }

    return await this.wallet.callMethod(this.contractId, actionset);
  }
}
