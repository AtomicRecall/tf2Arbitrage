// checked-items.js: the 60-minute "already checked" memory. Pure module, loaded with require().
// Run: node tests/test_checked_items.js
const path = require("path");
const C = require(path.join(__dirname, "..", "tf2_trade_arbitrage_prototype", "checked-items.js"));

let fails = 0;
const ok = (cond, label) => { if (!cond) { fails++; console.log("FAIL", label); } else console.log("ok", label); };
const MIN = 60 * 1000;
const t0 = 1_000_000_000_000;

const map = {};
C.record(map, { name: "Team Captain", price: "1.33 ref", source: "stn", direction: "forward", outcome: "not-good" }, t0);
const item = { name: "Team Captain", price: "1.33 ref", source: "stn" };

ok(C.skipEntry(map, item, t0 + 30 * MIN), "same price within 60 minutes is skipped");
ok(!C.skipEntry(map, { ...item, price: "1.55 ref" }, t0 + 30 * MIN), "a changed price is checked again");
ok(!C.skipEntry(map, item, t0 + 61 * MIN), "after 60 minutes it is checked again");
ok(!C.skipEntry(map, { ...item, source: "scrap.tf" }, t0 + MIN), "a forward block from another site is not reused");
ok(!C.skipEntry(map, item, t0 + MIN, "reverse"), "the reverse direction is not covered by a forward check");

C.record(map, { name: "Team Captain", price: "1.33 ref", direction: "reverse", outcome: "not-found" }, t0 + 5 * MIN);
ok(C.skipEntry(map, item, t0 + 10 * MIN, "reverse"), "a reverse check is remembered separately");
ok(C.skipEntry(map, item, t0 + 10 * MIN, "forward"), "recording reverse keeps the forward block");
ok(C.status(map, item, t0 + 10 * MIN).level === "full", "both directions fresh -> fully checked");
ok(C.status(map, item, t0 + 62 * MIN).level === "partial", "forward expired, reverse fresh -> partial");

ok(C.keyFor("  Team   Captain ") === "team captain", "names are normalised");
C.prune(map, t0 + 120 * MIN);
ok(Object.keys(map).length === 0, "expired rows are pruned");

console.log(fails ? "FAILURES " + fails : "ALL PASS");
process.exit(fails ? 1 : 0);
