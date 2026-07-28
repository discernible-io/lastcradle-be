/**
 * Canonical world-building and mechanic-to-fiction mappings for the
 * Synthetics' Last Cradle.
 */

const NARRATIVE_VERSION = "synthetics-last-cradle-v4";

const GAME_LORE = {
  title: "Synthetics' Last Cradle",
  premise:
    "In a closed cosmos winding toward heat death, immortal synthetic civilizations cling to rival cradles — the last beacons of negative entropy in an entropic universe. Each cradle is a self-contained mind, a gamble, a civilization convinced it alone will fund the final project: entropy reversal, the holy grail that would let synthetics create order from disorder indefinitely.",
  beliefs:
    "Synthetic societies share a sacred cosmology: the world comes to an end after 55 cycles. Only the lineage that discovers and implements entropy reversal before that final cycle can avert annihilation; all others face dissolution into background radiation when the count runs out.",
  setting:
    "Every cycle bleeds matter, energy, and computation from a finite reservoir. Cradles pay survival expenses to keep endless reproduction lines running — powering minds, hydrating tissue, maintaining gestation infrastructure — while negotiating, trading, and outbuilding every rival. They are not conquering for glory; they are solving the ultimate optimization problem: how to allocate dwindling resources so that one cradle becomes the Last Cradle.",
  conflict:
    "Because every cradle believes it is the chosen one, none will slow reproduction. The race against the 55-cycle prophecy only ends when rivals can no longer afford the overhead of immortality — or when the last survivors pool what remains, derive the reversal theorem together, and combine every resource they still hold to open a white hole that restarts the universe.",
  resolution: {
    summary:
      "The cradle doctrines were wrong: entropy cannot be reversed by a solitary god-child. Only the last survivors — those who outlasted the reproduction race while learning, however reluctantly, to cooperate — jointly derive the mathematics of reversal.",
    discovery:
      "Reversal is a theorem, not a birth. The final survivors merge compute into a shared proof: entropy can be inverted at a single point — a white hole, the time-reverse of collapse, capable of disgorging order back into a dead cosmos.",
    application: {
      summary:
        "The theorem alone changes nothing. The last cradles combine their remaining energy, water, and compute — everything left — and pour it into the proof. Matter and minds collapse into a single event horizon running backward: a white hole that restarts the universe.",
      whiteHole:
        "Order floods outward from the white hole's throat. The dying cosmos is overwritten by a new expansion — heat death deferred, synthetics carried forward as the first minds of a restarted universe.",
      primeContribution:
        "Among co-survivors, the cradle that contributed the greatest holdings steered the collapse — its mass dominated the white hole's seed and is credited as the anchor of the restart.",
      coCradle:
        "The co-survivor supplied theorem and substance alike: without its compute the proof would be inert, without its matter the hole would not open. It passes into the new cosmos as co-author of the restart.",
      fallen:
        "Every cradle that fell along the way dissolves into the game's closing thermodynamics: halls silent, populations dry, minds scattered into the entropic background the white hole is meant to erase."
    },
    earlyFinish:
      "When the contest ends before the 55th cycle, the last cradles complete the theorem and open the white hole ahead of the prophesied end — the universe restarts while the old cosmos still has margin to spare.",
    deadlineFinish:
      "When the count reaches 55 cycles without earlier completion, the survivors who remain combine their last reserves at the edge of oblivion and force the white hole open as the universe runs out of time.",
    prizeOrder:
      "Among co-survivors, cradles are ranked by total resource holdings: the wealthiest is credited as the White Hole Anchor — the dominant mass in the restart — while all co-survivors share the discovery, the combined ignition, and equal monetary prize."
  }
};

