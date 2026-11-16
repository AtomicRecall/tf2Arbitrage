// A small local table of items that were just checked.
//
// It lives in the extension's local storage (key "checkedItems", an object keyed
// by the lower-case item name) next to the "savedTrades" table and never leaves
// the browser. An item can be checked in two directions:
//   forward  - buy on the marketplace (STN or scrap.tf), sell on Backpack.tf
//   reverse  - sell to STN: for an STN item buy on Backpack.tf, for a scrap.tf item buy on
//              scrap.tf (the block's "via" says "scrap.tf" then)
// Each direction is its own block {price, outcome, note, profitRef, checkedAt,
// expiresAt}: the price it was checked at and when it may be checked again (60
// minutes later). A normal scan skips every direction whose block is still fresh
// and whose marketplace price has not changed. An STN item counts as fully
// checked only when both directions are fresh (scrap.tf items too). This file only holds the pure bookkeeping; background.js
// loads and stores the object.
//
// Row shape: {name, source, forward, reverse, price, outcome, note, profitRef,
// checkedAt, expiresAt}. The top-level price/outcome/note/profitRef/checkedAt/
// expiresAt repeat the forward block (else the reverse one) so rows written by
// earlier versions, which only had those fields, still read as a forward check.
(function(root){
  const STORAGE_KEY="checkedItems";
  const TTL_MS=60*60*1000;
  const MAX_ENTRIES=2000;
  const DIRECTIONS=["forward","reverse"];

  function keyFor(name){
    return String(name||"").trim().replace(/\s+/g," ").toLowerCase();
  }

  function normalizeSource(source){
    return source==="scrap.tf"?"scrap.tf":"stn";
  }

  function normalizePrice(price){
    return String(price||"").trim().replace(/\s+/g," ").toLowerCase();
  }

  function normalizeDirection(direction){
    return direction==="reverse"?"reverse":"forward";
  }

  function blockOf(raw){
    if(!raw||typeof raw!=="object"||!Number.isFinite(raw.expiresAt))return null;
    return {
      price:String(raw.price||""),
      outcome:String(raw.outcome||"not-good"),
      note:String(raw.note||"").slice(0,200),
      via:raw.via==="scrap.tf"?"scrap.tf":"",
      profitRef:Number.isFinite(raw.profitRef)?raw.profitRef:null,
      checkedAt:Number(raw.checkedAt)||0,
      expiresAt:Number(raw.expiresAt)
    };
  }

  // The two blocks of a stored row (also for rows from before directions
  // existed). `forwardSource` is the site the forward check was made on.
  function blocks(entry){
    if(!entry||typeof entry!=="object")return {forward:null,reverse:null,forwardSource:"stn"};
    const legacy=entry.forward===undefined&&entry.reverse===undefined;
    return {
      forward:legacy?blockOf(entry):blockOf(entry.forward),
      reverse:legacy?null:blockOf(entry.reverse),
      forwardSource:normalizeSource(entry.source)
    };
  }

  function isFresh(block,now){
    return Boolean(block)&&block.expiresAt>now;
  }

  function summarize(row){
    const active=[row.forward,row.reverse].filter(Boolean);
    const first=row.forward||row.reverse;
    row.price=first?first.price:"";
    row.outcome=first?first.outcome:"not-good";
    row.note=first?first.note:"";
    row.profitRef=first?first.profitRef:null;
    row.checkedAt=active.length?Math.max(...active.map(block=>block.checkedAt)):0;
    row.expiresAt=active.length?Math.min(...active.map(block=>block.expiresAt)):0;
    return row;
  }

  // Records that `name` was checked in `info.direction` ("forward" by default) at
  // `price`. For forward checks `info.source` is the site the price came from;
  // reverse checks are always on STN. `outcome` is "good", "not-good" or
  // "not-found". Returns the map.
  function record(map,info,now=Date.now()){
    const name=String(info?.name||"").trim();
    const key=keyFor(name);
    if(!key)return map;
    const direction=normalizeDirection(info.direction);
    const previous=blocks(map[key]);
    const row={
      name,
      source:direction==="forward"?normalizeSource(info.source):previous.forwardSource,
      forward:isFresh(previous.forward,now)?previous.forward:null,
      reverse:isFresh(previous.reverse,now)?previous.reverse:null
    };
    row[direction]={
      price:String(info.price||""),
      outcome:String(info.outcome||"not-good"),
      note:String(info.note||"").slice(0,200),
      via:info.via==="scrap.tf"?"scrap.tf":"",
      profitRef:Number.isFinite(info.profitRef)?info.profitRef:null,
      checkedAt:now,
      expiresAt:now+TTL_MS
    };
    if(!row.forward)row.source="stn";
    map[key]=summarize(row);
    return trim(map,now);
  }

  // The row for `name` while any direction is still inside its 60 minutes, else null.
  function fresh(map,name,now=Date.now()){
    const entry=map&&map[keyFor(name)];
    const found=blocks(entry);
    if(!isFresh(found.forward,now)&&!isFresh(found.reverse,now))return null;
    return entry;
  }

  // The block to skip a direction of an item for: still fresh and the same price
  // as when it was checked (a changed price means the earlier answer may be
  // wrong). A forward block also has to come from the same site. `item.price` is
  // the price on the marketplace page being scanned, which is STN's selling
  // price for a reverse check.
  function skipEntry(map,item,now=Date.now(),direction="forward"){
    const dir=normalizeDirection(direction);
    const found=blocks(map&&map[keyFor(item?.name)]);
    const block=found[dir];
    if(!isFresh(block,now))return null;
    if(dir==="forward"&&found.forwardSource!==normalizeSource(item?.source))return null;
    if(normalizePrice(block.price)!==normalizePrice(item?.price))return null;
    return block;
  }

  // How completely an item on the page below is checked. `source` is the site of
  // the page and `price` its listed price. An item has two directions (forward and
  // sell-to-STN), so it is half checked while only one is fresh. `level` is "full", "partial" or "none"; `expiresAt` is
  // when the first of the fresh checks runs out; `done` / `missing` name the
  // directions.
  function status(map,item,now=Date.now()){
    const source=normalizeSource(item?.source);
    const needed=["forward","reverse"];
    const done=needed.filter(direction=>skipEntry(map,item,now,direction));
    const found=blocks(map&&map[keyFor(item?.name)]);
    const level=done.length===needed.length?"full":(done.length?"partial":"none");
    return {
      level,
      done,
      missing:needed.filter(direction=>!done.includes(direction)),
      expiresAt:done.length?Math.min(...done.map(direction=>found[direction].expiresAt)):0
    };
  }

  function remove(map,name){
    delete map[keyFor(name)];
    return map;
  }

  // Drops the directions whose 60 minutes ran out, and rows left with none.
  function prune(map,now=Date.now()){
    for(const key of Object.keys(map||{})){
      const entry=map[key];
      if(!entry||typeof entry!=="object"){delete map[key];continue}
      const found=blocks(entry);
      const forward=isFresh(found.forward,now)?found.forward:null;
      const reverse=isFresh(found.reverse,now)?found.reverse:null;
      if(!forward&&!reverse){delete map[key];continue}
      if(forward!==found.forward||reverse!==found.reverse||entry.forward===undefined){
        map[key]=summarize({name:entry.name,source:found.forwardSource,forward,reverse});
      }
    }
    return map;
  }

  // Rows with at least one fresh direction, soonest to expire first, for the list
  // in the popup. Each row is normalized: expired directions are left out.
  function list(map,now=Date.now()){
    const rows=[];
    for(const entry of Object.values(map&&typeof map==="object"?map:{})){
      if(!entry||!entry.name)continue;
      const found=blocks(entry);
      const forward=isFresh(found.forward,now)?found.forward:null;
      const reverse=isFresh(found.reverse,now)?found.reverse:null;
      if(!forward&&!reverse)continue;
      rows.push(summarize({name:entry.name,source:found.forwardSource,forward,reverse}));
    }
    return rows.sort((a,b)=>a.expiresAt-b.expiresAt);
  }

  function trim(map,now=Date.now()){
    prune(map,now);
    const entries=Object.values(map).sort((a,b)=>b.checkedAt-a.checkedAt);
    if(entries.length<=MAX_ENTRIES)return map;
    const kept={};
    for(const entry of entries.slice(0,MAX_ENTRIES))kept[keyFor(entry.name)]=entry;
    return kept;
  }

  const exported={STORAGE_KEY,TTL_MS,MAX_ENTRIES,DIRECTIONS,keyFor,record,fresh,skipEntry,status,remove,prune,list};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else root.TF2CheckedItems=exported;
})(typeof self!=="undefined"?self:this);
