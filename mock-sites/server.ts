/**
 * Three fake document portals with deliberately different navigation shapes.
 * They exist so discovery/replay/heal have something realistic to chew on
 * without hitting a real vendor site.
 *
 * Set BREAK=a (comma-separated site ids) to change a site's UI labels and
 * force a replay failure — that's the heal demo.
 */
import express from "express";
import crypto from "node:crypto";

const PORT = Number(process.env.PORT ?? 4000);
const BROKEN = new Set((process.env.BREAK ?? "").split(",").filter(Boolean));

/** Every portal accepts the same demo credentials. */
const USERS: Record<string, { user: string; pass: string }> = {
  a: { user: "acme-ops", pass: "hunter2" },
  b: { user: "ops@acme.test", pass: "correct-horse" },
  c: { user: "ACME001", pass: "4815" },
};

// ---------------------------------------------------------------- PDF

/** Minimal but genuinely valid single-page PDF, so content sniffing is real. */
function makePdf(title: string): Buffer {
  const text = title.replace(/[()\\]/g, "");
  const content = `BT /F1 18 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]` +
      ` /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const obj of objects) {
    offsets.push(pdf.length);
    pdf += obj;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

function sendPdf(res: express.Response, filename: string, title: string): void {
  const body = makePdf(title);
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.setHeader("Content-Length", String(body.length));
  res.end(body);
}

// ------------------------------------------------------------ sessions

const sessions = new Map<string, string>(); // sid -> site id

function sidOf(req: express.Request): string | undefined {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === "sid" && v) return v;
  }
  return undefined;
}

function authed(req: express.Request, site: string): boolean {
  const sid = sidOf(req);
  return sid !== undefined && sessions.get(sid) === site;
}

function login(res: express.Response, site: string): void {
  const sid = crypto.randomBytes(12).toString("hex");
  sessions.set(sid, site);
  res.setHeader("Set-Cookie", `sid=${sid}; Path=/; HttpOnly`);
}

// ---------------------------------------------------------------- HTML

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f6f7f9;color:#1a1d21}
header{background:#243b53;color:#fff;padding:14px 28px;font-weight:600}
main{max-width:720px;margin:32px auto;background:#fff;padding:28px;
     border:1px solid #dde3ea;border-radius:8px}
label{display:block;margin:14px 0 4px;font-weight:600;font-size:14px}
input,select{padding:8px 10px;border:1px solid #c3ccd6;border-radius:5px;
             font-size:15px;min-width:260px}
button,a.btn{display:inline-block;margin-top:18px;padding:9px 16px;background:#2b6cb0;
        color:#fff;border:0;border-radius:5px;font-size:15px;cursor:pointer;
        text-decoration:none}
table{border-collapse:collapse;width:100%;margin-top:20px}
th,td{border-bottom:1px solid #e4e9ef;padding:9px 8px;text-align:left;font-size:15px}
nav a{margin-right:18px}
</style></head><body><header>${title}</header><main>${body}</main></body></html>`;
}

function denied(res: express.Response): void {
  res.status(401).send(page("Not signed in", `<p>Session expired.</p>`));
}

const app = express();
app.use(express.urlencoded({ extended: false }));

// ============================================== Portal A — Northwind
// Shape: login -> dashboard -> reports -> download. Three hops.

app.get("/a", (_req, res) => res.redirect("/a/login"));

app.get("/a/login", (_req, res) => {
  res.send(
    page(
      "Northwind Statements",
      `<form method="post" action="/a/login">
         <label for="u">Username</label><input id="u" name="u" type="text">
         <label for="p">Password</label><input id="p" name="p" type="password">
         <button type="submit">Sign in</button>
       </form>`,
    ),
  );
});

app.post("/a/login", (req, res) => {
  const { u, p } = req.body as Record<string, string>;
  if (u === USERS.a!.user && p === USERS.a!.pass) {
    login(res, "a");
    return res.redirect("/a/dashboard");
  }
  res.status(401).send(page("Northwind Statements", `<p>Invalid credentials.</p>`));
});

app.get("/a/dashboard", (req, res) => {
  if (!authed(req, "a")) return denied(res);
  res.send(
    page(
      "Northwind Statements",
      `<nav><a href="/a/dashboard">Overview</a><a href="/a/reports">Reports</a></nav>
       <p>Welcome back. Your latest statement is available under Reports.</p>`,
    ),
  );
});

app.get("/a/reports", (req, res) => {
  if (!authed(req, "a")) return denied(res);
  // The heal demo: this label changes when the site is "broken".
  const label = BROKEN.has("a")
    ? "Retrieve Statement (PDF)"
    : "Download Monthly Statement";
  res.send(
    page(
      "Northwind Statements",
      `<nav><a href="/a/dashboard">Overview</a><a href="/a/reports">Reports</a></nav>
       <h2>Available reports</h2>
       <a class="btn" href="/a/files/statement.pdf">${label}</a>`,
    ),
  );
});

