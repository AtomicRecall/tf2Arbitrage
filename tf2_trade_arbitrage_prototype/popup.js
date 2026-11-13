const api=typeof browser!=="undefined"?browser:chrome;
// Opened as the browser sidebar (manifest sidebar_action) the page uses the
// panel's width instead of the popup's fixed one.
if(new URLSearchParams(location.search).get("mode")==="sidebar")document.documentElement.classList.add("sidebar");
const $=id=>document.getElementById(id);
const scan=$("scan"),stop=$("stop"),rate=$("keyRate"),volume=$("volume"),volumeValue=$("volumeValue"),autoTrades=$("autoTrades"),tradeStatus=$("tradeStatus"),steamApiSettings=$("steamApiSettings"),steamApiKey=$("steamApiKey"),saveSteamApiKey=$("saveSteamApiKey"),clearSteamApiKey=$("clearSteamApiKey"),steamApiKeyStatus=$("steamApiKeyStatus"),status=$("status"),results=$("results"),unverifiedResults=$("unverifiedResults"),tradersView=$("tradersView"),total=$("total"),checked=$("checked"),deals=$("deals");
const tabs=[...document.querySelectorAll(".tab")];
const tabAll=$("tabAll"),tabFound=$("tabFound"),tabDeals=$("tabDeals"),tabUnverified=$("tabUnverified"),tabNotFound=$("tabNotFound"),tabDismissed=$("tabDismissed"),tabTraders=$("tabTraders");
let activeFilter="all";
let dismissedItems=new Set();
let traderHistory={};
let steamApiKeyConfigured=false;

const DEFAULT_VOLUME=0.4;

