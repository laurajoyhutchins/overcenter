export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(`
    <main class="shell" aria-labelledby="page-title">
      <header class="masthead">
        <div>
          <p class="eyebrow">PORTFOLIO CONTROL PLANE</p>
          <h1 id="page-title">Repository state without the issue-tracker fog</h1>
          <p class="lede">LORE establishes truth. Deciduous preserves the path. Factory Floor executes. This view reconciles what may happen next.</p>
        </div>
        <div class="health" id="health" aria-live="polite">Loading control-plane state…</div>
      </header>

      <section class="metrics" aria-label="Control-plane summary" id="metrics"></section>

      <section class="focus" aria-labelledby="eligible-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">NEXT</p>
            <h2 id="eligible-heading">Eligible work</h2>
          </div>
          <button id="refresh" type="button">Refresh state</button>
        </div>
        <div id="next-work" class="empty" aria-live="polite">Evaluating readiness…</div>
      </section>

      <div class="columns">
        <section aria-labelledby="blocked-heading">
          <div class="section-heading">
            <div>
              <p class="eyebrow">FRICTION</p>
              <h2 id="blocked-heading">Blocked work</h2>
            </div>
          </div>
          <div id="blocked-work" class="stack" aria-live="polite"></div>
        </section>

        <section aria-labelledby="owner-heading">
          <div class="section-heading">
            <div>
              <p class="eyebrow">AUTHORITY</p>
              <h2 id="owner-heading">Owner decisions</h2>
            </div>
          </div>
          <div id="owner-decisions" class="stack" aria-live="polite"></div>
        </section>
      </div>

      <section aria-labelledby="source-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">EVIDENCE</p>
            <h2 id="source-heading">Source state</h2>
          </div>
          <label class="filter">Filter <input id="filter" type="search" placeholder="repository, finding, route…"></label>
        </div>
        <div id="entities" class="entity-grid" aria-live="polite"></div>
      </section>

      <footer>
        <span>Read-only projection</span>
        <span id="updated">Not refreshed</span>
      </footer>
    </main>
    <link rel="stylesheet" href="/dashboard.css">
    <script src="/dashboard.js" defer></script>
  `);
}