import { decideRepositoryCreationApproval, listRepositoryCreationApprovals } from 'lib/github-repository-approval.js';

export const access = 'admin';
export const methods = ['GET', 'POST'];

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}

function fmt(value) {
  try { return new Date(value).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }); }
  catch { return String(value || ''); }
}

function page(rows, message = '') {
  const cards = rows.length ? rows.map((row) => `
    <article class="card ${row.state === 'approved' ? 'approved' : ''}" id="approval-${esc(row.approval_id)}">
      <div class="state">${esc(row.state.toUpperCase())}</div>
      <h2>${esc(row.repo)}</h2>
      <p class="description">${row.description ? esc(row.description) : '<span class="muted">No description</span>'}</p>
      <dl><div><dt>Requested</dt><dd>${esc(fmt(row.requested_at))}</dd></div><div><dt>Expires</dt><dd>${esc(fmt(row.expires_at))}</dd></div></dl>
      ${row.state === 'pending' ? `<form method="post" class="actions">
        <input type="hidden" name="approval_id" value="${esc(row.approval_id)}">
        <button class="approve" type="submit" name="decision" value="approve">Approve creation</button>
        <button class="reject" type="submit" name="decision" value="reject">Reject</button>
      </form>` : '<p class="approved-note">Approved. The requesting tool may now create this exact repository once.</p>'}
    </article>`).join('') : '<div class="empty">No repository creations are awaiting approval.</div>';
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Repository approvals</title><style>
    :root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#17221f;background:#f4f8f6}*{box-sizing:border-box}body{margin:0}.shell{width:min(760px,100%);margin:auto;padding:28px 18px 56px}header{margin-bottom:24px}.eyebrow{font-size:12px;letter-spacing:.12em;font-weight:700;color:#315f55;margin:0 0 8px}h1{font-size:clamp(28px,7vw,42px);line-height:1.05;margin:0 0 10px}.lede{color:#53645f;line-height:1.5;margin:0}.notice{padding:12px 14px;border:1px solid #b8ccc5;border-radius:12px;background:#fff;margin:0 0 16px}.stack{display:grid;gap:14px}.card{background:#fff;border:1px solid #cfddd8;border-radius:18px;padding:18px;box-shadow:0 8px 30px rgba(20,50,42,.05)}.card.approved{border-color:#79a697}.state{font-size:11px;letter-spacing:.11em;font-weight:800;color:#55746a}.card h2{font-size:20px;margin:6px 0 8px;overflow-wrap:anywhere}.description{line-height:1.45;margin:0 0 16px}.muted{color:#7d8d88}dl{margin:0 0 18px;display:grid;grid-template-columns:1fr 1fr;gap:10px}dl div{min-width:0}dt{font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#75857f}dd{margin:3px 0 0;font-size:13px}.actions{display:grid;grid-template-columns:1fr auto;gap:10px}button{min-height:48px;border-radius:12px;border:0;font:inherit;font-weight:700;padding:0 18px;cursor:pointer}.approve{background:#173f36;color:#fff}.reject{background:#edf2f0;color:#354b45}.approved-note{margin:0;padding:12px;background:#edf6f2;border-radius:10px;color:#31584d}.empty{background:#fff;border:1px dashed #b8c9c3;border-radius:16px;padding:24px;color:#65756f;text-align:center}@media(max-width:520px){dl{grid-template-columns:1fr}.actions{grid-template-columns:1fr}button{width:100%}}
  </style></head><body><main class="shell"><header><p class="eyebrow">PORTFOLIO CONTROL PLANE</p><h1>Repository creation approvals</h1><p class="lede">A repository is created only after you approve its exact name and description here. Approval expires after 30 minutes and is consumed after successful creation.</p></header>${message ? `<div class="notice">${esc(message)}</div>` : ''}<section class="stack">${cards}</section></main></body></html>`;
}

export default async function (req, res) {
  let message = '';
  if (req.method === 'POST') {
    const result = await decideRepositoryCreationApproval(req.body?.approval_id, req.body?.decision);
    message = result.ok ? `${result.approval.repo} was ${result.approval.state}.` : `Approval was not changed (${result.error}).`;
  }
  const rows = await listRepositoryCreationApprovals();
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(page(rows, message));
}