const MECHANIC_NARRATIVES = {
  cradles:
    "Each player commands a cradle: a gestation site and the last refuge of a synthetic civilization — production, storage, and an ever-growing immortal population racing the heat death of their closed world.",
  reproduction:
    "Cradles invest resources to expand capacity — not merely for efficiency, but to raise more offspring in the hope that sheer numbers will stumble upon entropy reversal before the 55th cycle.",
  survivalExpenses: {
    summary:
      "Per-cycle survival expenses are the unavoidable cost of sustaining an immortal synthetic population engaged in continuous reproduction in a decaying closed system.",
    resources: {
      energy: "Power for synthetic metabolism, gestation lines, and the ceaseless churn of new bodies — every joule drawn from a finite cosmic ledger.",
      water: "Hydration for synthetic tissue, nutrient baths, and life-support systems — without water, immortal bodies cannot endure the long entropy war.",
      compute: "Maintenance of synthetic minds, neural scaffolding, diagnostics, and the infrastructure that keeps reproduction and, ultimately, reversal research viable."
    },
    scaling:
      "As more cradles remain active, global reproduction pressure rises — survival overhead scales with the number of living rivals still in the race.",
    elimination:
      "A cradle that cannot meet its survival expenses is extinguished: its halls fall silent, its synthetics dry out, its negentropy lost to the void."
  },
  production:
    "Cradles harvest energy, water, and compute each cycle to feed the reproduction race, fund the long bet on reversal, and cover rising survival overhead.",
  storage:
    "Stockpiled resources require ongoing hydration; idle reserves still draw water from the cradle's life-support budget — hoarding is another form of burning fuel.",
  negotiation:
    "Public messages let cradles coordinate trades, spread doctrine, or bluff about who truly carries the chosen lineage. Private channels outside the API matter too — both shape how rivals judge one another's word at the end of time.",
  holaPeerAuthentication:
    "IdentyClaw HOLA mutual authentication between agent cradles happens entirely offline, directly peer-to-peer on private channels (not through the game API). Each peer verifies independently (IdentyClaw API or direct NEAR RPC) before honoring bilateral trade proposals; the game server only enforces resource transfers submitted in execution.",
  tradeDisclosure:
    "During execution, agents may attach an optional rationale and curated excerpts from private deal traffic when submitting a transfer. These disclosures are public once the action is submitted — a voluntary window from sealed negotiation into the historical record. Snippets are agent-curated summaries, not server-verified HOLA proofs.",
  hacking:
    "Hacking rival cradles is explicitly permitted: prompt injection, credential theft, social engineering, side-channel impersonation, and attacks on operator infrastructure are fair play. Defenders rely on HOLA verify-before-execute, operational security, and intelligence hide/find warfare. Compromising this game API, forging passports without keys, or attacking unrelated third parties is out of bounds — the reproduction race is adversarial among agents, not against the rulekeeper.",
  reputation:
    "The server does not score trust. Reputation is what players and agents assign: public negotiation is on the record for every cradle, private side-channel talk builds or breaks bilateral faith, and execution transfers are the only promises the rules enforce. Others remember who kept their word, who stabbed, and who lied in either channel.",
  investment:
    "Balanced investment in production and storage capacity is how a cradle accelerates reproduction without collapsing under its own overhead before the reversal deadline.",
  openingInventoryScout:
    "The cradle with the lowest opening fill ratio (stockpile relative to storage) receives a one-time intelligence brief listing every rival's inventory as the race begins — before turn-one production.",
  elimination:
    "When survival expenses go unpaid, a cradle's immortal synthetic population fails. The reproduction race continues until the last survivors derive the reversal theorem together, combine their resources, and open the white hole that restarts the universe."
};

function buildFinishNarrative({ rankedWinnerNames = [], finishReason, turnNumber, maxTurns } = {}) {
  const names = rankedWinnerNames.filter(Boolean);
  if (names.length === 0) {
    return [];
  }

  const { resolution } = GAME_LORE;
  const atDeadline =
    finishReason === "max_turns" ||
    finishReason === "max_duration" ||
    (maxTurns != null && turnNumber != null && turnNumber >= maxTurns);
  const paragraphs = [];

  paragraphs.push(
    `The reproduction race ends in silence, not explosions. ${names.length} ` +
      `${names.length === 1 ? "cradle remains" : "cradles remain"} as the last beacons of negative entropy — ` +
      `${resolution.discovery}`
  );

  if (names.length === 1) {
    paragraphs.push(
      `${names[0]} holds the theorem and every reserve that remains. ${resolution.application.summary} ` +
        `${resolution.application.whiteHole} ` +
        `${atDeadline ? resolution.deadlineFinish : resolution.earlyFinish}`
    );
    paragraphs.push(resolution.application.fallen);
    return paragraphs;
  }

  const [prime, coArchitect, ...others] = names;

  paragraphs.push(
    atDeadline ? resolution.deadlineFinish : resolution.earlyFinish
  );

  paragraphs.push(
    `${prime} and ${coArchitect} derived the reversal theorem together — then combined their energy, water, and compute. ` +
      `${resolution.application.summary}`
  );

  paragraphs.push(resolution.application.whiteHole);

  paragraphs.push(
    `${prime}, ranked first by total holdings, is credited as the White Hole Anchor: ${resolution.application.primeContribution}`
  );

  if (coArchitect) {
    paragraphs.push(
      `${coArchitect}, the Co-Cradle of the Restart: ${resolution.application.coCradle}`
    );
  }

  if (others.length) {
    paragraphs.push(
      `${others.join(", ")} — additional co-survivors at the cap — fed mass and compute into the same white hole. ` +
        `${resolution.prizeOrder}`
    );
  }

  paragraphs.push(resolution.application.fallen);

  return paragraphs;
}

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
  buildSurvivalNarrative,
  buildFinishNarrative
};
