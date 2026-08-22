export const access = 'public';
export const methods = ['GET'];

export default async function (_req, res) {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  return res.send(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Portfolio Control Plane GitHub App</title>
  <meta name="description" content="GitHub App implementing the Portfolio Control Plane, deployed on Hatchable.">
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0b1110;
      color: #edf7f3;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 28px;
      background: #0b1110;
    }
    main {
      width: min(100%, 520px);
      padding: 34px 32px 30px;
      text-align: center;
      background: #121a18;
      border: 1px solid #28453e;
      border-radius: 18px;
      box-shadow: 0 18px 50px rgba(0, 0, 0, .28);
    }
    h1 {
      margin: 0 0 10px;
      font-size: clamp(1.45rem, 4vw, 1.85rem);
      line-height: 1.1;
      letter-spacing: -.025em;
    }
    p {
      margin: 0 auto 22px;
      max-width: 36ch;
      color: #9eb5ae;
      font-size: .95rem;
      line-height: 1.5;
    }
    a {
      display: inline-block;
      padding: 10px 15px;
      border: 1px solid #3f6d61;
      border-radius: 10px;
      color: #b7eadc;
      font-size: .88rem;
      font-weight: 650;
      text-decoration: none;
      background: #17241f;
    }
    a:focus-visible {
      outline: 2px solid #8ce0c8;
      outline-offset: 3px;
    }
  </style>
</head>
<body>
  <main>
    <h1>Portfolio Control Plane GitHub App</h1>
    <p>v191</p>
    <a href="/dashboard">Open dashboard</a>
  </main>
</body>
</html>`);
}