// The saved volume is reset to the 40% default once, so a previously saved
// louder value does not keep the sounds too loud.
api.storage.local.get({keyRate:63,dismissedItems:[],notificationVolume:DEFAULT_VOLUME,volumeDefaultApplied:false,tf2ArbTraderHistory:{},steamWebApiKey:""},v=>{
  rate.value=v.keyRate;
  let savedVolume=Number(v.notificationVolume);
  if(!v.volumeDefaultApplied||!Number.isFinite(savedVolume)){
    savedVolume=DEFAULT_VOLUME;
    api.storage.local.set({notificationVolume:DEFAULT_VOLUME,volumeDefaultApplied:true});
  }
  volume.value=Math.round(Math.max(0,Math.min(1,savedVolume))*100);
  volumeValue.textContent=`${volume.value}%`;
  send({type:"SET_VOLUME",volume:Number(volume.value)/100});
  dismissedItems=new Set(Array.isArray(v.dismissedItems)?v.dismissedItems:[]);
  traderHistory=v.tf2ArbTraderHistory&&typeof v.tf2ArbTraderHistory==="object"?v.tf2ArbTraderHistory:{};
  renderSteamApiKeyStatus(Boolean(String(v.steamWebApiKey||"").trim()));
  renderTraders();
});
function renderTradeAutomation(state){
  if(!state)return;
  autoTrades.checked=Boolean(state.enabled);
  const queued=Number(state.queued)||0;
  const lines=[];
  if(state.active){
    lines.push(`ACTIVE ITEM: ${state.active.name}`);
    lines.push(`WORKFLOW: ${String(state.active.step||"working").replace(/-/g," ")}`);
    if(Number.isFinite(Number(state.active.quantity)))lines.push(`VERIFIED TARGET: ${Number(state.active.quantity)} item${Number(state.active.quantity)===1?"":"s"} across ${Number(state.active.offerCount)||0} offer${Number(state.active.offerCount)===1?"":"s"}`);
    if(state.active.skipPurchase)lines.push("PURCHASE MODE: STN skipped; using existing TF2 inventory");
    if(Number(state.active.purchasedQuantity)>0)lines.push(`STN ITEMS ACCEPTED: ${Number(state.active.purchasedQuantity)}/${Number(state.active.quantity)||0}`);
    if(state.active.purchaseOfferId)lines.push(`STN STEAM OFFER: #${state.active.purchaseOfferId}`);
    const progress=state.active.purchaseProgress;
    if(progress){
      const phaseLabels={
        "steam-api-polling":"Waiting for Steam Web API state 3 (Accepted)",
        "steam-api-retrying":"Retrying Steam Web API request",
        "steam-api-offer-not-found":"Waiting for Steam Web API to return this offer",
        "steam-api-active":"State 2 — Active",
        "steam-api-mobile-confirmation-pending":"State 9 — CreatedNeedsConfirmation",
        "steam-api-in-escrow":"State 11 — InEscrow (not complete)",
        "steam-api-accepted":"State 3 — Accepted",
        "steam-api-state":"Steam Web API returned another trade state",
        "offer-page-loaded":"Offer opened; waiting for Steam controls",
        "waiting-for-contents-control":"Waiting for Confirm Trade Contents",
        "contents-confirmed":"Trade contents confirmed",
        "accept-control-ready":"Steam accept control is ready",
        "accept-clicked":"Accept clicked; waiting for Steam's update",
        "waiting-for-steam-status":"Waiting for Steam's offer status",
        "mobile-confirmation-pending":"Offer page suggests Steam Mobile confirmation is pending",
        "steam-accepted-observed":"Offer page indicates accepted; not yet API-verified",
        "steam-accepted":"Offer page says accepted; not yet API-verified",
        "acceptance-failed":"Offer page could not verify acceptance"
      };
      lines.push(`STEAM STATUS: ${phaseLabels[progress.phase]||progress.phase}`);
      if(progress.steamOfferState!==null&&progress.steamOfferState!==undefined){
        lines.push(`NUMERIC STATE: ${progress.steamOfferState}${progress.steamOfferStateName?` — ${progress.steamOfferStateName}`:""}`);
      }
      if(progress.evidence)lines.push(`EVIDENCE: ${progress.evidence}`);
      if(progress.source||progress.evidenceSource)lines.push(`SOURCE: ${progress.source||progress.evidenceSource}`);
      if(progress.updatedAt)lines.push(`UPDATED: ${new Date(progress.updatedAt).toLocaleTimeString()}`);
      const history=Array.isArray(progress.history)?progress.history.slice(-6):[];
      if(history.length){
        lines.push("STEAM TIMELINE:");
        for(const entry of history){
          const time=entry.updatedAt?new Date(entry.updatedAt).toLocaleTimeString():"";
          lines.push(`${time} ${phaseLabels[entry.phase]||entry.phase}`);
        }
      }
    }
    if(state.active.purchasePageProgress){
      const pageProgress=state.active.purchasePageProgress;
      const pageLabel=pageProgress.phase==="steam-accepted-observed"
        ?"Offer page reports accepted (secondary signal only)"
        :pageProgress.phase==="acceptance-failed"
          ?"Offer page could not verify acceptance (secondary signal only)"
          :String(pageProgress.phase||"page activity").replace(/-/g," ");
      lines.push(`OFFER PAGE SIGNAL: ${pageLabel}`);
    }
  }
  lines.push(`${queued} queued`);
  if(state.message&&state.message!==state.active?.purchaseProgress?.message)lines.push(state.message);
  else if(!state.active)lines.push(state.enabled?"Automatic trading is enabled.":"Automatic trading is off.");
  tradeStatus.textContent=lines.join("\n");
}
function renderSteamApiKeyStatus(configured,message){
  steamApiKeyConfigured=Boolean(configured);
  steamApiSettings.open=!steamApiKeyConfigured;
  clearSteamApiKey.disabled=!steamApiKeyConfigured;
  steamApiKeyStatus.className=`api-key-status ${steamApiKeyConfigured?"saved":""}`;
  steamApiKeyStatus.textContent=message||(
    steamApiKeyConfigured
      ?"A Steam Web API key is saved locally (hidden)."
      :"No key is saved. STN purchases require a key before QuickBuy."
  );
}
function setTradeAutomation(enabled){
  return send({type:"SET_TRADE_AUTOMATION",enabled}).then(response=>{
    if(response?.state)renderTradeAutomation(response.state);
    return response;
  });
}
function send(m){return new Promise(r=>api.runtime.sendMessage(m,r))}
function storageSetLocal(value){
  if(typeof browser!=="undefined")return browser.storage.local.set(value);
  return new Promise((resolve,reject)=>{
    try{
      api.storage.local.set(value,()=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve();
      });
    }catch(error){reject(error)}
  });
}
function storageRemoveLocal(key){
  if(typeof browser!=="undefined")return browser.storage.local.remove(key);
  return new Promise((resolve,reject)=>{
    try{
      api.storage.local.remove(key,()=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve();
      });
    }catch(error){reject(error)}
  });
}
function esc(s){return String(s??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]))}
function itemKey(name){return String(name||"").trim().replace(/^the\s+/i,"").replace(/\s+/g," ").toLowerCase()}
function isDismissed(name){return dismissedItems.has(itemKey(name))}
async function saveDismissed(){await new Promise(r=>api.storage.local.set({dismissedItems:[...dismissedItems]},r))}

