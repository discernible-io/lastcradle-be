/**
 * Data models for RODiT authentication
 * Copyright (c) 2024 Cableguard, Inc. All rights reserved.
 */

/**
 * RODiT token class that represents a Resource Ownership and Digital Identity Token
 */
class RODiT {
    constructor() {
      this.token_id = "";
      this.owner_id = "";
      this.metadata = {
        openapijson_url: "",
        not_after: "",
        not_before: "",
        max_requests: "",
        maxrq_window: "",
        webhook_url: "",
        webhook_cidr: "",
        userselected_dn: "",
        allowed_cidr: "",
        allowed_iso3166list: "",
        jwt_duration: "",
        permissioned_routes: "",
        subjectuniqueidentifier_url: "",
        serviceprovider_id: "",
        serviceprovider_signature: "",
      };
    }
  }
  
  /**
   * Payload class for NEP-413 standard
   */
  class PayloadNEP413 {
    constructor(props) {
      this.tag = props.tag || 2147484061;
      this.message = props.message;
      if (props.nonce instanceof Uint8Array) {
        if (props.nonce.length !== 32) {
          throw new Error("Nonce must be exactly 32 bytes");
        }
        this.nonce = props.nonce;
      } else if (
        Array.isArray(props.nonce) ||
        (typeof props.nonce === "object" && props.nonce !== null)
      ) {
        const nonceArray = Array.isArray(props.nonce)
          ? props.nonce
          : Object.values(props.nonce);
        if (nonceArray.length !== 32) {
          throw new Error("Nonce must be exactly 32 bytes");
        }
        this.nonce = new Uint8Array(nonceArray);
      } else {
        throw new Error(
          "Invalid nonce format - must be Uint8Array or convertible to Uint8Array"
        );
      }
      this.recipient = props.recipient;
      this.callbackUrl = props.callbackUrl;
    }
  }
  
  /**
   * Schema for NEP-413 payload in Borsh format
   */
  const PayloadNEP413Schema = {
    struct: {
      tag: "u32",
      message: "string",
      nonce: { array: { type: "u8", len: 32 } },
      recipient: "string",
      callbackUrl: { option: "string" },
    },
  };
  
  module.exports = {
    RODiT,
    PayloadNEP413,
    PayloadNEP413Schema
  };