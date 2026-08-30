export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(`
    <main class="shell" aria-labelledby="page-title">
      <header class="masthead">
        <div>
          <p class="eyebrow">OVERCENTER · OPERATOR STATUS</p>
          <h1 id="page-title">Project transitions</h1>
          <p class="lede">Live read-only projection of the authoritative repository-owned project graph. Transition state and lifecycle come first; runs, leases, journals, and recovery remain kernel diagnostics rather than project authority.</p>
        </div>
        <div class="masthead-actions">
          <div class="health" id="health" aria-live="polite">Loading orchestration health…</div>
          <button id="refresh" type="button">Refresh</button>
        </div>
      </header>

      <section class="diagram-section" aria-labelledby="execution-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">AUTHORITATIVE GRAPH</p>
            <h2 id="execution-heading">Project transitions and dependencies</h2>
          </div>
          <div id="window" class="window-note">Observed window: loading…</div>
        </div>
        <div id="execution-path" class="execution-diagram" aria-live="polite"></div>
      </section>

      <section class="evidence-section" aria-labelledby="exceptions-heading">
        <div class="section-heading">
          <div>
            <p class="eyebrow">KERNEL DIAGNOSTICS</p>
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

      <footer><span>Read-only graph projection and kernel diagnostics</span><span id="updated">Not refreshed</span></footer>
    </main>
    <link rel="stylesheet" href="/dashboard.css">
    <script src="/dashboard.js" defer></script>
  `);
}