function renderUnverifiedOffers(r){
  const entries=(Array.isArray(r?.offerChecks)?r.offerChecks:[])
    .filter(entry=>(entry.verification?.status||"unverified")==="unverified");
  for(const entry of entries){
    const d=document.createElement("div");
    const key=itemKey(r.name);
    d.className="result unverified";
    d.dataset.category="unverified";
    d.dataset.key=key;
    const offerUrl=safeSteamTradeUrl(entry.verification?.url||entry.tradeUrl);
    const required=Number(entry.verification?.requiredRef);
    const unitPrice=Number(entry.verification?.unitPriceRef);
    const quantity=Number(entry.verification?.quantity??entry.quantity)||1;
    const listedPrice=entry.price&&typeof entry.price==="object"?entry.price.display:entry.price;
    const requiredLine=Number.isFinite(required)
      ?`<div class="line">${Number.isFinite(unitPrice)&&quantity>1?`Unit price: ${unitPrice.toFixed(2)} ref × ${quantity} = ${required.toFixed(2)} ref`:`Required metal: ${required.toFixed(2)} ref`}</div>`
      :(listedPrice?`<div class="line">Listed price: ${esc(listedPrice)}</div>`:"");
    d.innerHTML=`<div class="name">${esc(r.name)} — ${esc(entry.listingName||"Unknown trader")}</div>${requiredLine}<div class="line reason">${esc(entry.verification?.reason||"This profitable offer could not be verified.")}</div>${offerUrl?`<a class="offer-check-link" href="${esc(offerUrl)}" target="_blank" rel="noopener">Open exact offer</a>`:"<div class=\"small\">No usable Steam offer URL was found.</div>"}`;
    unverifiedResults.appendChild(d);
  }
}

