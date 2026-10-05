import crypto from "node:crypto";

const targets = [{"branch":"probe/gcp-wif-arcata-branch-admin","sha":"2a35305bb9aa730cba0218c81ab9d8a80ad2cfad","kind":"ancestor"},{"branch":"transport/arcata-pr58-verify","sha":"2a35305bb9aa730cba0218c81ab9d8a80ad2cfad","kind":"ancestor"},{"branch":"transport/arcata-pr68-source","sha":"2a35305bb9aa730cba0218c81ab9d8a80ad2cfad","kind":"ancestor"},{"branch":"transport/arcata-python-compat-runtimes","sha":"2a35305bb9aa730cba0218c81ab9d8a80ad2cfad","kind":"ancestor"},{"branch":"scratch/formal-runtime-verify","sha":"6c5c1dc5365e4714655edfeaf97cbc1c4cc47fbb","kind":"ancestor"},{"branch":"scratch/formal-toolchain-bootstrap","sha":"6c5c1dc5365e4714655edfeaf97cbc1c4cc47fbb","kind":"ancestor"},{"branch":"scratch/four-by-four-source-courier","sha":"f3e6338a5758e54eb52c5a0b74dde4c791320b26","kind":"ancestor"},{"branch":"codex/transaction-planner-114f82d","sha":"114f82d2ac42517d70956bcd9a6d6445b08fa906","kind":"ancestor"},{"branch":"codex/transaction-planner-current","sha":"6268f133e002c12abab3a31d65c8e34f554e2c60","kind":"ancestor"},{"branch":"codex/transaction-planner-exact","sha":"42af155fd1e9dafba42f309d05a835f92d408735","kind":"ancestor"},{"branch":"codex/wire-transaction-admission-114f82d","sha":"114f82d2ac42517d70956bcd9a6d6445b08fa906","kind":"ancestor"},{"branch":"codex/wire-transaction-admission-current","sha":"6268f133e002c12abab3a31d65c8e34f554e2c60","kind":"ancestor"},{"branch":"codex/wire-transaction-admission-exact","sha":"42af155fd1e9dafba42f309d05a835f92d408735","kind":"ancestor"},{"branch":"codex/wire-transaction-admission-4c6f3a2","sha":"4c6f3a2bf13a4c2127e20f19a75f26de9134c243","kind":"ancestor"},{"branch":"codex/wire-transaction-admission-6f94f3b","sha":"6f94f3bda07e1d2d92af11563e7371c58027b046","kind":"ancestor"},{"branch":"self-apply/clarify-semantic-scaling-promotion","sha":"6f94f3bda07e1d2d92af11563e7371c58027b046","kind":"ancestor"},{"branch":"self-apply/clarify-scaling-followons","sha":"d015ec6c77ce743cc416a864e1ea3bccb893d41d","kind":"ancestor"},{"branch":"self-apply/update-scaling-followons","sha":"8f60d6bcd29b4e2d157c57eac1799fae530b72cf","kind":"ancestor"},{"branch":"self-apply/clarify-promotion-boundary","sha":"7cbd8bf6619d2cbb4f3991111cc970e69cc1a6b7","kind":"ancestor"},{"branch":"self-apply/semantic-packet-key-order","sha":"86df306f0fbaf9290bb3390a801e616a8237ae58","kind":"ancestor"},{"branch":"self-apply/run-semantic-identity-hostile","sha":"8ff48188ed5d79cb9ea48c9c4183217a44430ac0","kind":"ancestor"},{"branch":"overcenter/candidate/tool-capsule-contract","sha":"65f48d638f2ceb5518e0067120174b636df40202","kind":"ancestor"},{"branch":"mvp/bounded-source-write-envelope","sha":"7f34038f5feb9b0a64aeb29664750eb691dc7843","kind":"superseded","pr":511,"replacement":590},{"branch":"cleanup/current-main-formal-convergence","sha":"294c723d02f4a786e2578ca4938aac4718d79441","kind":"superseded","pr":561,"replacement":562},{"branch":"refactor/structural-effect-wrapper-proof","sha":"1bf0480ebedb892048858f7678e347c9395e7f33","kind":"superseded","pr":554,"replacement":562},{"branch":"spike/mcp-northbound-4x4","sha":"3a246c04667e1bb3cdf287d4800256d149216dc7","kind":"superseded","pr":560,"replacement":564},{"branch":"post-4x4/08-delete-agent-orchestration","sha":"dd2638e59ba2b95e63756ba139488d0fbbb7f982","kind":"superseded","pr":559,"replacement":574},{"branch":"experiment/delete-admission-source-token-refinement","sha":"80dc9165d05e963777297c86f24083af06d12f11","kind":"superseded","pr":533,"replacement":534},{"branch":"cleanup/remove-revision-source-broker","sha":"c1264d1d91afce1537b3042b56686f22540a9085","kind":"superseded","pr":478,"replacement":481},{"branch":"cleanup/source-broker-single-ingress","sha":"18deb219e41dd2b9e856c19ac4640bf2c1f9e3e8","kind":"superseded","pr":480,"replacement":481},{"branch":"cleanup/remove-revision-source-broker-current","sha":"b0189314c38e410bfa8b8a101e2c773fdcdb597c","kind":"superseded","pr":482,"replacement":481},{"branch":"codex/repository-transactions","sha":"e9e61c2d3793b01cb8eb9e7554c64586220c9125","kind":"superseded","pr":468,"replacement":492},{"branch":"cleanup/delete-4x4-source-contract","sha":"209e330c291cca46830c28bcf516c2bfdbd571ef","kind":"superseded","pr":541,"replacement":565},{"branch":"cleanup/narrow-4x4-source-contract-to-release","sha":"e92baf6d343a616cfcb36ad6a6b9ea1def58d0e7","kind":"superseded","pr":538,"replacement":565},{"branch":"codex/tool-capsule-transport","sha":"b3374fe9bccec6ec207c2a603e00725d5e74f9d2","kind":"superseded","pr":589,"replacement":592},{"branch":"bootstrap/arcata-python-quality-tools","sha":"73b80973e5c29f937c8a8e5492b212cb8aa1389d","kind":"disposable","pr":588},{"branch":"overcenter/candidate/tool-capsule-589","sha":"a3c9b0850a198aa708f181ea2df3fcd32eec9083","kind":"tree_equal","other":"86fbaaa9df18c39f8f9789a647c73dcc49baa3c1"},{"branch":"overcenter/candidate/589","sha":"fc9cc6bf0b75fd4b789c54729040b5cd4b93918d","kind":"ancestor_of","other":"b3374fe9bccec6ec207c2a603e00725d5e74f9d2"},{"branch":"overcenter/core-demo/37098602622-1/clean","sha":"ae47fac83d0029b7bdda66474c2a2acfee499334","kind":"alias_pr_head","pr":570}];