app.get("/a/files/statement.pdf", (req, res) => {
  if (!authed(req, "a")) return denied(res);
  sendPdf(res, "northwind-statement.pdf", "Northwind Monthly Statement");
});

// ================================================== Portal B — Contoso
// Shape: login form on the landing page -> download straight away. One hop.

app.get("/b", (_req, res) => {
  res.send(
    page(
      "Contoso Docs",
      `<form method="post" action="/b">
         <label for="e">Email</label><input id="e" name="e" type="text">
         <label for="pc">Passcode</label><input id="pc" name="pc" type="password">
         <button type="submit">Log In</button>
       </form>`,
    ),
  );
});

app.post("/b", (req, res) => {
  const { e, pc } = req.body as Record<string, string>;
  if (e === USERS.b!.user && pc === USERS.b!.pass) {
    login(res, "b");
    return res.redirect("/b/home");
  }
  res.status(401).send(page("Contoso Docs", `<p>Login failed.</p>`));
});

app.get("/b/home", (req, res) => {
  if (!authed(req, "b")) return denied(res);
  res.send(
    page(
      "Contoso Docs",
      `<p>Signed in as ${USERS.b!.user}.</p>
       <a class="btn" href="/b/files/invoice.pdf">Get Latest Invoice</a>`,
    ),
  );
});

app.get("/b/files/invoice.pdf", (req, res) => {
  if (!authed(req, "b")) return denied(res);
  sendPdf(res, "contoso-invoice.pdf", "Contoso Latest Invoice");
});

// ==================================================== Portal C — Acme
// Shape: login -> portal -> documents -> set a filter -> download the row.
// The filter is the interesting bit: a select + apply before the link exists.

app.get("/c", (_req, res) => res.redirect("/c/signin"));

app.get("/c/signin", (_req, res) => {
  res.send(
    page(
      "Acme Filings",
      `<form method="post" action="/c/signin">
         <label for="uid">User ID</label><input id="uid" name="uid" type="text">
         <label for="pin">PIN</label><input id="pin" name="pin" type="password">
         <button type="submit">Continue</button>
       </form>`,
    ),
  );
});

app.post("/c/signin", (req, res) => {
  const { uid, pin } = req.body as Record<string, string>;
  if (uid === USERS.c!.user && pin === USERS.c!.pass) {
    login(res, "c");
    return res.redirect("/c/portal");
  }
  res.status(401).send(page("Acme Filings", `<p>Sign-in rejected.</p>`));
});

app.get("/c/portal", (req, res) => {
  if (!authed(req, "c")) return denied(res);
  res.send(
    page(
      "Acme Filings",
      `<nav><a href="/c/portal">Home</a><a href="/c/documents">Document Center</a></nav>
       <p>Regulatory filings are in the Document Center.</p>`,
    ),
  );
});

app.get("/c/documents", (req, res) => {
  if (!authed(req, "c")) return denied(res);
  const period = String((req.query.period as string) ?? "");
  const rows = period
    ? `<tr><td>Quarterly Filing — ${period}</td><td>PDF</td>
         <td><a href="/c/files/filing-${period}.pdf">Download</a></td></tr>`
    : `<tr><td colspan="3">Select a period and apply the filter.</td></tr>`;
  res.send(
    page(
      "Acme Filings",
      `<nav><a href="/c/portal">Home</a><a href="/c/documents">Document Center</a></nav>
       <form method="get" action="/c/documents">
         <label for="period">Period</label>
         <select id="period" name="period">
           <option value="">— choose —</option>
           <option value="2026-Q1"${period === "2026-Q1" ? " selected" : ""}>2026-Q1</option>
           <option value="2026-Q2"${period === "2026-Q2" ? " selected" : ""}>2026-Q2</option>
         </select>
         <button type="submit">Apply</button>
       </form>
       <table><thead><tr><th>Document</th><th>Format</th><th></th></tr></thead>
       <tbody>${rows}</tbody></table>`,
    ),
  );
});

app.get("/c/files/:name", (req, res) => {
  if (!authed(req, "c")) return denied(res);
  const name = String(req.params.name);
  if (!/^filing-[0-9]{4}-Q[1-4]\.pdf$/.test(name)) return res.status(404).end();
  sendPdf(res, name, `Acme ${name.replace(/^filing-|\.pdf$/g, "")} Filing`);
});

app.listen(PORT, () => {
  console.log(`mock portals on http://localhost:${PORT}`);
  console.log(`  a: /a  Northwind  (login -> dashboard -> reports -> download)`);
  console.log(`  b: /b  Contoso    (login -> download)`);
  console.log(`  c: /c  Acme       (login -> portal -> documents -> filter -> download)`);
  if (BROKEN.size) console.log(`  BREAK active for: ${[...BROKEN].join(", ")}`);
});