function removeExistingCard(key){
  results.querySelectorAll(`.result[data-key="${CSS.escape(key)}"]`).forEach(x=>x.remove());
}
function renderResult(r,prepend=true){
  if(!r)return;
  const key=itemKey(r.name);
  const resultId=String(r.resultId||`${key}-${Date.now()}-${Math.random().toString(36).slice(2,6)}`);
  const d=document.createElement("div");
  const dismissed=isDismissed(r.name);
  const category=dismissed?"dismissed":(r.skipped?"notfound":(r.deal?"deal":"found"));
  d.className="result "+(dismissed?"dismissed":(r.skipped?"skip":(r.deal?"deal":"loss")));
  d.dataset.category=category;
  d.dataset.key=key;
  d.dataset.resultId=resultId;
  const source=r.sourceItem||{};
  const attempts=Array.isArray(r.attempts)?r.attempts:[];
  const offerChecks=Array.isArray(r.offerChecks)?r.offerChecks:[];
  const verifiedOfferCount=offerChecks.filter(entry=>entry.verification?.status==="sufficient").length;
  let html=`<div class="result-top"><div class="name">${esc(r.name)}</div><button class="dismiss-item" title="Dismiss this item">${dismissed?"Restore":"Dismiss"}</button></div>`;
  if(r.skipped){
    html+=`<div class="line reason">${esc(r.reason)}</div>`;
  }else{
    const displaySell=r.deal?r.sellPrice:(r.pricePotentialSellPrice||r.sellPrice);
    const displayProfit=r.deal?r.profitRef:Number(r.pricePotentialProfitRef??r.profitRef);
    const dealLabel=r.verificationOverride
      ?"(multiple price-profitable listings; verification override)"
      :(r.deal?"(metal verified)":(r.unverifiedDeal?"(profitable listing; inventory not verified)":""));
    html+=`<div class="line">Buy: ${esc(r.buyPrice.display)}</div><div class="line">Backpack.tf: ${esc(displaySell.display)}</div><div class="line ${r.deal?"profit":(r.unverifiedDeal?"reason":"lossText")}">${displayProfit>=0?"+":""}${displayProfit.toFixed(2)} ref ${dealLabel}</div><div class="line listing-count">Price-profitable bot listings: <strong>${Number(r.profitableListingCount||0)}</strong> · verified: ${Number(r.verifiedProfitableListingCount||0)} · unverified: ${Number(r.unverifiedListingCount||0)} · insufficient: ${Number(r.insufficientListingCount||0)}${Number(r.badTraderListingCount||0)?` · bad traders: ${Number(r.badTraderListingCount)}`:""}${Number(r.alreadyTradingListingCount||0)?` · already trading: ${Number(r.alreadyTradingListingCount)}`:""} · item capacity: ${Number(r.priceProfitableItemCount||0)} · verified item capacity: ${Number(r.verifiedProfitableItemCount||0)}</div><div class="small">Best buyer: ${esc(r.bestListing?.listingName||"unknown")}</div>`;
    if(offerChecks.length){
      html+=`<div class="offer-checks"><div class="debug-title">Checked profitable offers:</div>`;
      offerChecks.forEach(entry=>{
        const state=entry.verification?.status||"unverified";
        const label=state==="sufficient"?"Verified — enough metal":state==="insufficient"?"Checked — insufficient metal":state==="bad-trader"?`Bad trader — already holds ${Number(entry.verification?.ownedCopies)||0} (limit ${Number(entry.verification?.wantedCopies)||1})`:state==="already-trading"?`Already trading — ${Number(entry.verification?.alreadyTradingQuantity)||0} of ${Number(entry.verification?.requestedQuantity)||1} already in offers`:"Not verified";
        const quantity=Number(entry.verification?.quantity??entry.quantity)||1;
        const unitPrice=Number(entry.verification?.unitPriceRef);
        const offerUrl=safeSteamTradeUrl(entry.verification?.url||entry.tradeUrl);
        const metalLine=entry.verification?.offeredRef!==undefined
          ?` (${Number(entry.verification.offeredRef).toFixed(2)} ref / ${Number(entry.verification.requiredRef).toFixed(2)} ref required${quantity>1&&Number.isFinite(unitPrice)?` for ${quantity}× at ${unitPrice.toFixed(2)} each`:""})`
          :"";
        html+=`<div class="offer-check ${esc(state)}"><strong>${esc(entry.listingName||"Unknown trader")}</strong> — ${esc(label)}${metalLine}${entry.verification?.reason?`<div class="small">${esc(entry.verification.reason)}</div>`:""}${offerUrl?`<a class="offer-check-link" href="${esc(offerUrl)}" target="_blank" rel="noopener">Open exact offer</a>`:""}</div>`;
      });
      if(Number(r.skippedListingCount||0)){
        html+=`<div class="small">Stopped after ${verifiedOfferCount} verified trade${verifiedOfferCount===1?"":"s"} (STN stock plus one spare); ${Number(r.skippedListingCount)} lower-priced offer${Number(r.skippedListingCount)===1?"":"s"} not checked.</div>`;
      }
      html+=`</div>`;
    }
  }
  if(source.href)html+=`<div class="market-actions"><a class="market-link" href="${esc(source.href)}" target="_blank" rel="noopener">Open STN marketplace</a></div>`;
  if(r.deal){
    html+=`<div class="market-actions trade-actions"><button class="market-action-button open-backpack-verified"${verifiedOfferCount?"":' disabled'}>Backpack.tf — highlight ${verifiedOfferCount} verified</button><button class="market-action-button force-auto-trade"${verifiedOfferCount?"":' disabled title="No offer was verified to have enough metal"'}>Auto trade (skip STN)</button></div>`;
  }
  if(attempts.length){
    html+=`<div class="debug-title">Backpack.tf:</div>`;
    attempts.forEach((a)=>{
      html+=`<div class="debug-link"><a class="open-link" href="${esc(a.url)}" target="_blank" rel="noopener">Open link</a><span class="debug-status">${esc(a.source)} — ${esc(a.status||"checked")}</span></div>`;
    });
  }
  if(source.name)html+=`<button class="retry-item" data-item="${esc(JSON.stringify(source))}">Retry this item</button>`;
  d.innerHTML=html;

  const dismiss=d.querySelector(".dismiss-item");
  dismiss.onclick=async()=>{
    if(isDismissed(r.name)){
      dismissedItems.delete(key);
      await saveDismissed();
      dismiss.textContent="Dismiss";
      d.classList.remove("dismissed");
      d.dataset.category=r.skipped?"notfound":(r.deal?"deal":"found");
    }else{
      dismissedItems.add(key);
      await saveDismissed();
      dismiss.textContent="Restore";
      d.classList.add("dismissed");
      d.dataset.category="dismissed";
    }
    updateTabCounts();
    applyFilter();
  };

  const retry=d.querySelector(".retry-item");
  if(retry)retry.onclick=async()=>{
    let item;try{item=JSON.parse(retry.dataset.item)}catch(e){return}
    const response=await send({type:"RETRY_ITEM",item});
    retry.textContent=response?.ok?"Queued!":"Retry failed";
    if(response?.ok)retry.disabled=true;
  };
  const backpackButton=d.querySelector(".open-backpack-verified");
  if(backpackButton)backpackButton.onclick=async()=>{
    backpackButton.disabled=true;
    backpackButton.textContent="Opening verified Backpack.tf pages…";
    const response=await send({type:"OPEN_VERIFIED_BACKPACK_PAGES",result:r});
    if(response?.ok){
      backpackButton.textContent=`Opened ${response.pages} page${response.pages===1?"":"s"} · highlighted ${response.highlighted}/${verifiedOfferCount}`;
      const issues=[...(response.missing||[]),...(response.errors||[])];
      if(issues.length)backpackButton.title=`Some verified listings need attention: ${issues.join("; ")}`;
    }else{
      backpackButton.disabled=false;
      backpackButton.textContent="Backpack.tf — highlight verified";
      backpackButton.title=response?.error||"Could not open the verified Backpack.tf listings.";
    }
  };
  const forceTradeButton=d.querySelector(".force-auto-trade");
  if(forceTradeButton)forceTradeButton.onclick=async()=>{
    forceTradeButton.disabled=true;
    forceTradeButton.textContent="Queuing skip-STN trade…";
    const response=await send({type:"FORCE_VERIFIED_AUTO_TRADE",result:r});
    if(response?.ok){
      forceTradeButton.textContent=`Queued ${response.offerCount} offers / ${response.quantity} existing items`;
    }else{
      forceTradeButton.disabled=false;
      forceTradeButton.textContent="Auto trade (skip STN)";
      forceTradeButton.title=response?.reason||"Could not queue an auto trade from verified offers.";
    }
  };
  if(prepend)results.prepend(d); else results.appendChild(d);
  renderUnverifiedOffers(r);
  updateTabCounts();
  applyFilter();
}
function updateTabCounts(){
  const cards=[...results.querySelectorAll(".result")];
  const found=cards.filter(x=>x.dataset.category==="found"||x.dataset.category==="deal").length;
  const good=cards.filter(x=>x.dataset.category==="deal").length;
  const notfound=cards.filter(x=>x.dataset.category==="notfound").length;
  const dismissed=cards.filter(x=>x.dataset.category==="dismissed").length;
  tabAll.textContent=cards.length-dismissed;
  tabFound.textContent=found;
  tabDeals.textContent=good;
  tabUnverified.textContent=[...unverifiedResults.querySelectorAll(".result")].filter(x=>!isDismissed(x.dataset.key)).length;
  tabNotFound.textContent=notfound;
  tabDismissed.textContent=dismissed;
  tabTraders.textContent=String(Object.values(traderHistory).filter(entry=>Number(entry?.count)>0).length);
}
function applyFilter(){
  const showTraders=activeFilter==="traders";
  const showUnverified=activeFilter==="unverified";
  results.hidden=showTraders||showUnverified;
  unverifiedResults.hidden=showTraders||!showUnverified;
  tradersView.hidden=!showTraders;
  if(showTraders||showUnverified){
    unverifiedResults.querySelectorAll(".result").forEach(card=>{
      card.style.display=isDismissed(card.dataset.key)?"none":"";
    });
    return;
  }
  results.querySelectorAll(".result").forEach(card=>{
    const c=card.dataset.category;
    const visible=activeFilter==="all"
      ? c!=="dismissed"
      : activeFilter==="found" ? (c==="found"||c==="deal")
      : activeFilter==="dismissed" ? c==="dismissed"
      : c===activeFilter;
    card.style.display=visible?"":"none";
  });
}
tabs.forEach(tab=>tab.onclick=()=>{
  activeFilter=tab.dataset.filter;
  tabs.forEach(x=>x.classList.toggle("active",x===tab));
  applyFilter();
});

function safeWebUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"||url.protocol==="http:"?url.href:"";
  }catch(e){return ""}
}
function safeSteamTradeUrl(value){
  try{
    const url=new URL(String(value||""));
    return url.protocol==="https:"&&url.hostname==="steamcommunity.com"&&/^\/tradeoffer\/new\/?$/i.test(url.pathname)
      ?url.href
      :"";
  }catch(e){return ""}
}
function renderTraders(){
  if(!tradersView)return;
  const entries=Object.entries(traderHistory||{})
    .map(([id,entry])=>({id,...entry,count:Number(entry?.count)||0}))
    .filter(entry=>entry.count>0)
    .sort((a,b)=>b.count-a.count||String(a.traderName||"").localeCompare(String(b.traderName||"")));
  if(!entries.length){
    tradersView.innerHTML='<div class="trader-empty">No traders marked yet. Use “Mark traded” on a Backpack.tf Buy Order to start a history.</div>';
    updateTabCounts();
    return;
  }
  tradersView.innerHTML=entries.map(entry=>{
    const avatar=safeWebUrl(entry.avatarUrl);
    const profile=safeWebUrl(entry.profileUrl);
    const name=esc(entry.traderName||"Unknown trader");
    const picture=avatar
      ? `<img class="trader-avatar" src="${esc(avatar)}" alt="" loading="lazy">`
      : `<div class="trader-avatar trader-avatar-fallback">${esc(String(entry.traderName||"?").trim().slice(0,1).toUpperCase())}</div>`;
    const linkedName=profile
      ? `<a href="${esc(profile)}" target="_blank" rel="noopener">${name}</a>`
      : `<span>${name}</span>`;
    const last=Number(entry.lastTradedAt);
    const when=Number.isFinite(last)&&last>0?new Date(last).toLocaleDateString():"";
    return `<div class="trader-card">${picture}<div class="trader-details"><strong>${linkedName}</strong><span>${entry.count} marked ${entry.count===1?"trade":"trades"}</span>${when?`<small>Last marked: ${esc(when)}</small>`:""}</div></div>`;
  }).join("");
  updateTabCounts();
}

