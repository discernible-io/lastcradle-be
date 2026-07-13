const REPORT_URL = "data/latest-report.json";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formatDate(iso) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short"
    });
  } catch {
    return iso;
  }
}

function renderMeta(report) {
  const meta = document.getElementById("game-meta");
  meta.replaceChildren();
  const entries = [
    ["Game ID", report.game.id],
    ["Players", String(report.game.playerCount)],
    ["Cycles played", String(report.game.totalTurns)],
    ["Status", report.game.status],
    ["Trade target / cycle", String(report.game.tradeTargetPerTurn)],
    ["Generated", formatDate(report.generatedAt)]
  ];
  for (const [label, value] of entries) {
    const dt = el("dt", null, label);
    const dd = el("dd", null, value);
    meta.append(dt, dd);
  }
}

function renderRoster(report) {
  const roster = document.getElementById("roster");
  roster.replaceChildren();
  for (const entry of report.roster) {
    const li = el("li");
    li.append(el("span", null, entry.displayName), el("span", "role", entry.role));
    roster.append(li);
  }
}

function renderTurnNav(report) {
  const nav = document.getElementById("turn-nav");
  nav.replaceChildren();
  for (const turn of report.turns) {
    const link = el("a", null, String(turn.turnNumber));
    link.href = `#cycle-${turn.turnNumber}`;
    nav.append(link);
  }
}

function renderIntro(report) {
  const intro = document.getElementById("intro");
  intro.replaceChildren(
    el("h2", null, report.lore.title),
    el("p", null, report.lore.premise),
    el("p", null, report.lore.setting)
  );
}

function renderPost(turn) {
  const article = el("article", "post card");
  article.id = `cycle-${turn.turnNumber}`;

  const heading = el("h2", null, turn.headline);
  const meta = el("div", "post-meta");
  meta.append(
    el("span", "stat-pill", `${turn.stats.livingCount} cradles active`),
    el("span", "stat-pill", `${turn.stats.messageCount} public dispatches`),
    el("span", "stat-pill", `${turn.stats.transferCount} trades`)
  );
  if (turn.stats.eliminated.length) {
    meta.append(
      el(
        "span",
        "stat-pill eliminated",
        `${turn.stats.eliminated.length} eliminated`
      )
    );
  }

  article.append(heading, meta);

  for (const paragraph of turn.narrative) {
    article.append(el("p", null, paragraph));
  }

  if (turn.negotiationHighlights?.length) {
    const box = el("div", "negotiation");
    box.append(el("strong", null, "From the negotiation record"));
    for (const item of turn.negotiationHighlights) {
      const quote = el("blockquote", null, `“${item.body}”`);
      quote.insertAdjacentText("afterbegin", `${item.from}: `);
      box.append(quote);
    }
    article.append(box);
  }

  if (turn.execution?.length) {
    const list = el("ul", "execution-list");
    for (const line of turn.execution.slice(0, 10)) {
      list.append(el("li", null, line));
    }
    article.append(el("strong", null, "Execution ledger"), list);
  }

  return article;
}

function renderFinale(report) {
  const finale = document.getElementById("finale");
  if (!report.summary.survivors.length && !report.summary.fallen.length) {
    finale.classList.add("hidden");
    return;
  }

  finale.classList.remove("hidden");
  finale.replaceChildren(el("h2", null, "Final accounting"));

  if (report.summary.survivors.length) {
    finale.append(
      el(
        "p",
        null,
        `Survivors (${report.summary.survivors.length}): ${report.summary.survivors.join(", ")}.`
      )
    );
  }

  if (report.game.winners?.length) {
    const names = report.game.winners.map((w) => w.displayName).join(", ");
    finale.append(
      el(
        "p",
        null,
        `The reversal theorem and combined reserves opened a white hole — universe restart credited to: ${names}. Holdings rank each cradle's contribution to the anchor mass.`
      )
    );
  }

  if (report.summary.fallen.length) {
    const fallenText = report.summary.fallen
      .map((f) => `${f.displayName} (cycle ${f.diedAtTurn ?? "?"})`)
      .join("; ");
    finale.append(el("p", null, `Fallen cradles: ${fallenText}.`));
  }
}

function renderReport(report) {
  document.getElementById("tagline").textContent =
    `${report.game.playerCount}-cradle contest · ${report.game.totalTurns} cycles · status: ${report.game.status}`;

  renderMeta(report);
  renderRoster(report);
  renderTurnNav(report);
  renderIntro(report);

  const posts = document.getElementById("posts");
  posts.replaceChildren();
  for (const turn of report.turns) {
    posts.append(renderPost(turn));
  }

  renderFinale(report);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const id = entry.target.id.replace("cycle-", "");
        document.querySelectorAll(".turn-nav a").forEach((a) => {
          a.classList.toggle("active", a.textContent === id);
        });
      }
    },
    { rootMargin: "-40% 0px -50% 0px" }
  );

  document.querySelectorAll(".post").forEach((post) => observer.observe(post));
}

function renderError(message) {
  const posts = document.getElementById("posts");
  posts.replaceChildren(el("div", "error-banner", message));
}

async function loadReport() {
  try {
    const response = await fetch(REPORT_URL, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`Could not load report (${response.status})`);
    }
    const report = await response.json();
    renderReport(report);
  } catch (err) {
    renderError(
      `${err.message}. Run: node scripts/generate-blog-report.js 7 finish`
    );
  }
}

loadReport();
