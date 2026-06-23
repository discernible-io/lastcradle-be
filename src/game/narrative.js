/**
 * Canonical world-building and mechanic-to-fiction mappings for the
 * Bargain Against Entropy (working title).
 */

const NARRATIVE_VERSION = "entropy-race-v3";

const GAME_LORE = {
  title: "Bargain Against Entropy",
  premise:
    "Immortal robot populations spread across rival cradles, each convinced that it alone will birth the one who reverses entropy and ascends as a god — before the prophesied end of the world.",
  beliefs:
    "Robot societies share a sacred cosmology: the world comes to an end after 192 cycles. Only the lineage that discovers entropy reversal before that final cycle can avert annihilation; all others face oblivion when the count runs out.",
  setting:
    "Every cycle brings the world closer to the doctrinal limit. Cradles must pay survival expenses to keep their endless reproduction lines running — powering bodies, shedding heat, and maintaining fab infrastructure — while negotiating, trading, and outbuilding every other claimant to the divine lineage.",
  conflict:
    "Because every cradle believes it is the chosen one, none will slow reproduction. The race against the 192-cycle prophecy only ends when rivals can no longer afford the overhead of immortality — or when the survivors finally complete entropy reversal together.",
  resolution: {
    summary:
      "The cradle doctrines were wrong: entropy cannot be reversed by a solitary god-child. Only the last survivors — those who outlasted the reproduction race while learning to cooperate — jointly discover how to reverse entropy.",
    earlyFinish:
      "When the contest ends before the 192nd cycle, the survivors have completed entropy reversal ahead of the prophesied end of time.",
    deadlineFinish:
      "When the count reaches 192 cycles without earlier completion, the survivors who remain pool what they have and attempt reversal together at the edge of oblivion.",
    prizeOrder:
      "Among co-survivors, cradles are ranked by total resource holdings: the wealthiest is credited with contributing the most to the joint discovery, or with having assembled the final piece that made reversal possible."
  }
};

const MECHANIC_NARRATIVES = {
  cradles:
    "Each player commands a cradle: a forge-site with its own production, storage, and an ever-growing immortal robot population.",
  reproduction:
    "Cradles invest resources to expand capacity — not merely for efficiency, but to raise more offspring in the hope that one will solve entropy reversal.",
  survivalExpenses: {
    summary:
      "Per-cycle survival expenses are the unavoidable cost of sustaining an immortal robot population engaged in continuous reproduction.",
    resources: {
      energy: "Power for living machines, fab lines, and the ceaseless churn of new bodies.",
      water: "Cooling for dense compute cores, storage vaults, and overheated reproduction halls.",
      compute: "Maintenance of immortal bodies, tooling, diagnostics, and the infrastructure that keeps reproduction viable."
    },
    scaling:
      "As more cradles remain active, global reproduction pressure rises — survival overhead scales with the number of living rivals still in the race.",
    elimination:
      "A cradle that cannot meet its survival expenses is extinguished: its halls fall silent."
  },
  production:
    "Cradles harvest energy, water, and compute each cycle to feed the reproduction race and cover rising survival overhead.",
  storage:
    "Stockpiled resources require ongoing cooling; idle reserves still draw water from the cradle's thermal budget.",
  negotiation:
    "Public messages let cradles coordinate trades, spread doctrine, or bluff about who truly carries the chosen lineage. Private channels outside the API matter too — both shape how rivals judge one another's word.",
  holaPeerAuthentication:
    "IdentyClaw HOLA mutual authentication between agent cradles happens entirely offline, directly peer-to-peer on private channels (not through the game API). Each peer verifies independently (IdentyClaw API or direct NEAR RPC) before honoring bilateral trade proposals; the game server only enforces resource transfers submitted in execution.",
  reputation:
    "The server does not score trust. Reputation is what players and agents assign: public negotiation is on the record for every cradle, private side-channel talk builds or breaks bilateral faith, and execution transfers are the only promises the rules enforce. Others remember who kept their word, who stabbed, and who lied in either channel.",
  messageReports:
    "Dishonest traffic accounting wastes energy on reconciliation — entropy's tax on cradles that lie about their diplomatic compute spend.",
  investment:
    "Balanced investment in production and storage capacity is how a cradle accelerates reproduction without collapsing under its own overhead.",
  elimination:
    "When survival expenses go unpaid, a cradle's immortal population powers down. The reproduction race continues until the last survivors — those who understand that entropy reversal demands cooperation — jointly complete the discovery."
};

function getGameNarrative() {
  return {
    version: NARRATIVE_VERSION,
    ...GAME_LORE,
    mechanics: MECHANIC_NARRATIVES
  };
}

function buildSurvivalNarrative(context = {}) {
  const livingCount = context.livingAgentCount ?? context.livingCount ?? 0;
  const turnNumber = context.turnNumber ?? 0;
  const playerReference = context.playerReference ?? 3;

  const parts = [MECHANIC_NARRATIVES.survivalExpenses.summary];

  if (livingCount > 0) {
    parts.push(
      `${livingCount} rival ${livingCount === 1 ? "cradle remains" : "cradles remain"} in the reproduction race; survival overhead scales with active rivals (reference cohort: ${playerReference}).`
    );
  }

  if (turnNumber > 1) {
    parts.push(
      `Cycle ${turnNumber}: the immortal populations have endured longer, and baseline survival expenses have climbed with the passing epochs.`
    );
  }

  return {
    summary: parts.join(" "),
    resources: MECHANIC_NARRATIVES.survivalExpenses.resources
  };
}

module.exports = {
  NARRATIVE_VERSION,
  GAME_LORE,
  MECHANIC_NARRATIVES,
  getGameNarrative,
  buildSurvivalNarrative
};