function hydrate(state){
  results.innerHTML=""; unverifiedResults.innerHTML=""; checked.textContent=String(state?.checked||0); total.textContent=String(state?.total||0);
  let dealCount=0;
  const history=Array.isArray(state?.results)?state.results:[];
  for(const r of history){renderResult(r,false);if(r.deal&&!isDismissed(r.name))dealCount++;}
  deals.textContent=String(dealCount);
  updateTabCounts();
  applyFilter();
  if(state?.running) status.textContent=`Checking ${state.checked||0} / ${state.total||0} items...`;
  else if(state?.finished) status.textContent=`Finished: ${state.checked||0} / ${state.total||0} items checked — ${dealCount} hits found.`;
  else if(state?.checked) status.textContent=`Paused/stopped: ${state.checked} / ${state.total} checked — ${dealCount} hits found.`;
  else status.textContent="Open your TF2 marketplace page first.";
}

(async()=>{
  const r=await send({type:"GET_STATE"});
  if(r?.version) $("version").textContent=`v${r.version}`;
  if(r?.state) hydrate(r.state);
  if(r?.tradeAutomation)renderTradeAutomation(r.tradeAutomation);
})();

saveSteamApiKey.onclick=async()=>{
  const key=steamApiKey.value.trim();
  if(!/^[0-9a-f]{32}$/i.test(key)){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent="Enter a valid 32-character hexadecimal Steam Web API key.";
    steamApiKey.focus();
    return;
  }
  saveSteamApiKey.disabled=true;
  try{
    await storageSetLocal({steamWebApiKey:key});
    steamApiKey.value="";
    renderSteamApiKeyStatus(true,"Steam Web API key saved locally (hidden). It will be used only for direct Steam offer-state checks.");
    steamApiSettings.open=true;
  }catch(error){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent=`Could not save the Steam Web API key: ${error?.message||error}`;
  }finally{
    saveSteamApiKey.disabled=false;
  }
};

