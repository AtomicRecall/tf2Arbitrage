// A small local table of items that were just checked.
//
// It lives in the extension's local storage (key "checkedItems", an object keyed
// by the lower-case item name) next to the "savedTrades" table and never leaves
// the browser. Each row holds only the item, the price it was checked at, where
// that price came from and when it may be checked again (60 minutes later). A
// normal scan skips every item whose row is still fresh and whose marketplace
// price has not changed. This file only holds the pure bookkeeping; background.js
// loads and stores the object.
(function(root){
  const STORAGE_KEY="checkedItems";
  const TTL_MS=60*60*1000;
  const MAX_ENTRIES=2000;

  function keyFor(name){
    return String(name||"").trim().replace(/\s+/g," ").toLowerCase();
  }

  function normalizeSource(source){
    return source==="scrap.tf"?"scrap.tf":"stn";
  }

  function normalizePrice(price){
    return String(price||"").trim().replace(/\s+/g," ").toLowerCase();
  }

  // Records that `name` was checked at `price` on `source`. `outcome` is
  // "good", "not-good" or "not-found". Returns the map.
  function record(map,info,now=Date.now()){
    const name=String(info?.name||"").trim();
    const key=keyFor(name);
    if(!key)return map;
    map[key]={
      name,
      source:normalizeSource(info.source),
      price:String(info.price||""),
      outcome:String(info.outcome||"not-good"),
      note:String(info.note||"").slice(0,200),
      profitRef:Number.isFinite(info.profitRef)?info.profitRef:null,
      checkedAt:now,
      expiresAt:now+TTL_MS
    };
    return trim(map,now);
  }

  // The row for `name` when it is still inside its 60 minutes, else null.
  function fresh(map,name,now=Date.now()){
    const entry=map&&map[keyFor(name)];
    if(!entry||!Number.isFinite(entry.expiresAt)||entry.expiresAt<=now)return null;
    return entry;
  }

  // The row to skip an item for: still fresh, same site and the same price as
  // when it was checked. A changed price means the earlier answer may be wrong,
  // so the item is checked again.
  function skipEntry(map,item,now=Date.now()){
    const entry=fresh(map,item?.name,now);
    if(!entry)return null;
    if(entry.source!==normalizeSource(item?.source))return null;
    if(normalizePrice(entry.price)!==normalizePrice(item?.price))return null;
    return entry;
  }

  function remove(map,name){
    delete map[keyFor(name)];
    return map;
  }

  // Drops rows whose 60 minutes ran out.
  function prune(map,now=Date.now()){
    for(const key of Object.keys(map||{})){
      const entry=map[key];
      if(!entry||!Number.isFinite(entry.expiresAt)||entry.expiresAt<=now)delete map[key];
    }
    return map;
  }

  // Fresh rows only, soonest to expire first, for the list in the popup.
  function list(map,now=Date.now()){
    return Object.values(map&&typeof map==="object"?map:{})
      .filter(entry=>entry&&entry.name&&Number.isFinite(entry.expiresAt)&&entry.expiresAt>now)
      .sort((a,b)=>a.expiresAt-b.expiresAt);
  }

  function trim(map,now=Date.now()){
    prune(map,now);
    const entries=Object.values(map).sort((a,b)=>b.checkedAt-a.checkedAt);
    if(entries.length<=MAX_ENTRIES)return map;
    const kept={};
    for(const entry of entries.slice(0,MAX_ENTRIES))kept[keyFor(entry.name)]=entry;
    return kept;
  }

  const exported={STORAGE_KEY,TTL_MS,MAX_ENTRIES,keyFor,record,fresh,skipEntry,remove,prune,list};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else root.TF2CheckedItems=exported;
})(typeof self!=="undefined"?self:this);