const repoName = process.env.TARGET_REPOSITORY;
const b64 = value => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const unsigned = b64({alg:"RS256",typ:"JWT"}) + "." +
  b64({iat:now-60,exp:now+540,iss:process.env.GITHUB_APP_ID});
const appJwt = unsigned + "." +
  crypto.sign("RSA-SHA256", Buffer.from(unsigned), process.env.GITHUB_APP_PRIVATE_KEY)
    .toString("base64url");

const baseHeaders = {
  Accept:"application/vnd.github+json",
  "X-GitHub-Api-Version":"2022-11-28",
  "User-Agent":"overcenter-gcp-lineage-cleanup",
};
const headers = token => ({...baseHeaders,Authorization:"Bearer " + token});
const enc = branch => branch.split("/").map(encodeURIComponent).join("/");

async function parse(response) {
  const text = await response.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}
async function req(url, init, label, allowed=[]) {
  const response = await fetch(url, init);
  const payload = await parse(response);
  if (!response.ok && !allowed.includes(response.status)) {
    throw new Error(label + " HTTP " + response.status + ": " +
      String(typeof payload === "string" ? payload : JSON.stringify(payload)).slice(0,500));
  }
  return {response,payload};
}
async function commitTree(token, ref) {
  return (await req(
    "https://api.github.com/repos/" + repoName + "/commits/" + ref,
    {headers:headers(token)}, "commit " + ref
  )).payload.commit.tree.sha;
}