clearSteamApiKey.onclick=async()=>{
  clearSteamApiKey.disabled=true;
  try{
    await storageRemoveLocal("steamWebApiKey");
    steamApiKey.value="";
    renderSteamApiKeyStatus(false,"Saved key removed. STN purchase verification requires a key before QuickBuy.");
  }catch(error){
    steamApiKeyStatus.className="api-key-status error";
    steamApiKeyStatus.textContent=`Could not remove the saved Steam Web API key: ${error?.message||error}`;
    clearSteamApiKey.disabled=!steamApiKeyConfigured;
  }
};

// ---- Stay signed in (cookie-keeper.js reads this setting) ----------------
const keepLogins=$("keepLogins");
api.storage.local.get({keepLogins:true},v=>{keepLogins.checked=v.keepLogins!==false});
keepLogins.onchange=()=>{storageSetLocal({keepLogins:keepLogins.checked}).catch(()=>{})};

// ---- Mac confirmer settings ---------------------------------------------
const macUrl=$("macUrl"),macToken=$("macToken"),macEnabled=$("macEnabled"),saveMac=$("saveMac"),testMac=$("testMac"),macStatus=$("macStatus"),macSettings=$("macSettings");
let macTokenSaved=false;
function showMacStatus(message,kind=""){
  macStatus.className=`api-key-status ${kind}`;
  macStatus.textContent=message;
}
function normalizedMacUrl(){
  return macUrl.value.trim().replace(/\/+$/,"");
}
function loadMacSettings(){api.storage.local.get({macConfirmer:{}},v=>{
  const saved=v.macConfirmer||{};
  macUrl.value=saved.url||"";
  macEnabled.checked=Boolean(saved.enabled);
  macTokenSaved=Boolean(saved.token);
  macToken.placeholder=macTokenSaved?"Saved (hidden). Type to replace.":"";
  if(saved.url&&macTokenSaved)showMacStatus(saved.enabled?"Enabled.":"Saved but switched off.","saved");
})}
loadMacSettings();
// The launcher fills these in shortly after the browser starts.
api.storage.onChanged.addListener((changes,area)=>{if(area==="local"&&changes.macConfirmer)loadMacSettings()});
saveMac.onclick=async()=>{
  const url=normalizedMacUrl();
  const token=macToken.value.trim()||(macTokenSaved?(await new Promise(r=>api.storage.local.get({macConfirmer:{}},v=>r(v.macConfirmer?.token||"")))):"");
  if(!/^https?:\/\/[^\s/]+(:\d+)?$/i.test(url)){
    showMacStatus("Enter the address like http://192.168.1.50:8765","error");
    macUrl.focus();
    return;
  }
  if(!token){
    showMacStatus("Enter the token the Mac server printed when it started.","error");
    macToken.focus();
    return;
  }
  try{
    await storageSetLocal({macConfirmer:{enabled:macEnabled.checked,url,token}});
    macToken.value="";
    macTokenSaved=true;
    macToken.placeholder="Saved (hidden). Type to replace.";
    showMacStatus(macEnabled.checked?"Saved. Bot offers waiting for confirmation will be sent to the Mac.":"Saved, but switched off.","saved");
  }catch(error){
    showMacStatus(`Could not save: ${error?.message||error}`,"error");
  }
};
testMac.onclick=async()=>{
  const url=normalizedMacUrl();
  const token=macToken.value.trim()||(macTokenSaved?(await new Promise(r=>api.storage.local.get({macConfirmer:{}},v=>r(v.macConfirmer?.token||"")))):"");
  if(!url){showMacStatus("Enter the Mac server address first.","error");return}
  testMac.disabled=true;
  showMacStatus("Connecting…");
  const call=async path=>{
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),6000);
    try{
      const response=await fetch(`${url}${path}`,{headers:{"X-Confirm-Token":token},cache:"no-store",credentials:"omit",signal:controller.signal});
      return {status:response.status,payload:await response.json().catch(()=>({}))};
    }finally{clearTimeout(timer)}
  };
  try{
    const ping=await call("/ping");
    if(ping.status!==200)throw new Error(`the server answered HTTP ${ping.status}`);
    const state=await call("/status");
    if(state.status===401)return showMacStatus("The Mac server is reachable, but it rejected the token.","error");
    if(state.status!==200)throw new Error(state.payload?.error||`HTTP ${state.status}`);
    const s=state.payload;
    showMacStatus(
      `Connected${s.dryRun?" (dry run: no clicks)":""}. ${s.paused?`PAUSED: ${s.paused}`:s.busy?"Busy accepting a trade.":"Idle."} `+
      `${s.waiting} waiting, ${s.confirmedLastHour}/${s.hourlyLimit} confirmed in the last hour.`,
      s.paused?"error":"saved"
    );
  }catch(error){
    showMacStatus(
      error?.name==="AbortError"
        ?"No answer within 6 seconds. Check the Mac's IP address, that the server is running, and the Mac firewall."
        :`Could not reach the Mac server: ${error?.message||error}`,
      "error"
    );
  }finally{
    testMac.disabled=false;
  }
};

