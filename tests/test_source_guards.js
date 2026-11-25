// Source guards: cheap checks that safety rules were not edited away. They read the source text only
// (background.js and the content scripts need the browser, so they cannot be run here), so a failure
// means "look at what changed", not necessarily "broken". If a rule is changed ON PURPOSE, update the
// matching line here in the same change.
// Run: node tests/test_source_guards.js
const fs = require("fs"), path = require("path");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

const bg = read("tf2_trade_arbitrage_prototype/background.js");
const content = read("tf2_trade_arbitrage_prototype/content.js");
const popup = read("tf2_trade_arbitrage_prototype/popup.js");

let fails = 0;
const ok = (cond, label) => { if (!cond) { fails++; console.log("FAIL", label); } else console.log("ok", label); };
const number = (source, name) => { const m = source.match(new RegExp("const " + name + "=([0-9*]+);")); return m ? eval(m[1]) : NaN; };

// Real money / real items
ok(/^let tradeAutomationEnabled=false;/m.test(bg), "automatic trading defaults to off");
ok(bg.includes("await verifyPurchaseOfferCraftability(job,batchNumber,purchaseOfferId,steamApiKey);"), "a purchase offer is craftability-checked before it is accepted");
ok(/waitForSteamOfferAccepted\(job,purchaseOfferId,steamApiKey\)/.test(bg), "a purchase waits for Steam state 3 (Accepted)");
ok(/offlineScan/.test(bg) && /Offline scan: items are only checked/.test(bg), "Scan Offline stays check-only");

// Not faster / more aggressive
ok(number(bg, "BETWEEN_ITEMS_MIN") >= 5500, "delay between items was not lowered (>= 5.5 s)");
ok(number(bg, "BETWEEN_CLASSIFIED_PAGES_MIN") >= 4500, "delay between Classifieds pages was not lowered (>= 4.5 s)");

// Bot detection: the exact buyout title, and negotiation rules a listing out
const title = "This listing is managed by a user agent. Click to open a Trade Offer. Please only offer the buyout.";
ok(content.includes(`==="${title}"`), "a bot's button title must be exactly the user-agent buyout sentence");
ok(content.includes('buttonTitle.includes("Negotiation is allowed.")'), "'Negotiation is allowed.' rules a listing out");
ok(content.includes("const botLike=isSell?(!humanSeller&&!negotiationAllowed):(isBotBuyout&&!negotiationAllowed);"), "bot rule: buyout title and no negotiation");
ok(/if\(!isSell&&humanSeller\)continue;/.test(content), "listings with an 'Add this user' button are skipped");

// Profit / freshness thresholds are named constants (see AGENT.md 9.2 before changing)
ok(number(bg, "MIN_PROFIT_REF") === 0.05 || /const MIN_PROFIT_REF=0\.05;/.test(bg), "minimum profit is 0.05 ref");

// UI: no Stop button any more; the running scan button stops the scan
ok(!fs.readFileSync(path.join(root, "tf2_trade_arbitrage_prototype/popup.html"), "utf8").includes('id="stop"'), "popup has no Stop button");
ok(popup.includes("clickFeedback(button,stopScanClicked())"), "the running scan button stops the scan");

console.log(fails ? "FAILURES " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);
