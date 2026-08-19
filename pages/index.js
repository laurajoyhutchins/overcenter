export const access = 'admin';
export const methods = ['GET'];

export default async function (_req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(`
    <main class="shell" aria-labelledby="page-title">
      <header class="masthead">
        <div>
          <p class="eyebrow">PORTFOLIO CONTROL PLANE</p>
          <h1 id="page-title">Coordination kernel health</h1>
          <p class="lede">Read-only operational evidence for runs, leases, command journaling, and mechanical external-effect reconciliation. Portfolio truth remains in Linear, GitHub, and retained source authority.</p>
        </div>
        <div class="masthead-actions">
          <div class="health" id="health" aria-live="polite">Loading orchestration health…</div>
          <button id="refresh" type="button">Refresh</button>
        </div>
      </header>

      <section class="metrics" aria-label="Kernel summary" id="metrics"></section>

      <div class="columns">
        <section aria-labelledby="conditions-heading">
          <div class="section-heading"><div><p class="eyebrow">RECOVERY</p><h2 id="conditions-heading">Stranded conditions</h2></div></div>
          <div id="conditions" class="stack" aria-live="polite"></div>
        </section>
        <section aria-labelledby="errors-heading">
          <div class="section-heading"><div><p class="eyebrow">SIGNALS</p><h2 id="errors-heading">Recent error codes</h2></div></div>
          <div id="errors" class="stack" aria-live="polite"></div>
        </section>
      </div>

      <section aria-labelledby="commands-heading">
        <div class="section-heading"><div><p class="eyebrow">TRAFFIC</p><h2 id="commands-heading">Recent command outcomes</h2></div></div>
        <div id="commands" class="entity-grid" aria-live="polite"></div>
      </section>

      <footer><span>Read-only current-kernel diagnostic</span><span id="updated">Not refreshed</span></footer>
    </main>
    <link rel="stylesheet" href="/dashboard.css">
    <script src="/dashboard.js" defer></script>
  `);
}