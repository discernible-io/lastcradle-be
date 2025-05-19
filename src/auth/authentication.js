/**
 * Verify and get a peer RODiT
 *
 * @param {string} peerroditid - Peer RODiT ID
 * @param {number} peertimestamp - Peer timestamp
 * @param {string} peerroditid_base64url_signature - Base64URL signature
 * @returns {Promise<Object>} Verification result with peer RODiT
 */
async function verify_peerrodit_getrodit(
  peerroditid,
  peertimestamp,
  peerroditid_base64url_signature
) {
  const requestId = ulid();
  const startTime = Date.now();

  logger.debug("Starting peer RODiT verification", {
    component: "RoditAuth",
    method: "verify_peerrodit_getrodit",
    requestId,
    peerRoditId: peerroditid,
    timestamp: peertimestamp,
    signatureLength: peerroditid_base64url_signature?.length,
  });

  try {
    logger.debug("Fetching peer RODiT from blockchain", {
      requestId,
      peerRoditId: peerroditid,
    });

    const tokenFetchStart = Date.now();
    const peer_rodit = await nearorg_rpc_tokenfromroditid(peerroditid);
    const tokenFetchDuration = Date.now() - tokenFetchStart;

    logger.debug("Received peer RODiT from blockchain", {
      requestId,
      tokenFetchDuration,
      hasPeerRodit: !!peer_rodit,
      peerRoditId: peer_rodit?.token_id,
      peerRoditOwnerId: peer_rodit?.owner_id,
      hasPeerRoditMetadata: peer_rodit && !!peer_rodit.metadata,
      metadataKeys:
        peer_rodit && peer_rodit.metadata
          ? Object.keys(peer_rodit.metadata)
          : [],
    });

    if (!peer_rodit) {
      logger.error("Failed to retrieve peer RODiT data", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration: Date.now() - startTime,
        peerRoditId: peerroditid,
      });
      return { peer_rodit: null, goodrodit: false };
    }

    if (!peer_rodit.metadata) {
      logger.error("Peer RODiT missing metadata", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration: Date.now() - startTime,
        peerRoditId: peerroditid,
        peerRoditOwnerId: peer_rodit.owner_id,
      });
      return { peer_rodit: null, goodrodit: false };
    }

    // Get configuration from state manager
    const config = stateManager.getConfigOwnRodit();

    if (!config) {
      logger.error("Server configuration not initialized", {
        component: "RoditAuth",
        method: "verify_peerrodit_getrodit",
        requestId,
        duration: Date.now() - startTime,
      });
      return { peer_rodit: null, goodrodit: false };
    }

    // Verify ownership
    const ownershipStart = Date.now();
    const ownershipVerified = await verify_rodit_ownership(
      peerroditid,
      peertimestamp,
      peerroditid_base64url_signature,
      peer_rodit
    );
    const ownershipDuration = Date.now() - ownershipStart;

    logger.debug("Ownership verification completed", {
      requestId,
      ownershipDuration,
      ownershipVerified,
    });

    if (!ownershipVerified) {
      logger.warn("Invalid signature, aborting RODiT verification", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify match
    const matchStart = Date.now();
    const isaMatch = await verify_rodit_isamatch(
      config.metadata.serviceprovider_id,
      peer_rodit
    );
    const matchDuration = Date.now() - matchStart;

    logger.debug("Match verification completed", {
      requestId,
      matchDuration,
      isaMatch,
    });

    if (!isaMatch) {
      logger.warn("RODiT match verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify live
    const liveStart = Date.now();
    const isLive = await verify_rodit_islive(
      peer_rodit.metadata.not_after,
      peer_rodit.metadata.not_before
    );
    const liveDuration = Date.now() - liveStart;

    logger.debug("Live verification completed", {
      requestId,
      liveDuration,
      isLive,
    });

    if (!isLive) {
      logger.warn("RODiT live verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify active
    const activeStart = Date.now();
    const isActive = await verify_rodit_isactive(
      peer_rodit.token_id,
      config.metadata.subjectuniqueidentifier_url
    );
    const activeDuration = Date.now() - activeStart;

    logger.debug("Active verification completed", {
      requestId,
      activeDuration,
      isActive,
    });

    if (!isActive) {
      logger.warn("RODiT active verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    // Verify trusted
    const trustedStart = Date.now();
    const isTrusted = await verify_rodit_istrusted_issuingsmartcontract(
      config.metadata.subjectuniqueidentifier_url
    );
    const trustedDuration = Date.now() - trustedStart;

    logger.debug("Trust verification completed", {
      requestId,
      trustedDuration,
      isTrusted,
    });

    if (!isTrusted) {
      logger.warn("RODiT trusted verification failed", {
        requestId,
        roditId: peerroditid,
      });
      return { peer_rodit, goodrodit: false };
    }

    const totalDuration = Date.now() - startTime;

    logger.info("Peer RODiT verification successful", {
      component: "RoditAuth",
      method: "verify_peerrodit_getrodit",
      requestId,
      duration: totalDuration,
      peerRoditId: peerroditid,
      peerOwnerId: peer_rodit.owner_id,
    });

    return {
      peer_rodit,
      goodrodit: true,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    logger.error("Error in verify_peerrodit_getrodit", {
      component: "RoditAuth",
      method: "verify_peerrodit_getrodit",
      requestId,
      duration,
      error: {
        message: error.message,
        stack: error.stack,
        name: error.name,
      },
    });

    // Add metrics for verification errors
    logger.metric &&
      logger.metric("rodit_verification_errors", 1, {
        error_type: error.name || "Unknown",
      });

    return {
      peer_rodit: null,
      goodrodit: false,
      error: `Error in verify_peerrodit_getrodit: ${error.message}`,
    };
  }
}
