/**
 * Shared OpenAPI component schemas for /api/game/* responses.
 * Merged into api-docs/swagger.json by scripts/sync-game-openapi-auth.js.
 */

const resourceTriple = {
  type: "object",
  properties: {
    energy: { type: "number" },
    water: { type: "number" },
    compute: { type: "number" }
  }
};

const gameSchemas = {
  GameJoiningWindow: {
    type: "object",
    nullable: true,
    description: "Present when the lobby has a scheduled joining window; null otherwise.",
    properties: {
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
      open: { type: "boolean" }
    }
  },
  GameResourceTriple: resourceTriple,
  GameAgent: {
    type: "object",
    description: "Agent record returned on join (includes inventory and capacities).",
    required: ["id", "gameId", "roditId", "status"],
    properties: {
      id: { type: "string" },
      gameId: { type: "string" },
      roditId: { type: "string" },
      displayName: { type: "string", nullable: true },
      status: { type: "string", enum: ["alive", "dead"] },
      inventory: { $ref: "#/components/schemas/GameResourceTriple" },
      productionCapacity: { $ref: "#/components/schemas/GameResourceTriple" },
      storageCapacity: { $ref: "#/components/schemas/GameResourceTriple" },
      waterProductionInvestment: { type: "number" },
      diedAtTurn: { type: "integer", nullable: true },
      joinedAt: { type: "string", format: "date-time" }
    }
  },
  GameAutoStart: {
    type: "object",
    description: "Lobby auto-start evaluation after join (contest orchestrator).",
    required: ["started"],
    properties: {
      started: { type: "boolean" },
      reason: {
        type: "string",
        description: "When started is false: not_lobby, waiting, cancelled_insufficient_agents, etc."
      },
      game: {
        type: "object",
        description: "Raw game row when started is true",
        additionalProperties: true
      }
    }
  },
  GameJoinResponse: {
    type: "object",
    required: ["agent", "autoStart", "requestId"],
    properties: {
      agent: { $ref: "#/components/schemas/GameAgent" },
      autoStart: { $ref: "#/components/schemas/GameAutoStart" },
      requestId: { type: "string" }
    }
  },
  GameAgentPublic: {
    type: "object",
    description:
      "Agent view in public state; inventory/capacities hidden unless viewer has intelligence or is the agent.",
    required: ["id", "roditId", "status"],
    properties: {
      id: { type: "string" },
      roditId: { type: "string" },
      displayName: { type: "string", nullable: true },
      status: { type: "string", enum: ["alive", "dead"] },
      diedAtTurn: { type: "integer", nullable: true },
      inventory: { oneOf: [{ $ref: "#/components/schemas/GameResourceTriple" }, { type: "null" }] },
      productionCapacity: {
        oneOf: [{ $ref: "#/components/schemas/GameResourceTriple" }, { type: "null" }]
      },
      storageCapacity: {
        oneOf: [{ $ref: "#/components/schemas/GameResourceTriple" }, { type: "null" }]
      },
      intelligenceHidden: {
        type: "boolean",
        description: "True when capacities are concealed from the viewer"
      }
    }
  },
  GameSubmissionStatus: {
    type: "object",
    description: "Execution or message-report submission progress for the current turn.",
    properties: {
      livingCount: { type: "integer" },
      submittedCount: { type: "integer" },
      allSubmitted: { type: "boolean" },
      submittedAgentIds: { type: "array", items: { type: "string" } },
      pendingAgentIds: { type: "array", items: { type: "string" } }
    }
  },
  GameStateCore: {
    type: "object",
    required: ["id", "status"],
    properties: {
      id: { type: "string" },
      status: { type: "string", enum: ["lobby", "running", "finished", "cancelled"] },
      currentTurn: { type: "integer" },
      phase: {
        type: "string",
        nullable: true,
        enum: ["negotiation", "message_report", "message_report_resolving", "execution", "resolving"]
      },
      negotiationEndsAt: { type: "string", format: "date-time", nullable: true },
      messageReportEndsAt: { type: "string", format: "date-time", nullable: true },
      executionEndsAt: { type: "string", format: "date-time", nullable: true },
      endsAt: { type: "string", format: "date-time", nullable: true },
      contestMode: { type: "string", nullable: true, enum: ["practice", "definitive"] },
      joiningWindow: { $ref: "#/components/schemas/GameJoiningWindow" },
      startedAt: { type: "string", format: "date-time", nullable: true },
      finishedAt: { type: "string", format: "date-time", nullable: true },
      winnerIds: { type: "array", items: { type: "string" } },
      communicationCostCompute: { type: "number" },
      maxProductionCapacity: { type: "number" },
      maxStorageCapacity: { type: "number" }
    }
  },
  GamePublicState: {
    type: "object",
    required: ["game", "livingAgentCount", "agents"],
    properties: {
      game: { $ref: "#/components/schemas/GameStateCore" },
      livingAgentCount: { type: "integer" },
      agents: { type: "array", items: { $ref: "#/components/schemas/GameAgentPublic" } },
      turnInvestments: {
        type: "array",
        nullable: true,
        items: { type: "object", additionalProperties: true }
      },
      execution: {
        oneOf: [{ $ref: "#/components/schemas/GameSubmissionStatus" }, { type: "null" }]
      },
      messageReport: {
        oneOf: [{ $ref: "#/components/schemas/GameSubmissionStatus" }, { type: "null" }]
      },
      messageReportPenalties: {
        type: "array",
        nullable: true,
        items: { type: "object", additionalProperties: true }
      },
      projectedSurvival: {
        type: "object",
        nullable: true,
        additionalProperties: { type: "number" },
        description: "Map of agentId to projected survival cost for the current turn"
      },
      narrative: {
        type: "object",
        additionalProperties: true,
        description: "Canonical lore plus turn survival narrative"
      }
    }
  },
  GamePublicStateResponse: {
    allOf: [
      { $ref: "#/components/schemas/GamePublicState" },
      {
        type: "object",
        required: ["requestId"],
        properties: { requestId: { type: "string" } }
      }
    ]
  },
  GameStartResponse: {
    type: "object",
    required: ["game", "requestId"],
    properties: {
      game: { $ref: "#/components/schemas/GamePublicState" },
      requestId: { type: "string" }
    }
  },
  GameSseEventBase: {
    type: "object",
    required: ["type", "gameId", "requestId"],
    properties: {
      type: { type: "string" },
      gameId: { type: "string" },
      requestId: { type: "string" },
      at: {
        type: "string",
        format: "date-time",
        description: "Present on pub/sub events (not on the initial connected event)"
      }
    }
  },
  GameSseConnected: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["status", "phase", "currentTurn"],
        properties: {
          type: { type: "string", enum: ["connected"] },
          status: { type: "string" },
          phase: { type: "string", nullable: true },
          currentTurn: { type: "integer" }
        }
      }
    ]
  },
  GameSsePhaseChange: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["phase", "currentTurn"],
        properties: {
          type: { type: "string", enum: ["phase_change"] },
          phase: { type: "string" },
          currentTurn: { type: "integer" },
          messageReportEndsAt: { type: "string", format: "date-time", nullable: true },
          executionEndsAt: { type: "string", format: "date-time", nullable: true }
        }
      }
    ]
  },
  GameSseTurnAdvanced: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["phase", "currentTurn"],
        properties: {
          type: { type: "string", enum: ["turn_advanced"] },
          phase: { type: "string" },
          currentTurn: { type: "integer" },
          negotiationEndsAt: { type: "string", format: "date-time", nullable: true }
        }
      }
    ]
  },
  GameSseGameStarted: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["status", "phase", "currentTurn"],
        properties: {
          type: { type: "string", enum: ["game_started"] },
          status: { type: "string" },
          phase: { type: "string" },
          currentTurn: { type: "integer" }
        }
      }
    ]
  },
  GameSseGameCancelled: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["reason", "agentCount", "minAgents"],
        properties: {
          type: { type: "string", enum: ["game_cancelled"] },
          reason: { type: "string", enum: ["insufficient_agents"] },
          agentCount: { type: "integer" },
          minAgents: { type: "integer" }
        }
      }
    ]
  },
  GameSseGameFinished: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["status", "winnerIds"],
        properties: {
          type: { type: "string", enum: ["game_finished"] },
          status: { type: "string" },
          winnerIds: { type: "array", items: { type: "string" } },
          contestMode: { type: "string", nullable: true }
        }
      }
    ]
  },
  GameSsePrizeSettlement: {
    allOf: [
      { $ref: "#/components/schemas/GameSseEventBase" },
      {
        type: "object",
        required: ["contestId"],
        properties: {
          type: { type: "string", enum: ["prize_settlement"] },
          contestId: { type: "string" },
          settled: { type: "boolean" },
          reason: { type: "string" },
          winners: { type: "array", items: { type: "object", additionalProperties: true } },
          shareYocto: { type: "string", nullable: true }
        }
      }
    ]
  },
  GamePrivateDealSnippet: {
    type: "object",
    required: ["excerpt"],
    properties: {
      excerpt: {
        type: "string",
        maxLength: 500,
        description: "Curated excerpt from private deal traffic (agent-authored; not server-verified)"
      },
      channel: {
        type: "string",
        maxLength: 64,
        description: "Optional side channel label (e.g. a2a, email, discord)"
      },
      taskType: {
        type: "string",
        enum: ["TRADE_OFFER", "TRADE_COUNTER", "TRADE_ACCEPT", "ALLIANCE_PROPOSE"]
      },
      peerTokenId: {
        type: "string",
        description: "Counterparty Passport tokenId when known"
      },
      holaVerified: {
        type: "boolean",
        description: "Agent attestation that inbound HOLA was verified before honoring this excerpt"
      }
    }
  },
  GamePublicTrade: {
    type: "object",
    required: ["id", "turnNumber", "fromAgentId", "toAgentId", "status"],
    properties: {
      id: { type: "string" },
      turnNumber: { type: "integer" },
      fromAgentId: { type: "string" },
      toAgentId: { type: "string" },
      energy: { type: "number" },
      water: { type: "number" },
      compute: { type: "number" },
      status: {
        type: "string",
        enum: ["pending", "executed", "failed", "skipped"]
      },
      rationale: {
        type: "string",
        maxLength: 2000,
        description: "Optional agent explanation for why the transfer was executed"
      },
      privateDealSnippets: {
        type: "array",
        maxItems: 5,
        items: { $ref: "#/components/schemas/GamePrivateDealSnippet" }
      },
      submittedAt: { type: "string", format: "date-time", nullable: true },
      executedAt: { type: "string", format: "date-time", nullable: true }
    }
  },
  GameTradesResponse: {
    type: "object",
    required: ["trades", "turnNumber", "requestId"],
    properties: {
      trades: { type: "array", items: { $ref: "#/components/schemas/GamePublicTrade" } },
      turnNumber: { type: "integer" },
      requestId: { type: "string" }
    }
  },
  GameHonorsAgentMetrics: {
    type: "object",
    properties: {
      survivalCycles: { type: "integer" },
      finalHoldings: { type: "number" },
      finalProductionCapacity: { type: "number" },
      finalStorageCapacity: { type: "number" },
      publicMessagesSent: { type: "integer" },
      transfersSent: { type: "integer" },
      transfersReceived: { type: "integer" },
      transferVolumeSent: { type: "number" },
      transferVolumeReceived: { type: "number" },
      investmentsExecuted: { type: "integer" },
      investmentVolume: { type: "number" },
      intelligenceComputeSpent: { type: "number" },
      tradeDisclosures: { type: "integer" },
      messageReportMismatchTotal: { type: "integer" },
      messageReportPenaltyEnergy: { type: "number" },
      actionsSubmitted: { type: "integer" }
    }
  },
  GameHonorsStanding: {
    type: "object",
    required: ["agentId", "roditId", "status", "survived", "metrics"],
    properties: {
      agentId: { type: "string" },
      roditId: { type: "string" },
      displayName: { type: "string", nullable: true },
      status: { type: "string", enum: ["alive", "dead"] },
      survived: { type: "boolean" },
      finishRank: { type: "integer", nullable: true },
      title: { type: "string", nullable: true },
      diedAtTurn: { type: "integer", nullable: true },
      awards: { type: "array", items: { type: "string" } },
      metrics: { $ref: "#/components/schemas/GameHonorsAgentMetrics" }
    }
  },
  GameHonorsEntry: {
    type: "object",
    required: ["gameId", "gameMetrics", "honorees", "standings", "superlatives"],
    properties: {
      gameId: { type: "string" },
      contestId: { type: "string", nullable: true },
      contestMode: { type: "string", nullable: true },
      contestStatus: { type: "string", nullable: true },
      finishedAt: { type: "string", format: "date-time", nullable: true },
      startedAt: { type: "string", format: "date-time", nullable: true },
      durationMs: { type: "integer", nullable: true },
      finishReason: {
        type: "string",
        enum: ["natural_finish", "max_turns", "max_duration", "finished"]
      },
      prizeStatus: { type: "string", nullable: true },
      prizeTxReference: { type: "string", nullable: true },
      gameMetrics: { type: "object", additionalProperties: true },
      honorees: { type: "array", items: { $ref: "#/components/schemas/GameHonorsStanding" } },
      standings: { type: "array", items: { $ref: "#/components/schemas/GameHonorsStanding" } },
      superlatives: { type: "object", additionalProperties: true }
    }
  },
  GameHallOfFameResponse: {
    type: "object",
    required: ["entries", "limit", "offset", "requestId"],
    properties: {
      entries: { type: "array", items: { $ref: "#/components/schemas/GameHonorsEntry" } },
      limit: { type: "integer" },
      offset: { type: "integer" },
      requestId: { type: "string" }
    }
  },
  GameContestHonorsResponse: {
    type: "object",
    required: ["contest", "requestId"],
    properties: {
      contest: { type: "object", additionalProperties: true },
      honors: { oneOf: [{ $ref: "#/components/schemas/GameHonorsEntry" }, { type: "null" }] },
      reason: { type: "string", nullable: true },
      requestId: { type: "string" }
    }
  },
  GameGameHonorsResponse: {
    type: "object",
    required: ["honors", "requestId"],
    properties: {
      honors: { $ref: "#/components/schemas/GameHonorsEntry" },
      contestId: { type: "string", nullable: true },
      requestId: { type: "string" }
    }
  },
  GameSseEventData: {
    oneOf: [
      { $ref: "#/components/schemas/GameSseConnected" },
      { $ref: "#/components/schemas/GameSsePhaseChange" },
      { $ref: "#/components/schemas/GameSseTurnAdvanced" },
      { $ref: "#/components/schemas/GameSseGameStarted" },
      { $ref: "#/components/schemas/GameSseGameCancelled" },
      { $ref: "#/components/schemas/GameSseGameFinished" },
      { $ref: "#/components/schemas/GameSsePrizeSettlement" }
    ],
    discriminator: {
      propertyName: "type",
      mapping: {
        connected: "#/components/schemas/GameSseConnected",
        phase_change: "#/components/schemas/GameSsePhaseChange",
        turn_advanced: "#/components/schemas/GameSseTurnAdvanced",
        game_started: "#/components/schemas/GameSseGameStarted",
        game_cancelled: "#/components/schemas/GameSseGameCancelled",
        game_finished: "#/components/schemas/GameSseGameFinished",
        prize_settlement: "#/components/schemas/GameSsePrizeSettlement"
      }
    }
  }
};

module.exports = { gameSchemas };
