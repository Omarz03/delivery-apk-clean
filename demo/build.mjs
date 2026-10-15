// build.mjs — يبني النسخة التجريبية: ينسخ public/ إلى demo/dist/ ويحقن طبقة الديمو.
// الاستخدام: node demo/build.mjs   (بدون أي حزم خارجية)
import { cpSync, copyFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "public");
const out = join(here, "dist");

rmSync(out, { recursive: true, force: true });
cpSync(src, out, { recursive: true });
copyFileSync(join(here, "demo.js"), join(out, "demo.js"));
copyFileSync(join(here, "demo.css"), join(out, "demo.css"));

const indexPath = join(out, "index.html");
let html = readFileSync(indexPath, "utf8");

const replaceOnce = (needle, replacement) => {
  if (!html.includes(needle)) throw new Error(`build: "${needle}" not found in index.html`);
  html = html.replace(needle, replacement);
};

replaceOnce("</title>", " — نسخة تجريبية | Demo</title>");
replaceOnce(
  "</head>",
  '    <meta name="robots" content="noindex" />\n    <link rel="stylesheet" href="demo.css" />\n  </head>'
);
replaceOnce("</body>", '    <script src="demo.js"></script>\n  </body>');
writeFileSync(indexPath, html);

// عامل خدمة فارغ يلغي تسجيل نفسه ويمسح الكاش، حتى لا تبقى نسخ قديمة بعد كل نشر
writeFileSync(
  join(out, "service-worker.js"),
  `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.map((k) => caches.delete(k))))
      .then(() => self.registration.unregister())
  );
});
`
);

console.log("Demo built →", out);
