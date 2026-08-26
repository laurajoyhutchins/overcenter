export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(`
    <main class="shell" aria-labelledby="page-title">
      <header class="masthead">
        <div>
          <p class="eyebrow">OVERCENTER · OPERATOR STATUS</p>
          <h1 id="page-title">Execution path</h1>
          <p class="lede">Live read-only evidence from the orchestration kernel. Nodes show stranded state now; labeled connections show command outcomes observed in the last 24 hours. The diagram is a projection of Overcenter state, not a second authority.</p>
        </div>
        <div class="masthead-actions">
          <div class="health" id="health" aria-live="polite">Loading orchestration health…</div>
          <button id="refresh" type="button">Refresh</button>
        </div>
      </header>

      <section class="diagram-section" aria-labelledby="execution-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">CONTROL PATH</p>
            <h2 id="execution-heading">Run → claim → work → effects → settle → finish</h2>
          </div>
          <div id="window" class="window-note">Observed window: loading…</div>
        </div>
        <div id="execution-path" class="execution-diagram" aria-live="polite"></div>
      </section>

      <section class="evidence-section" aria-labelledby="exceptions-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">CURRENT EXCEPTIONS</p>
            <h2 id="exceptions-heading">Exact stranded evidence</h2>
          </div>
        </div>
        <div id="exceptions" class="evidence-list" aria-live="polite"></div>
      </section>

      <section class="signals-section" aria-labelledby="signals-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">RECENT SIGNALS</p>
            <h2 id="signals-heading">Rejected and failed command evidence</h2>
          </div>
        </div>
        <div class="signal-columns">
          <div>
            <h3>Expected rejections</h3>
            <div id="rejections" class="signal-list" aria-live="polite"></div>
          </div>
          <div>
            <h3>Error codes</h3>
            <div id="errors" class="signal-list" aria-live="polite"></div>
          </div>
        </div>
      </section>

      <footer><span>Read-only current-kernel diagnostic</span><span id="updated">Not refreshed</span></footer>
    </main>
    <link rel="stylesheet" href="/dashboard.css">
    <script src="/dashboard.js" defer></script>
  `);
}
