// Craftability checks, run in Node with the real source cut out of the add-on files:
//  - background.js: verifyPurchaseOfferCraftability (an STN / scrap.tf purchase offer is only accepted
//    when its items are the craftable / Non-Craftable kind the job is for)
//  - page-bridge.js: the "tmt-classify-craftability" handler (which copy in a trader's inventory is
//    craftable)
// Run: node tests/test_craft.js
const fs = require("fs"), vm = require("vm"), path = require("path");
const root = path.join(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8").replace(/^﻿/, "");

const src = read("tf2_trade_arbitrage_prototype/background.js");
const start = src.indexOf("const UNCRAFTABLE_DESCRIPTION");
const end = src.indexOf("function setSteamApiPurchaseProgress");
if (start < 0 || end < start) throw new Error("could not find the craftability code in background.js");
const code = src.slice(start, end);

const msgs = [];
let api = { offer: null, descriptions: [], fail: false };
const ctx = {
  console, URL,
  emitTradeAutomationStatus: m => msgs.push(m),
  getBackpackSpec: n => ({ craftability: /^non[- ]craftable\s/i.test(n) ? "Non-Craftable" : "Craftable" }),
  steamApiRequest: async () => {
    if (api.fail) throw new Error("HTTP 500");
    return { response: { offer: api.offer, descriptions: api.descriptions } };
  }
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

const D = (classid, uncraft, extra = {}) => ({
  appid: 440, classid, instanceid: "0", name: "Ap-Sap",
  descriptions: uncraft ? [{ value: "( Not Usable in Crafting )" }] : [{ value: "Level 1 Hat" }], ...extra
});
const offer = ids => ({ tradeofferid: "5", items_to_receive: ids.map(c => ({ appid: 440, classid: c, instanceid: "0", amount: "1" })) });
let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log("FAIL", m); } else console.log("ok", m); };

(async () => {
  const run = async (name, o, d) => {
    api.offer = o; api.descriptions = d; msgs.length = 0;
    try { await ctx.verifyPurchaseOfferCraftability({ name }, 1, "5", "k"); return "pass"; }
    catch (e) { return e.message; }
  };
  ok(await run("Ap-Sap", offer(["1", "2"]), [D("1", false), D("2", false)]) === "pass", "craftable job, craftable offer passes");
  let r = await run("Ap-Sap", offer(["1", "2"]), [D("1", false), D("2", true)]);
  ok(/1 Non-Craftable item/.test(r) && /not accepted/.test(r), "craftable job, 1 uncraftable refused: " + r);
  ok(await run("Non-Craftable Ap-Sap", offer(["2"]), [D("2", true)]) === "pass", "non-craftable job, uncraftable offer passes");
  r = await run("Non-Craftable Ap-Sap", offer(["1"]), [D("1", false)]);
  ok(/holds 1 craftable item/.test(r), "non-craftable job, craftable refused: " + r);
  ok(await run("Ap-Sap", offer(["9"]), []) === "pass" && /did not describe/.test(msgs.join("|")), "no descriptions -> passes with note");
  ok(await run("Ap-Sap", null, []) === "pass", "offer not found -> passes");
  api.fail = true;
  ok(await run("Ap-Sap", offer(["1"]), []) === "pass" && /Continuing without that check/.test(msgs.join("|")), "api failure -> passes with note");
  api.fail = false;
  ok(ctx.descriptionIsUncraftable({ market_hash_name: "Non-Craftable Ap-Sap", descriptions: [] }), "market name Non-Craftable detected");

  // page-bridge classifier
  const bsrc = read("automaticMetal/page-bridge.js");
  const bs = bsrc.indexOf('window.addEventListener("tmt-classify-craftability"');
  const be = bsrc.indexOf("// Applies Steam's advanced Quality");
  if (bs < 0 || be < bs) throw new Error("could not find the classifier in page-bridge.js");
  let handler; const emitted = [];
  const bctx = {
    window: {
      UserYou: { getInventory: () => ({ rgInventory: {
        "11": { descriptions: [{ value: "( Not Usable in Crafting )" }] },
        "12": { descriptions: [{ value: "Level 1" }] },
        "13": { name: "x" } } }) },
      addEventListener: (n, f) => { handler = f; }
    },
    emit: (n, d) => emitted.push(d), activeInventoryContainer: () => null, console
  };
  vm.createContext(bctx);
  vm.runInContext(bsrc.slice(bs, be), bctx);
  handler({ detail: JSON.stringify({ requestId: "r", side: "you", assetIds: ["11", "12", "13", "14"] }) });
  const out = emitted[0];
  ok(out.ok && out.craftable["11"] === false && out.craftable["12"] === true && !("13" in out.craftable) && !("14" in out.craftable),
    "bridge classifies " + JSON.stringify(out.craftable));

  console.log(fails ? "FAILURES " + fails : "ALL PASS");
  process.exit(fails ? 1 : 0);
})();