async function main() {
  if (targets.length !== 39) throw new Error("expected 39 targets");
  if (new Set(targets.map(x => x.branch)).size !== targets.length) throw new Error("duplicate targets");

  const installation = (await req(
    "https://api.github.com/repos/" + repoName + "/installation",
    {headers:headers(appJwt)}, "installation lookup"
  )).payload;
  const access = (await req(
    "https://api.github.com/app/installations/" + installation.id + "/access_tokens",
    {
      method:"POST",
      headers:{...headers(appJwt),"Content-Type":"application/json"},
      body:JSON.stringify({permissions:{administration:"write",contents:"write",pull_requests:"read"}}),
    },
    "installation token"
  )).payload;
  const token = access.token;

  const repository = (await req(
    "https://api.github.com/repos/" + repoName,
    {headers:headers(token)}, "repository identity"
  )).payload;
  if (String(repository.id) !== process.env.EXPECTED_REPOSITORY_ID ||
      String(repository.owner?.id) !== process.env.EXPECTED_OWNER_ID ||
      repository.full_name !== repoName) {
    throw new Error("repository identity mismatch");
  }

  const openHeads = new Set();
  const openBases = new Set();
  for (let page=1;;page++) {
    const prs = (await req(
      "https://api.github.com/repos/" + repoName + "/pulls?state=open&per_page=100&page=" + page,
      {headers:headers(token)}, "open PR inventory"
    )).payload;
    for (const pr of prs) {
      if (pr.head?.repo?.full_name === repoName) openHeads.add(pr.head.ref);
      if (pr.base?.repo?.full_name === repoName) openBases.add(pr.base.ref);
    }
    if (prs.length < 100) break;
  }

  for (const t of targets) {
    if (t.branch === repository.default_branch || openHeads.has(t.branch) || openBases.has(t.branch)) {
      throw new Error("active/default branch protected: " + t.branch);
    }
    const ref = (await req(
      "https://api.github.com/repos/" + repoName + "/git/ref/heads/" + enc(t.branch),
      {headers:headers(token)}, "ref " + t.branch
    )).payload;
    if (ref.object.sha !== t.sha) throw new Error("exact-head fence failed for " + t.branch);

    if (t.kind === "ancestor") {
      const cmp = (await req(
        "https://api.github.com/repos/" + repoName + "/compare/main..." + enc(t.branch),
        {headers:headers(token)}, "ancestor proof " + t.branch
      )).payload;
      if (cmp.ahead_by !== 0) throw new Error("not contained by main: " + t.branch);
    } else if (t.kind === "superseded") {
      const oldPr = (await req(
        "https://api.github.com/repos/" + repoName + "/pulls/" + t.pr,
        {headers:headers(token)}, "old PR #" + t.pr
      )).payload;
      if (oldPr.state !== "closed" || oldPr.merged ||
          oldPr.head.ref !== t.branch || oldPr.head.sha !== t.sha) {
        throw new Error("superseded PR fence failed #" + t.pr);
      }
      const replacement = (await req(
        "https://api.github.com/repos/" + repoName + "/pulls/" + t.replacement,
        {headers:headers(token)}, "replacement PR #" + t.replacement
      )).payload;
      if (!(replacement.merged || replacement.state === "open")) {
        throw new Error("replacement not live/merged #" + t.replacement);
      }
    } else if (t.kind === "disposable") {
      const pr = (await req(
        "https://api.github.com/repos/" + repoName + "/pulls/" + t.pr,
        {headers:headers(token)}, "disposable PR #" + t.pr
      )).payload;
      if (pr.state !== "closed" || pr.merged || pr.head.ref !== t.branch ||
          pr.head.sha !== t.sha || !/Disposable bootstrap only/.test(pr.body || "")) {
        throw new Error("disposable PR fence failed #" + t.pr);
      }
    } else if (t.kind === "tree_equal") {
      if (await commitTree(token, t.sha) !== await commitTree(token, t.other)) {
        throw new Error("tree equivalence failed: " + t.branch);
      }
    } else if (t.kind === "ancestor_of") {
      const cmp = (await req(
        "https://api.github.com/repos/" + repoName + "/compare/" + t.sha + "..." + t.other,
        {headers:headers(token)}, "replacement ancestry " + t.branch
      )).payload;
      if (cmp.behind_by !== 0) throw new Error("candidate not ancestor: " + t.branch);
    } else if (t.kind === "alias_pr_head") {
      const pr = (await req(
        "https://api.github.com/repos/" + repoName + "/pulls/" + t.pr,
        {headers:headers(token)}, "alias PR #" + t.pr
      )).payload;
      if (pr.state !== "open" || pr.head.sha !== t.sha || pr.head.ref === t.branch) {
        throw new Error("open-head alias fence failed: " + t.branch);
      }
    } else {
      throw new Error("unknown target kind");
    }
  }

  console.log("preflight complete:", targets.length);
  for (const t of targets) {
    await req(
      "https://api.github.com/repos/" + repoName + "/git/refs/heads/" + enc(t.branch),
      {method:"DELETE",headers:headers(token)}, "delete " + t.branch
    );
  }
  for (const t of targets) {
    const v = await req(
      "https://api.github.com/repos/" + repoName + "/git/ref/heads/" + enc(t.branch),
      {headers:headers(token)}, "readback " + t.branch, [404]
    );
    if (v.response.status !== 404) throw new Error("branch survived: " + t.branch);
  }
  console.log(JSON.stringify({deleted:targets.length}));
}

main().catch(error => {
  console.error(String(error?.stack || error));
  process.exit(1);
});
