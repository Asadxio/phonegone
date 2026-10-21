import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CHROME_PATH = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 8766;
const CDP_PORT = 9223;
const STATIC_DIR = "c:/Users/xioas/Downloads/phonegone-prototype/phonegone";

// MIME types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.js': 'application/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json'
};

// Start static HTTP server
const server = http.createServer((req, res) => {
  const parsedUrl = new URL(req.url, `http://127.0.0.1:${PORT}`);
  let filePath = path.join(STATIC_DIR, parsedUrl.pathname === '/' ? 'index.html' : parsedUrl.pathname);
  
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }
});

await new Promise(r => server.listen(PORT, '127.0.0.1', r));
console.log(`[TEST SERVER] Running at http://127.0.0.1:${PORT}`);

// Launch Chrome Headless
const tempProfile = path.join(process.env.TEMP || 'C:\\Temp', `chrome_test_${Date.now()}`);
const chromeProc = spawn(CHROME_PATH, [
  '--headless=new',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${tempProfile}`,
  '--disable-gpu',
  '--disable-extensions',
  '--no-first-run',
  '--no-default-browser-check',
  'about:blank'
]);

await new Promise(r => setTimeout(r, 1500));

// Connect to CDP
let wsDebuggerUrl = null;
for (let i = 0; i < 5; i++) {
  try {
    const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
    const targets = await resp.json();
    const pageTarget = targets.find(t => t.type === 'page') || targets[0];
    if (pageTarget && pageTarget.webSocketDebuggerUrl) {
      wsDebuggerUrl = pageTarget.webSocketDebuggerUrl;
      break;
    }
  } catch (e) {
    await new Promise(r => setTimeout(r, 500));
  }
}

if (!wsDebuggerUrl) {
  console.error("Failed to obtain Chrome CDP WebSocket URL");
  chromeProc.kill();
  server.close();
  process.exit(1);
}

const ws = new WebSocket(wsDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.onopen = resolve;
  ws.onerror = reject;
});

let msgId = 0;
const pending = new Map();
const consoleErrors = [];
const networkRequests = [];

ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.id && pending.has(data.id)) {
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(data.error);
    else resolve(data.result);
  } else if (data.method === 'Runtime.consoleAPICalled') {
    if (data.params.type === 'error') {
      consoleErrors.push(data.params.args.map(a => a.value || a.description).join(' '));
    }
  } else if (data.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(data.params.exceptionDetails.text + ' ' + (data.params.exceptionDetails.exception?.description || ''));
  } else if (data.method === 'Network.requestWillBeSent') {
    networkRequests.push(data.params.request.url);
  }
};

function send(method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function evalExpr(expr) {
  const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (res.exceptionDetails) {
    throw new Error('Eval failed: ' + res.exceptionDetails.text + ' ' + JSON.stringify(res.exceptionDetails));
  }
  return res.result?.value;
}

const results = { passed: 0, failed: 0 };
function assert(name, condition, extra = '') {
  if (condition) {
    results.passed++;
    console.log(`  ✓ ${name}` + (extra ? ` (${extra})` : ''));
  } else {
    results.failed++;
    console.error(`  ✗ ${name}: FAILED` + (extra ? ` (${extra})` : ''));
  }
}

console.log("\n--- Executing Chrome Headless End-to-End Tests ---");

try {
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');

  // Navigate to page
  console.log(`Navigating to http://127.0.0.1:${PORT}/index.html...`);
  const navRes = await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  console.log("Nav result:", navRes);
  await new Promise(r => setTimeout(r, 2000));
  const locHref = await evalExpr('window.location.href');
  console.log("Current location:", locHref);

  // 1. Title verification
  const title = await evalExpr('document.title');
  assert("Document title is set and branded", title.includes("PhoneGone"), `Title: "${title}"`);

  // 2. Console errors
  assert("Console has zero uncaught JS exceptions", consoleErrors.length === 0, consoleErrors.join('; '));

  // 3. Privacy & Network isolation
  const thirdPartyRequests = networkRequests.filter(u => !u.startsWith(`http://127.0.0.1:${PORT}`));
  assert("Zero external network requests (100% Client-Side Privacy)", thirdPartyRequests.length === 0, `Requests: ${thirdPartyRequests.length}`);

  // 4. Initial scenario default state
  const initialStepsCount = await evalExpr('document.querySelectorAll(".step-card").length');
  const initialProgress = await evalExpr('document.getElementById("progressBar").style.width');
  assert("Default scenario is 'lost' with 6 steps", initialStepsCount === 6, `Found ${initialStepsCount}`);
  assert("Initial progress is 0%", initialProgress === '0%', `Progress: ${initialProgress}`);

  // 5. Scenario switching: 'stolen'
  await evalExpr('document.getElementById("tab-stolen").click()');
  await new Promise(r => setTimeout(r, 200));
  const stolenCount = await evalExpr('document.querySelectorAll(".step-card").length');
  const stolenActive = await evalExpr('document.getElementById("tab-stolen").classList.contains("active")');
  assert("Switch to 'stolen' scenario renders 8 prioritized steps", stolenCount === 8 && stolenActive, `Count: ${stolenCount}`);

  // 6. Scenario switching: 'found'
  await evalExpr('document.getElementById("tab-found").click()');
  await new Promise(r => setTimeout(r, 200));
  const foundCount = await evalExpr('document.querySelectorAll(".step-card").length');
  const foundActive = await evalExpr('document.getElementById("tab-found").classList.contains("active")');
  assert("Switch to 'found' scenario renders 6 steps", foundCount === 6 && foundActive, `Count: ${foundCount}`);

  // Switch back to 'lost'
  await evalExpr('document.getElementById("tab-lost").click()');
  await new Promise(r => setTimeout(r, 200));

  // 7. Language Switcher: Toggle to Hindi (hi)
  await evalExpr(`
    const sel = document.getElementById('langSelect');
    sel.value = 'hi';
    sel.dispatchEvent(new Event('change'));
  `);
  await new Promise(r => setTimeout(r, 200));

  const langAttr = await evalExpr('document.documentElement.lang');
  const storedLang = await evalExpr('localStorage.getItem("phonegone_lang")');
  const heroHi = await evalExpr('document.querySelector("h1").innerText');
  const firstStepTag = await evalExpr('document.querySelector(".step-tag").innerText');
  assert("Language switch updates document.documentElement.lang to 'hi'", langAttr === 'hi');
  assert("Language preference saved to localStorage", storedLang === 'hi');
  assert("Hero title translated to Hindi", heroHi.includes("फोन खो गया") || heroHi.includes("घबराएँ नहीं"));
  assert("Checklist step tags translated to Hindi", firstStepTag.includes("चरण"));

  // 8. Interactive Checklist completion
  await evalExpr('document.querySelectorAll(".step-checkbox")[0].click()');
  await new Promise(r => setTimeout(r, 100));
  await evalExpr('document.querySelectorAll(".step-checkbox")[1].click()');
  await new Promise(r => setTimeout(r, 100));

  const step1Checked = await evalExpr('document.querySelectorAll(".step-checkbox")[0].checked');
  const step2Checked = await evalExpr('document.querySelectorAll(".step-checkbox")[1].checked');
  const newProgress = await evalExpr('document.getElementById("progressBar").style.width');
  const progressText = await evalExpr('document.getElementById("progressCount").innerText');
  const storedSteps = await evalExpr('localStorage.getItem("phonegone_steps")');
  assert("Ticking steps updates progress bar to 33%", newProgress === '33%' && step1Checked && step2Checked, `Progress: ${newProgress} (${progressText})`);
  assert("Step checkbox states stored in localStorage", storedSteps.includes('"lost-0":true') && storedSteps.includes('"lost-1":true'));

  // 9. Document readiness checklist
  await evalExpr('document.getElementById("doc-fir").click()');
  await new Promise(r => setTimeout(r, 100));
  const docFirState = await evalExpr('JSON.parse(localStorage.getItem("phonegone_docs") || "{}").fir');
  assert("CEIR document checkbox state stored in localStorage", docFirState === true);

  // 10. Persistence across page reload
  console.log("Testing page reload persistence...");
  await send('Page.reload');
  await new Promise(r => setTimeout(r, 1200));

  const reloadedLang = await evalExpr('document.documentElement.lang');
  const reloadedProgress = await evalExpr('document.getElementById("progressBar").style.width');
  const reloadedStep0 = await evalExpr('document.querySelectorAll(".step-checkbox")[0].checked');
  const reloadedStep1 = await evalExpr('document.querySelectorAll(".step-checkbox")[1].checked');
  const reloadedDocFir = await evalExpr('document.getElementById("doc-fir").checked');

  assert("Language persists as Hindi after page reload", reloadedLang === 'hi');
  assert("Checklist progress persists after page reload", reloadedProgress === '33%' && reloadedStep0 && reloadedStep1, `Progress: ${reloadedProgress}`);
  assert("Document readiness checkbox persists after reload", reloadedDocFir === true);

  // 11. Download checklist trigger
  await evalExpr('document.getElementById("downloadChecklistBtn").click()');
  await new Promise(r => setTimeout(r, 300));
  const toastText = await evalExpr('document.getElementById("toastMsg").innerText');
  assert("Download checklist triggers notification toast", toastText.includes("सफलतापूर्वक") || toastText.includes("downloaded"), `Toast: "${toastText}"`);

  // 12. Reset Progress
  await evalExpr('window.confirm = () => true; document.getElementById("resetChecklistBtn").click();');
  await new Promise(r => setTimeout(r, 300));
  const resetProgressVal = await evalExpr('document.getElementById("progressBar").style.width');
  const resetStep0 = await evalExpr('document.querySelectorAll(".step-checkbox")[0].checked');
  const resetDoc = await evalExpr('document.getElementById("doc-fir").checked');
  assert("Reset progress clears all checkboxes and resets bar to 0%", resetProgressVal === '0%' && !resetStep0 && !resetDoc);

  // 13. Mobile responsiveness check (360px budget Android viewport)
  await send('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 740,
    deviceScaleFactor: 2,
    mobile: true
  });
  await new Promise(r => setTimeout(r, 400));

  const scrollWidth = await evalExpr('document.documentElement.scrollWidth');
  const innerWidth = await evalExpr('window.innerWidth');
  assert("Mobile 360px viewport: zero horizontal overflow", scrollWidth <= innerWidth, `scrollWidth=${scrollWidth}, innerWidth=${innerWidth}`);

  // 14. Switch language back to English
  await evalExpr(`
    const sel = document.getElementById('langSelect');
    sel.value = 'en';
    sel.dispatchEvent(new Event('change'));
  `);
  await new Promise(r => setTimeout(r, 200));
  const finalLang = await evalExpr('document.documentElement.lang');
  const heroEn = await evalExpr('document.querySelector("h1").innerText');
  assert("Switching back to English updates DOM and headings", finalLang === 'en' && heroEn.includes("Lost your phone?"));

} catch (err) {
  console.error("Test execution error:", err);
  results.failed++;
} finally {
  ws.close();
  chromeProc.kill();
  server.close();
  console.log("\n============================================================");
  console.log(` SUMMARY: ${results.passed} passed, ${results.failed} failed`);
  console.log("============================================================");
  process.exit(results.failed === 0 ? 0 : 1);
}