autoTrades.onchange=async()=>{
  if(autoTrades.checked&&!steamApiKeyConfigured){
    autoTrades.checked=false;
    tradeStatus.textContent="Save a Steam Web API key before enabling STN purchases. The key is checked before QuickBuy; manual mobile confirmation is still required.";
    steamApiSettings.open=true;
    return;
  }
  if(autoTrades.checked&&!window.confirm("This enables automatic STN purchases and bot offers only for price-profitable listings verified to have enough metal. Steam Web API state 3 (Accepted) is required before bot offers are sent. You must still approve mobile confirmations yourself. Continue?")){
    autoTrades.checked=false;
    return;
  }
  const response=await setTradeAutomation(autoTrades.checked);
  if(!response?.ok){
    autoTrades.checked=false;
    tradeStatus.textContent="Could not update automatic trading. Please try again.";
  }
};

volume.oninput=()=>{
  const v=Math.max(0,Math.min(100,Number(volume.value)||0));
  volumeValue.textContent=`${v}%`;
  api.storage.local.set({notificationVolume:v/100});
  send({type:"SET_VOLUME",volume:v/100});
};

scan.onclick=async()=>{
  api.storage.local.set({keyRate:+rate.value||63});
  const r=await send({type:"START_SCAN",keyRate:+rate.value||63,notificationVolume:(Number(volume.value)||0)/100,autoTradesEnabled:autoTrades.checked});
  if(!r?.ok){status.textContent=r?.error||"Could not start scan.";return}
  results.innerHTML="";
  unverifiedResults.innerHTML="";
  activeFilter="all"; tabs.forEach(x=>x.classList.toggle("active",x.dataset.filter==="all"));
  applyFilter();
  updateTabCounts();
  checked.textContent="0";
  deals.textContent="0";
  total.textContent=r.total;
  status.textContent=`Checking 0 / ${r.total} items...`;
};
stop.onclick=async()=>{await send({type:"STOP_SCAN"});status.textContent=`Stopped at ${checked.textContent} / ${total.textContent}. Progress saved.`};

api.runtime.onMessage.addListener(async m=>{
  if(m.type==="TRADE_AUTOMATION_STATUS"){
    renderTradeAutomation(m.state);
  }
  if(m.type==="OFFER_CHECK_PROGRESS"){
    status.textContent=`Checking profitable offer ${m.checked} / ${m.total} for ${m.itemName} — ${m.traderName}`;
  }
  if(m.type==="SCAN_RESULT"){
    checked.textContent=m.checked;
    renderResult(m.result,true);
    if(m.result.deal&&!isDismissed(m.result.name)) deals.textContent=+deals.textContent+1;
    status.textContent=`${m.checked} / ${m.total} checked`;
  }
  if(m.type==="SCAN_FINISHED"){
    status.textContent=`Finished: ${m.checked} / ${m.total} items checked.`;
  }
});

api.storage.onChanged?.addListener((changes,area)=>{
  if(area!=="local"||!changes.tf2ArbTraderHistory)return;
  const value=changes.tf2ArbTraderHistory.newValue;
  traderHistory=value&&typeof value==="object"?value:{};
  renderTraders();
});
