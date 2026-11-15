(() => {
  const api=typeof browser!=="undefined"?browser:chrome;
  const notifyBackground=message=>{
    try{
      const response=api.runtime.sendMessage(message);
      if(response&&typeof response.catch==="function"){
        response.catch(error=>console.error("Arbitrage background message failed.",error));
      }
    }catch(error){
      console.error("Arbitrage background message failed.",error);
    }
  };

  function readBuyPage(){
    if(isScrapTf())return readScrapTfPage();
    const nodes=[...document.querySelectorAll("a.mp-item-box-wrap")];
    const items=[];
    for(const node of nodes){
      const n=node.querySelector(".item-name"),p=node.querySelector(".item-price");
      if(!n||!p)continue;
      const name=n.textContent.trim(),price=p.textContent.trim();
      if(!name||!price)continue;
      const s=node.querySelector(".item-stock b");
      items.push({name,price,stock:s?Number(s.textContent.trim()):null,href:node.getAttribute("href")||""});
    }
    return items;
  }

  // ---- scrap.tf ("Buy Hats" page, https://scrap.tf/buy/hats, needs a Steam login)
  // Every item for sale is a <div class="item" data-item-value="<scrap>"> inside
  // #buy-container (the user's own backpack is in #sell-container and ignored).
  // data-title holds the name as HTML, the quality is a "quality<N>" class, the
  // visible price ("5 keys, 53 ref") is in .item-value-indicator and the number
  // for sale in data-num-available.
  function isScrapTf(){return /(?:^|\.)scrap\.tf$/i.test(location.hostname)}
  const SCRAP_QUALITY_PREFIX={1:"Genuine",3:"Vintage",13:"Haunted",14:"Collector's"};
  function scrapItemQuality(node){
    return Number((String(node.className).match(/\bquality(\d+)\b/)||[])[1])||0;
  }
  function scrapItemName(node){
    let name=new DOMParser().parseFromString(node.getAttribute("data-title")||"","text/html").body.textContent
      .trim().replace(/\s+/g," ");
    // Strange items already carry "Strange " in the title; Genuine, Vintage and
    // the like do not, and Backpack.tf needs the quality.
    const prefix=SCRAP_QUALITY_PREFIX[scrapItemQuality(node)];
    if(name&&prefix&&!name.toLowerCase().startsWith(prefix.toLowerCase()+" "))name=prefix+" "+name;
    return name;
  }
  function readScrapTfPage(){
    const nodes=[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")];
    const cheapest=new Map();
    for(const node of nodes){
      // Unusuals need their effect to be found on Backpack.tf and scrap.tf does
      // not name it, so they cannot be compared.
      if(scrapItemQuality(node)===5)continue;
      const name=scrapItemName(node);
      const value=Number(node.getAttribute("data-item-value"));
      const price=(node.querySelector(".item-value-indicator")?.textContent||"").trim().replace(/\s+/g," ");
      if(!name||!Number.isFinite(value)||!/(?:keys?|ref)/i.test(price))continue;
      const stock=Number(node.getAttribute("data-num-available"));
      let header=node.closest(".banking-category");
      while(header&&!header.classList.contains("items-category-header"))header=header.previousElementSibling;
      const key=normalizeName(name);
      const previous=cheapest.get(key);
      // The same item can be listed twice (for example one discounted copy);
      // only the cheapest copy matters for the comparison.
      if(previous&&previous.scrapValue<=value)continue;
      cheapest.set(key,{
        name,price,
        stock:Number.isFinite(stock)&&stock>0?stock:1,
        href:location.href.split("#")[0],
        source:"scrap.tf",
        category:header?.textContent.trim()||"",
        scrapValue:value
      });
    }
    return [...cheapest.values()];
  }

  // ---- scrap.tf buying. The page is driven the way a person would: click the
  // item (once per copy wanted), then the cart button (#trade-btn). scrap.tf then
  // queues the trade: ".mm-queue-processing" is shown while it prepares it and
  // ".mm-queue-ready" once its bot has sent the Steam offer. The offer id is the
  // page's own ScrapTF.NewQueue.TradeOfferID, which is what its "Open Trade
  // Offer" button opens; the background script opens that offer itself.
  const scrapSleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  function scrapShown(el){
    if(!el||!el.getClientRects().length)return false;
    const style=getComputedStyle(el);
    return style.display!=="none"&&style.visibility!=="hidden";
  }
  function scrapSelection(){
    return [...document.querySelectorAll(".selected-item")]
      .filter(node=>!node.closest("#sell-container"))
      .map(node=>({
        node,
        name:scrapItemName(node),
        count:Math.max(1,parseInt(node.getAttribute("data-num-selected")||"1",10)||1),
        value:Number(node.getAttribute("data-item-value"))
      }));
  }
  function scrapSelectedCount(){return scrapSelection().reduce((sum,entry)=>sum+entry.count,0)}

  // The page's own search box ("Search for items", input.inventory-search) filters
  // the item list the way a person would look for one hat. The page has one for
  // the user's backpack (#sell-container) and one for the shop; the shop's is used.
  function scrapSearchInput(){
    const inputs=[...document.querySelectorAll("input.inventory-search")];
    return inputs.find(input=>!input.closest("#sell-container"))||null;
  }
  // The text typed is the item's name without the quality word that readScrapTfPage
  // adds (scrap.tf titles do not carry "Genuine", "Vintage", ...).
  function scrapSearchText(name){
    return String(name||"").replace(/^(?:Genuine|Vintage|Haunted|Collector's)\s+/i,"").trim();
  }
  // Puts `text` in the box and fires the events a typed key would: keydown, the
  // input event, keyup (with the key's code, which some page handlers read) and
  // change.
  function scrapSetSearch(input,text){
    const last=text.slice(-1);
    const code=last?last.toUpperCase().charCodeAt(0):8;
    const keyInit={bubbles:true,cancelable:true,key:last||"Backspace",keyCode:code,which:code};
    input.dispatchEvent(new KeyboardEvent("keydown",keyInit));
    const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")?.set;
    if(setter)setter.call(input,text);else input.value=text;
    input.dispatchEvent(new Event("input",{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent("keyup",keyInit));
    input.dispatchEvent(new Event("change",{bubbles:true}));
  }
  // The same, but through the browser's own text insertion (as if pasted), which
  // fires the real input events. Used when the page did not react to the first way.
  function scrapTypeSearch(input,text){
    try{
      input.focus();
      input.select();
      return document.execCommand("insertText",false,text);
    }catch(error){return false}
  }
  // The page's filter has reacted when it hides some tiles of its long list.
  function scrapFilterApplied(){
    const tiles=[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")];
    return tiles.length<5||tiles.some(node=>!scrapShown(node));
  }
  // Types the item's name into the search box and waits until the list shows it.
  // `applied` says whether the page's filter reacted (hid other tiles).
  async function scrapSearch(name){
    const input=scrapSearchInput();
    if(!input)return {used:false};
    const text=scrapSearchText(name);
    if(!text)return {used:false};
    const target=normalizeName(name);
    const matching=()=>[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")]
      .filter(node=>normalizeName(scrapItemName(node))===target);
    if(input.value!==text){
      try{input.focus()}catch(error){}
      scrapSetSearch(input,text);
      await scrapSleep(500);
      if(!scrapFilterApplied()){
        // The page ignored the events: type it in through the browser instead.
        scrapTypeSearch(input,text);
        await scrapSleep(500);
      }
    }
    const deadline=Date.now()+4000;
    let found=false;
    while(Date.now()<deadline){
      await scrapSleep(250);
      if(matching().some(scrapShown)){found=true;break}
    }
    // Let the filter finish hiding the other items before anything is clicked.
    if(found)await scrapSleep(400);
    return {used:true,found,applied:scrapFilterApplied(),boxText:input.value};
  }
  function scrapClearSearch(){
    const input=scrapSearchInput();
    if(!input||!input.value)return;
    scrapSetSearch(input,"");
    // A page script can put the text back or ignore the events; set it directly.
    if(input.value)input.value="";
  }
  function scrapCountShown(){
    return [...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")].filter(scrapShown).length;
  }
  // Empties the search box and waits until the list shows as many items as it did
  // before the search (the filter is lifted), trying the clear a second time.
  async function scrapRestoreSearch(shownBefore){
    for(let attempt=0;attempt<2;attempt++){
      scrapClearSearch();
      const deadline=Date.now()+1500;
      while(Date.now()<deadline){
        const input=scrapSearchInput();
        if((!input||!input.value)&&scrapCountShown()>=shownBefore)return true;
        await scrapSleep(150);
      }
    }
    console.warn("TF2 Arbitrage: the scrap.tf search box or item list was not restored after the purchase attempt.");
    return false;
  }

  // The search text never stays behind: it is cleared however the attempt ends
  // (item bought, price rose, nothing selectable, checkout unavailable, error).
  async function scrapBuy(name,quantity,maxScrapValue){
    const shownBefore=scrapCountShown();
    try{
      return await scrapBuyWithSearch(name,quantity,maxScrapValue);
    }finally{
      await scrapRestoreSearch(shownBefore);
    }
  }

  async function scrapBuyWithSearch(name,quantity,maxScrapValue){
    const wanted=Math.max(1,Math.floor(Number(quantity))||1);
    const target=normalizeName(name);
    const allTiles=[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")];
    if(!allTiles.length){
      return {ok:false,status:"not-ready",reason:"The scrap.tf item list is not on the page (still loading, or you are not signed in to scrap.tf)."};
    }
    // Filter the shop to this hat with the page's search box first.
    const search=await scrapSearch(name);
    let tiles=[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")]
      .filter(node=>normalizeName(scrapItemName(node))===target)
      .sort((a,b)=>Number(a.getAttribute("data-item-value"))-Number(b.getAttribute("data-item-value")));
    if(search.used){
      // After the search, the copies it left showing are the ones to click.
      const showing=tiles.filter(scrapShown);
      if(showing.length)tiles=showing;
    }
    if(!tiles.length){
      return {ok:false,reason:`${name} is no longer listed on scrap.tf.`};
    }
    const limit=Number(maxScrapValue);
    if(Number.isFinite(limit)&&limit>0){
      const cheap=tiles.filter(node=>Number(node.getAttribute("data-item-value"))<=limit);
      if(!cheap.length){
        const now=Number(tiles[0].getAttribute("data-item-value"));
        return {ok:false,reason:`The scrap.tf price of ${name} rose to ${now} scrap (it was ${limit} scrap when it was checked). Not buying.`};
      }
      tiles=cheap;
    }
    // Nothing may be selected already (for example left over from a reload).
    if(scrapSelectedCount()>0)return {ok:false,reason:"Items were already selected on the scrap.tf page. Not buying."};

    let selected=0;
    for(const tile of tiles){
      if(selected>=wanted)break;
      if(tile.classList.contains("itemgroup-invalid-bot"))continue;
      // A tile that stands for several copies takes one click per copy. A
      // single copy is toggled by its click, so it must only be clicked once.
      const grouped=tile.hasAttribute("data-item-group-hash");
      const available=grouped?Math.max(1,parseInt(tile.getAttribute("data-num-available")||"1",10)||1):1;
      const room=Math.min(available,wanted-selected);
      for(let index=0;index<room;index++){
        const before=scrapSelectedCount();
        tile.click();
        await scrapSleep(180);
        // scrap.tf stops accepting copies when no single bot holds that many;
        // the rest is bought in a later batch.
        if(scrapSelectedCount()<=before)break;
        selected++;
      }
    }
    const chosen=scrapSelection();
    const foreign=chosen.find(entry=>normalizeName(entry.name)!==target);
    if(foreign)return {ok:false,reason:`scrap.tf selected "${foreign.name}" instead of ${name}. Not buying.`};
    const selectedCount=scrapSelectedCount();
    if(!selectedCount)return {ok:false,reason:`scrap.tf would not let ${name} be selected (it may have just been sold or reserved).`};
    const button=document.querySelector("#trade-btn");
    if(!button||button.disabled||button.classList.contains("disabled")){
      return {ok:false,reason:"scrap.tf's checkout button is not available (not enough metal in your backpack, or the item cannot be bought)."};
    }
    button.click();
    return {ok:true,selected:selectedCount};
  }
  function scrapTradeOfferId(){
    let id="";
    try{id=String(window.wrappedJSObject?.ScrapTF?.NewQueue?.TradeOfferID??"")}catch(error){id=""}
    if(!(Number(id)>0)){
      // The page object is not reachable from here: let the page copy the id to
      // an attribute the content script can read.
      try{
        const script=document.createElement("script");
        script.textContent='document.documentElement.setAttribute("data-tf2arb-scrap-offer",String(window.ScrapTF&&ScrapTF.NewQueue?ScrapTF.NewQueue.TradeOfferID:""))';
        document.documentElement.appendChild(script);
        script.remove();
        id=document.documentElement.getAttribute("data-tf2arb-scrap-offer")||"";
      }catch(error){id=""}
    }
    return Number(id)>0?String(Math.floor(Number(id))):"";
  }
  function scrapQueueState(){
    const compact=text=>String(text||"").replace(/\s+/g," ").trim().slice(0,300);
    const modal=document.querySelector("#generic-modal");
    if(scrapShown(modal)&&modal.querySelector(".flat-dialog.dia-error")){
      return {status:"error",text:compact(modal.querySelector(".flat-dialog-inside")?.textContent)||"scrap.tf reported a trade error."};
    }
    const crouton=document.querySelector(".crouton");
    if(scrapShown(crouton)&&crouton.classList.contains("alert-error")){
      return {status:"error",text:compact(crouton.textContent)||"scrap.tf reported an error."};
    }
    if(scrapShown(document.querySelector(".mm-queue-ready"))){
      if(!scrapShown(document.querySelector(".mm-queue-trade-confirmed")))return {status:"confirming"};
      return {status:"ready",offerId:scrapTradeOfferId()};
    }
    if(scrapShown(document.querySelector(".mm-queue-processing"))){
      return {status:"processing",text:compact(document.querySelector(".mm-queue-status")?.textContent)};
    }
    return {status:"idle"};
  }
  function scrapCancelQueue(){
    const button=[...document.querySelectorAll(".mm-queue-cancel")].find(scrapShown);
    if(!button||button.disabled)return {ok:false};
    button.click();
    return {ok:true};
  }

  // An STN item page (/item/tf2/<name>) shows "Buy it for:" with the price in
  // bold below it, then "<n> in Stock". Used to refresh a saved item's price.
  function readStnItemPage(){
    if(!/^(?:www\.)?stntrading\.eu$/i.test(location.hostname)||!location.pathname.startsWith("/item/")){
      return {status:"failed",reason:"This is not an STN item page."};
    }
    const label=[...document.querySelectorAll("p")].find(p=>/^\s*buy it for\s*:?\s*$/i.test(p.textContent));
    const box=label?.parentElement;
    const price=box?.querySelector("b")?.textContent.trim().replace(/\s+/g," ")||"";
    if(!price||!/(?:keys?|ref)/i.test(price))return {status:"loading",reason:"The STN price is not visible yet."};
    const stockText=[...box.querySelectorAll("p")].map(p=>p.textContent).find(text=>/\bin stock\b/i.test(text))||"";
    const stock=Number((stockText.match(/(\d+)\s*in stock/i)||[])[1]);
    return {status:"ready",price,stock:Number.isFinite(stock)?stock:0};
  }

  function approx(text){
    const k=String(text).match(/([\d.]+)\s*keys?/i),r=String(text).match(/([\d.]+)\s*ref/i);
    return(k?+k[1]:0)*63+(r?+r[1]:0);
  }
  function normalizeName(name){return String(name||"").trim().replace(/^the\s+/i,"").toLowerCase().replace(/\s+/g," ")}
  function getListingDescription(listing,item){
    const attr=item?.dataset?.listing_comment||"";
    const quote=[...listing.querySelectorAll(".quote-box p")].map(x=>x.textContent.trim()).filter(Boolean).join(" ");
    return[attr,quote].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
  }
  function getListingIntent(listing,item){
    // Backpack.tf's own marker (data-listing_intent) is authoritative. The
    // trader's free-text description is only a fallback, because a sell order
    // can easily say "I'm buying ..." in its text.
    const directionLabel=listing?.querySelector(".listing-intent, .listing-type, [data-listing-intent]");
    const metadata=String(
      item?.dataset?.listing_intent||
      item?.dataset?.intent||
      listing?.dataset?.listing_intent||
      directionLabel?.dataset?.listingIntent||
      directionLabel?.textContent||
      ""
    ).normalize("NFKC").trim().toLowerCase();
    const metaBuy=/\b(?:buy|buying|buy order)\b/.test(metadata);
    const metaSell=/\b(?:sell|selling|sell order)\b/.test(metadata);
    if(metaBuy!==metaSell)return metaBuy?"buy":"sell";
    if(metaBuy&&metaSell)return "";

    const description=getListingDescription(listing,item)
      .normalize("NFKC")
      .replace(/[\u200B-\u200D\uFEFF]/g,"")
      .toLowerCase();
    const saysBuying=/\b(?:i\s+am|i['’]m|im|we\s+are|we['’]re)\s+buying\b/.test(description);
    const saysSelling=/\b(?:i\s+am|i['’]m|im|we\s+are|we['’]re)\s+selling\b/.test(description);
    if(saysBuying!==saysSelling)return saysBuying?"buy":"sell";
    return "";
  }
  function badDescription(description){
    const combined=String(description||"").normalize("NFKC").replace(/[\uFEFF\u200B-\u200D\u2060]/g, "").toLowerCase().replace(/\s+/g," ").trim();

    // Trader descriptions are often written as exclusions rather than requests:
    // "no paint", "don't want painted", "no craft #", etc.  Those should NOT
    // make an otherwise normal Buy Order disappear.  We first remove common
    // negated special-attribute phrases, then look for positive requests.
    let positive=combined;
    const negatedPatterns=[
      /\b(?:no|without)\s+(?:any\s+)?(?:paint|painted|painted items?|painted hats?)\b/g,
      /\b(?:don't|dont|do not|doesn't|doesnt|not|never|won't|wont)\s+(?:want|buy|buying|need|needs|accept|accepting|take|taking)?\s*(?:any\s+)?(?:paint|painted|painted items?|painted hats?)\b/g,
      /\b(?:no|without)\s+(?:any\s+)?(?:custom\s+parts?|strange\s+parts?|killstreak\s+parts?|parts?)\b/g,
      /\b(?:don't|dont|do not|doesn't|doesnt|not|never|won't|wont)\s+(?:want|buy|buying|need|needs|accept|accepting|take|taking)?\s*(?:any\s+)?(?:custom\s+parts?|strange\s+parts?|killstreak\s+parts?|parts?)\b/g,
      /\b(?:no|without)\s+(?:a\s+)?(?:craft\s*(?:number|#)|craftnumber|craft\s*#|craft\s*no\.?|craft\s*id)\b/g,
      /\b(?:don't|dont|do not|doesn't|doesnt|not|never|won't|wont)\s+(?:want|buy|buying|need|needs|accept|accepting|take|taking)?\s*(?:a\s+)?(?:craft\s*(?:number|#)|craftnumber|craft\s*#|craft\s*no\.?|craft\s*id)\b/g
    ];
    for(const re of negatedPatterns)positive=positive.replace(re," ");
    positive=positive.replace(/\s+/g," ").trim();

    // Foot Prints are never accepted as a generic order.
    if(/\bfoot\s+prints\b/i.test(combined))return ["foot prints"];

    const matches=[];
    const add=(label,re)=>{if(re.test(positive))matches.push(label)};

    // Explicit special attributes.
    add("painted item", /\bpainted(?: hat| item| items| with)?\b/);
    add("paint name", /\bpaint(?:ed)?\s+(?:name|color|colour)\b/);
    add("paint metadata", /\bpaint(?:ed)?\s*[:=]\s*/);
    add("spelled item", /\bspelled\b/);
    // VFB and any spell-related language are always specialized orders for
    // this scanner. A normal generic Buy Order should never depend on a
    // Halloween spell or VFB variant. Keep this intentionally broad because
    // traders use many spell names and shorthand.
    add("VFB", /\bvfb\b/);
    add("spell-related", /\bspell(?:s|ed|ing|led)?\b|\bhalloween\s+spell(?:s)?\b|\bspelled\b|\bspeled\b|\bspeld\b/);

    // Some traders use abbreviated level wording or unusual phrasing such as
    // "ONLY LVL's". For this scanner, ANY explicit level/lvl wording in the
    // Buy Order description is specialized and should be rejected. This is
    // intentionally broader than the older specific-number check.
    add("level/lvl request", /\blvls?\b|\blevels?\b/i);

    // "Specifically" is another signal used in specialized variant requests,
    // and Voices From Below is a named Halloween spell/attribute. Reject both
    // anywhere in the description, including when surrounded by decorative or
    // otherwise unusual trader formatting (NFKC + zero-width cleanup above).
    add("specifically/Voices From Below", /\bspecifically\b|\bvoices\s+from\s+below\b/i);
    // These shorthand categories are used by specialized traders and are not
    // generic Buy Orders for the item itself. Match flexible spacing around "/"
    // so variants like "CC/Spec", "CC / Spec", and "DJ / PP / SS" are caught.
    add("CC/Spec", /(?:\bc\s*c\b|\bс\s*с\b)\s*\/\s*spec\b/);
    add("DJ/PP/SS", /\bdj\s*\/\s*(?:pp\s*\/\s*ss|ss\s*\/\s*pp)\b/);

    // Human traders (people, not bots) are ignored: "human trader", "I'm
    // human", "real person", "not a bot", "no bots", "manual trader". A
    // description that says it is NOT human ("not a human") is left alone.
    const humanText=combined.replace(/\b(?:not|isn['’]?t|aren['’]?t|no|non|never)[\s-]+(?:a\s+|an\s+)?(?:human|person|real\s+person)s?\b/g," ");
    if(
      /\bhumans?\b/.test(humanText)||
      /\b(?:real|actual|live)\s+(?:person|people|trader|player|user)\b/.test(humanText)||
      /\b(?:not|isn['’]?t|aren['’]?t|am\s+not|i['’]?m\s+not|im\s+not)\s+(?:a\s+)?bots?\b/.test(humanText)||
      /\bno\s+bots?\b/.test(humanText)||
      /\bmanual(?:ly)?\s+(?:trader|trading|trades?|offers?|accept(?:ing)?)\b/.test(humanText)
    )matches.push("human trader");

    // Specialized trader shorthand. These compact codes are commonly used
    // to quote prices for Halloween/spell/paint/variant categories rather than
    // the generic item itself. NFKC above intentionally handles the funky
    // mathematical-bold Unicode used by many Backpack.tf traders.
    const specialShorthandCodes = /\b(?:hh|ro|ts|cg|vv|bp|gg|cc|spec|dj|pp|vfb|ss)\b/i;
    if(specialShorthandCodes.test(positive))matches.push("specialized shorthand");

    // Some traders say they will outbid another buyer by a fixed amount for
    // any spelled item, including common misspellings such as "SPELED".
    // Treat the whole pattern as specialized rather than allowing it through
    // merely because the item name itself is normal.
    const outbidSpell = /\boutbid(?:ding)?\b[\s\S]{0,120}\b(?:spell(?:s|ed|ing|led)?|spelled|speled|speld)\b|\b(?:spell(?:s|ed|ing|led)?|spelled|speled|speld)\b[\s\S]{0,120}\boutbid(?:ding)?\b/i;
    if(outbidSpell.test(positive))matches.push("outbidding spelled items");
    add("custom parts", /\bcustom parts?\b/);
    add("strange parts", /\bstrange parts?\b/);
    add("killstreak parts", /\bkillstreak parts?\b/);
    add("professional killstreak", /\bprofessional killstreak\b/);
    add("specialized killstreak", /\bspecialized killstreak\b/);
    add("killstreak kit", /\bkillstreak kits?\b/);
    add("festivized", /\bfestivized(?: weapon| item)?\b/);
    add("craft number", /\bcraft\s*(?:number|#|no\.?|id)\b|\bcraftnumber\b/);

    // A plain mention of "paint" or "parts" is not enough.  It becomes a
    // special-order signal when it appears in an obvious request context.
    const request=/\b(?:b|b>|buy|buying|want|wants|wanted|need|needs|looking for|lf|seeking|offer|offering|pay|paying|accept|accepting)\b/;
    if(request.test(positive)&&/\bpaint(?:ed)?\b/.test(positive))matches.push("paint request");
    if(request.test(positive)&&/\bparts?\b/.test(positive))matches.push("parts request");
    if(request.test(positive)&&/\bcraft\s*(?:number|#|no\.?|id)\b|\bcraftnumber\b/.test(positive))matches.push("craft-number request");

    // Compressed trader shorthand such as "paint, certain parts" is a strong
    // signal even without a verb.  This check is deliberately performed only
    // after negated phrases have been removed.
    if(/\bpaint(?:ed)?\b/.test(positive)&&/\bparts?\b/.test(positive))matches.push("paint/parts request");

    // Some traders avoid the words "paint" or "painted" entirely and use
    // compact shorthand such as "⚫️black--28 refined".  Treat a color/paint
    // name followed by a custom price as a specialized request.  We deliberately
    // require a price separator and a currency unit so ordinary prose mentioning
    // a color does not get rejected.
    const colorPriceShorthand=/(?:^|\s)(?:[⚫⚪🔴🟠🟡🟢🔵🟣🟤🩷🩵🩶🖤🤍❤️🧡💛💚💙💜🤎💗💖💞💓💘💝💟💌\uFE0F\u200D]*\s*)?(?:black|white|red|orange|yellow|green|blue|purple|pink|brown|grey|gray|cyan|teal|lime|navy|violet|magenta)(?:\s*[-–—:]{1,3}\s*|\s+)(?:\d+(?:\.\d+)?)\s*(?:ref(?:ined)?|keys?|buds?|earbuds?)\b/i;
    if(colorPriceShorthand.test(positive))matches.push("paint/color price shorthand");

    // Named paints / Halloween spells can be hidden inside otherwise-normal
    // looking Buy Orders. Example: "Die Job for 5 keys. Sinister Staining
    // for 6 keys". These are not generic item orders; they are requests for
    // particular painted/spelled variants. We require the named attribute to
    // be paired with a price/request pattern so ordinary discussion of a paint
    // name is not enough by itself.
    const namedAttributes=[
      "A Color Similar to Slate","A Deep Commitment to Purple","A Distinctive Lack of Hue",
      "A Mann's Mint","After Eight","An Air of Debonair","An Extraordinary Abundance of Tinge",
      "Australium Gold","Color No. 216-190-216","Dark Salmon Injustice","Drably Olive",
      "Indubitably Green","Mann Co. Orange","Muskelmannbraun","Noble Hatter's Violet",
      "Peculiarly Drab Tincture","Pink as Hell","Radigan Conagher Brown","Team Spirit",
      "The Bitter Taste of Defeat and Lime","The Color of a Gentlemann's Business Pants",
      "Ye Olde Rustic Colour","Zepheniah's Greed","After Eight","Balaclavas Are Forever",
      "Cream Spirit","Operator's Overalls","Waterlogged Lab Coat",
      "Die Job","Sinister Staining","Chromatic Corruption","Spectral Spectrum",
      "Putrescent Pigmentation","Exorcism","Voices from Below","Horseless Headless Horsemann's Headless Head",
      "Aged Moustache Grey","Dark Salmon Injustice","Mann's Mint"
    ];
    const escapedAttributes=namedAttributes
      .filter((v,i,a)=>a.indexOf(v)===i)
      .sort((a,b)=>b.length-a.length)
      .map(v=>v.replace(/[.*+?^${}()|[\]\\]/g,"\\$&"));
    const namedAttributePrice=new RegExp(
      "(?:^|\\b)(?:"+escapedAttributes.join("|")+")(?=\\b)(?:\\s*(?:-|–|—|:|=|for|at|\\|)\\s*\\d+(?:\\.\\d+)?\\s*(?:ref(?:ined)?|keys?|buds?|earbuds?)\\b|\\s+\\d+(?:\\.\\d+)?\\s*(?:ref(?:ined)?|keys?|buds?|earbuds?)\\b)",
      "i"
    );
    if(namedAttributePrice.test(positive))matches.push("named paint/spell price");

    // Headless/Horseless Headless Horseman references indicate the trader is
    // targeting a special Halloween/Horseless Headless Horseman variant, not
    // a generic version of the cosmetic. Reject either term anywhere in the
    // positive listing text.
    if(/\bheadless\b/i.test(positive)||/\bhorseman\b/i.test(positive))
      matches.push("Headless/Horseman special variant");

    // "Spectral" is a special Halloween-spell/paint family and should never
    // be treated as a generic item request. Traders may write only "spectral",
    // or use a more specific form such as "Spectral Spectrum", "Spectral Flame",
    // or "spectral fire". Keep this broad because the user explicitly does not
    // want any Spectral variants included in generic arbitrage.
    if(/\bspectral\b/i.test(positive))matches.push("spectral item");

    // Some painted-item traders deliberately keep the description extremely
    // short. For example, a Buy Order can simply say "Gold" to mean
    // "Gold-painted item". Treat a standalone paint/color word as a
    // specialization instead of requiring the trader to spell out "paint".
    const barePaintWord=/^(?:black|white|pink|lime|green|purple|gold|yellow|orange|red|blue|brown|grey|gray|cyan|teal|navy|violet|magenta|after\s*eight|team\s*spirit|value(?:\s+of\s+the)?|a\s+distinctive\s+lack\s+of\s+hue|an\s+extraordinary\s+abundance\s+of\s+tinge|a\s+deep\s+commitment\s+to\s+purple|mann(?:'|\u2019)?s\s+mint|operator(?:'|\u2019)?s\s+overalls|cream\s+spirit|waterlogged\s+lab\s+coat)$/i;
    const explicitPaintRequest=/(?:\bpaint(?:ed|ing)?\b|\bpaint\b).{0,40}\b(?:item|hat|hats|cosmetic|cosmetics)\b|\b(?:item|hat|hats|cosmetic|cosmetics)\b.{0,40}\bpaint(?:ed|ing)?\b/i;
    if(barePaintWord.test(positive)||explicitPaintRequest.test(positive))matches.push("painted item request");

    // Specific item levels are another form of specialized Buy Order.
    // IMPORTANT: do not use the item's data-summary here (for example,
    // "Level 1-100 Hat" is normal TF2 item metadata). We only inspect the
    // listing name/comment/description supplied to this function.
    // Also ignore generic wording such as "any level" or "all levels".
    const specificLevel=/(?:\b(?:level|lvl)\s*[#:]?\s*\d{1,3}\b|\b(?:level|lvl)[-_]?\d{1,3}\b)/i;
    const levelRequest=/(?:\b(?:buy|buying|b>|want|wants|wanted|need|needs|looking for|lf|seeking|offer|offering|pay|paying|accept|accepting)\b[^.\n]{0,100}\b(?:level|lvl)\s*[#:]?\s*\d{1,3}\b|\b(?:only|specific|certain|special)\s+(?:a\s+)?(?:level|lvl)\s*[#:]?\s*\d{1,3}\b|\b(?:level|lvl)\s*[#:]?\s*\d{1,3}\s+(?:only|offers?|version|versions)\b)/i;
    const genericLevel=/(?:\b(?:any|all|every)\s+(?:level|lvl)s?\b|\b(?:levels?|lvls?)\s*1\s*[-–]\s*\d{1,3}\b)/i;

    // Numbered/craft-number ranges are also specialized. Traders often avoid
    // the word "craft" entirely and write things like "#1~#200" or "#1-#200".
    const numberedRange=/(?:#\s*\d{1,5}\s*(?:~|[-–—]|to)\s*#?\s*\d{1,5}\b)/i;
    const numberDependentPrice=/(?:price|offer|value)\s+depends?\s+on\s+(?:the\s+)?number\b/i;
    const outbidNumberBuy=/(?:try|trying|will|i'll|ill)\s+to\s+outbid\s+(?:other\s+)?buyers?\b/i;
    if(numberedRange.test(positive)||numberDependentPrice.test(positive)||outbidNumberBuy.test(positive)){
      matches.push("specific numbered item");
    }

    if(levelRequest.test(positive)|| (specificLevel.test(positive)&&!genericLevel.test(positive))){
      matches.push("specific level");
    }

    return [...new Set(matches)];
  }

  function parseListingTimestamp(value,now=Date.now()){
    const text=String(value||"").normalize("NFKC").replace(/\s+/g," ").trim();
    if(!text)return null;
    const normalized=text.replace(/^(?:listed|bumped)\s*(?::|at|on)?\s*/i,"").trim();

    if(/^(?:just now|moments? ago|less than a minute ago)$/i.test(normalized))return now;
    if(/^today\b/i.test(normalized)){
      const today=new Date(now);
      today.setHours(0,0,0,0);
      return today.getTime();
    }
    if(/^yesterday\b/i.test(normalized)){
      const yesterday=new Date(now);
      yesterday.setDate(yesterday.getDate()-1);
      yesterday.setHours(0,0,0,0);
      return yesterday.getTime();
    }

    const relative=normalized.match(/\b(\d+(?:\.\d+)?)\s*(seconds?|secs?|s|minutes?|mins?|min|m|hours?|hrs?|hr|h|days?|d|weeks?|w)\s*(?:ago)?\b/i);
    if(relative){
      const amount=Number(relative[1]);
      const unit=relative[2].toLowerCase();
      const multiplier=/^(?:s|sec|second)/.test(unit)
        ?1000
        :/^(?:m|min|minute)/.test(unit)
          ?60*1000
          :/^(?:h|hr|hour)/.test(unit)
            ?60*60*1000
            :/^(?:d|day)/.test(unit)
              ?24*60*60*1000
              :7*24*60*60*1000;
      if(Number.isFinite(amount))return now-amount*multiplier;
    }

    if(/^\d{9,13}$/.test(normalized)){
      const timestamp=Number(normalized);
      if(Number.isFinite(timestamp))return timestamp<1e12?timestamp*1000:timestamp;
    }
    const timestamp=new Date(normalized).getTime();
    return Number.isFinite(timestamp)?timestamp:null;
  }

  function getListingTimestamp(listing,label){
    const labelPattern=new RegExp(`\\b${label}\\b`,"i");
    const otherLabel=label==="Bumped"?"Listed":"Bumped";
    const otherLabelPattern=new RegExp(`\\b${otherLabel}\\b`,"i");
    const dataAttribute=`data-${label.toLowerCase()}-at`;
    const candidates=[];

    for(const el of listing.querySelectorAll('[datetime],[data-time],[data-timestamp],[data-bumped-at],[data-listed-at],.timeago[title],abbr[title],time[title]')){
      const text=(el.textContent||"").trim();
      const title=el.getAttribute("title")||"";
      const dedicated=el.getAttribute(dataAttribute)||"";
      const className=typeof el.className==="string"?el.className:"";
      const parentText=(el.parentElement?.textContent||"").trim();
      const directContext=[text,title,dedicated,className].join(" ");
      const labelIsLocal=labelPattern.test(directContext)||className.toLowerCase().includes(label.toLowerCase())||
        (labelPattern.test(parentText)&&!otherLabelPattern.test(parentText));
      if(!labelIsLocal&&!dedicated)continue;

      candidates.push(
        dedicated,
        el.getAttribute("datetime"),
        el.getAttribute("data-time"),
        el.getAttribute("data-timestamp"),
        title,
        text
      );
    }

    const listingText=(listing.textContent||"").replace(/\s+/g," ").trim();
    const visible=label==="Bumped"
      ?listingText.match(/\bBumped\s*(?::|at|on)?\s*(.+?)(?=\s+\b(?:by|Listed|Bumped)\b|$)/i)
      :listingText.match(/\bListed\s*(?::|at|on)?\s*(.+?)(?=\s+\b(?:by|Bumped)\b|$)/i);
    if(visible)candidates.push(visible[1]);

    for(const candidate of candidates){
      const timestamp=parseListingTimestamp(candidate);
      if(timestamp!==null)return timestamp;
    }
    return null;
  }

  function getListingPostedAt(listing){
    return getListingTimestamp(listing,"Listed");
  }

  function getListingBumpedAt(listing){
    return getListingTimestamp(listing,"Bumped");
  }

  function getListingQuantity(listing,item){
    const text=[
      item?.dataset?.listing_comment||'',
      ...[...listing.querySelectorAll('.quote-box p')].map(x=>x.textContent||''),
      listing.textContent||''
    ].join(' ').normalize('NFKC').replace(/\s+/g,' ').trim();
    // An explicit count in the trader's own words ("I CAN BUY 5", "Selling 2")
    // wins over fractions or stock words that can appear elsewhere in the
    // listing's text. The description is checked on its own first.
    const descriptionText=[
      item?.dataset?.listing_comment||'',
      ...[...listing.querySelectorAll('.quote-box p')].map(x=>x.textContent||'')
    ].join(' ').normalize('NFKC').replace(/\s+/g,' ').trim();
    for(const source of [descriptionText,text]){
      const explicit=source.match(/\bcan\s+buy\s+(\d+)\b/i)||source.match(/\b(?:i\s+am\s+|i\s+)?selling\s+(\d+)\b/i);
      if(explicit){
        const n=Number.parseInt(explicit[1],10);
        if(Number.isInteger(n)&&n>=0)return n;
      }
    }
    // Stock fractions mean current/max, so subtract current from maximum.
    // Examples: Stock 0/5 means 5 remain; Stock 2/5 means 3 remain.
    const stockFraction=text.match(/\b(?:stock|have|storage|carry|currently\s+have|current\s+stock)\s*[:=]?\s*\[?\s*(\d+)\s*(?:\/|\||out\s+of)\s*(\d+)\b/i);
    if(stockFraction){
      const current=Number.parseInt(stockFraction[1],10);
      const maximum=Number.parseInt(stockFraction[2],10);
      if(Number.isInteger(current)&&Number.isInteger(maximum)&&maximum>0&&current<=maximum){
        return maximum-current;
      }
    }

    const outOfFraction=text.match(/\b(\d+)\s+out\s+of\s+(\d+)\b/i);
    if(outOfFraction){
      const current=Number.parseInt(outOfFraction[1],10);
      const maximum=Number.parseInt(outOfFraction[2],10);
      if(Number.isInteger(current)&&Number.isInteger(maximum)&&maximum>0&&current<=maximum){
        return maximum-current;
      }
    }

    const explicitQuantity=text.match(/\bup\s+to\s+(\d+)\b/i);
    if(explicitQuantity){
      const n=Number.parseInt(explicitQuantity[1],10);
      if(Number.isInteger(n)&&n>=0)return n;
    }

    // Plain stock counts are also supported.
    const patterns=[
      /\bstock\s*[:=-]?\s*(\d+)\b(?!\s*(?:\/|\\|\||out\s+of)\s*\d)/i
    ];
    for(const re of patterns){
      const m=text.match(re);
      if(m){const n=Number(m[1]);if(Number.isInteger(n)&&n>=0)return n;}
    }

    const fractionMatches=text.matchAll(/(\d+)\s*[\/\\]\s*(\d+)/g);
    for(const match of fractionMatches){
      const current=Number.parseInt(match[1],10);
      const maximum=Number.parseInt(match[2],10);
      if(Number.isInteger(current)&&Number.isInteger(maximum)&&maximum>0&&current<=maximum){
        return maximum-current;
      }
    }
    return null;
  }

  // The copies a trader's description says it already holds. "Stock: 4/5"
  // means 4 held of a maximum of 5 (1 still wanted). Returns 0 when the
  // description gives no current/maximum stock.
  function getListingCurrentStock(listing,item){
    const text=[
      item?.dataset?.listing_comment||'',
      ...[...listing.querySelectorAll('.quote-box p')].map(x=>x.textContent||'')
    ].join(' ').normalize('NFKC').replace(/\s+/g,' ').trim();
    const patterns=[
      /\b(?:stock|have|storage|carry|currently\s+have|current\s+stock)\s*[:=]?\s*\[?\s*(\d+)\s*(?:\/|\||out\s+of)\s*(\d+)\b/i,
      /\b(\d+)\s+out\s+of\s+(\d+)\b/i,
      /(\d+)\s*[\/\\]\s*(\d+)/
    ];
    for(const re of patterns){
      const m=text.match(re);
      if(!m)continue;
      const current=Number.parseInt(m[1],10);
      const maximum=Number.parseInt(m[2],10);
      if(Number.isInteger(current)&&Number.isInteger(maximum)&&maximum>0&&current<=maximum)return current;
    }
    return 0;
  }

  function getTraderProfile(listing,listingAccountId,listingName){
    const profileLink=[...listing.querySelectorAll(".listing-header a[href], .listing-buttons a[href]")]
      .find(anchor=>/steamcommunity\.com\/profiles\/|steamcommunity\.com\/id\/|backpack\.tf\/profiles\//i.test(anchor.href));
    const avatar=[...listing.querySelectorAll(".listing-header img, .listing-header [style*='background-image']")]
      .map(node=>node.currentSrc||node.src||node.style.backgroundImage||"")
      .map(value=>String(value).replace(/^url\(["']?|["']?\)$/g,""))
      .find(value=>/^https?:\/\//i.test(value));
    return {
      traderId:listingAccountId||String(listingName||"").trim().toLowerCase(),
      traderName:String(listingName||"").trim()||"Unknown trader",
      profileUrl:profileLink?.href||"",
      avatarUrl:avatar||""
    };
  }

  function getListingTradeOfferUrl(listing,item){
    const tradeCandidates=[
      item?.dataset?.trade_url,item?.dataset?.tradeurl,item?.dataset?.trade_link,item?.dataset?.tradeLink,
      item?.dataset?.trade_offer_url,item?.dataset?.tradeoffer,
      listing?.dataset?.trade_url,listing?.dataset?.tradeurl,listing?.dataset?.trade_link,
      listing?.dataset?.trade_offer_url,listing?.dataset?.tradeoffer,
      ...[listing,...(listing?.querySelectorAll("*")||[])].flatMap(el=>
        [...(el.attributes||[])].map(attribute=>attribute.value)
      )
    ].map(value=>String(value||"").trim()).filter(Boolean);

    for(const raw of tradeCandidates){
      const decoded=raw
        .replace(/&amp;/gi,"&")
        .replace(/\\u0026/gi,"&")
        .replace(/\\\//g,"/");
      const candidates=[decoded];
      try{candidates.push(decodeURIComponent(decoded))}catch(e){}
      for(const candidateText of candidates){
        const matches=candidateText.match(/(?:https?:)?\/\/steamcommunity\.com\/tradeoffer\/new\/[^"'\\\s<>]*|steamcommunity\.com\/tradeoffer\/new\/[^"'\\\s<>]*/ig)||[];
        for(const match of matches){
          try{
            const absolute=match.startsWith("//")?`https:${match}`:/^https?:\/\//i.test(match)?match:`https://${match}`;
            const url=new URL(absolute,location.href);
            if(url.protocol==="https:"&&url.hostname==="steamcommunity.com"&&/^\/tradeoffer\/new\/?$/i.test(url.pathname)){
              return url.href;
            }
          }catch(e){}
        }
      }
    }
    return "";
  }

  // A buyer who wants a special version of the item is not paying the plain
  // price. Backpack.tf marks those listings with a badge next to the title (for
  // example <small>Parts Attached</small>) and with data-part_name_N,
  // data-spell_* and data-paint_* attributes on the item. Any of them means the
  // listing is ignored.
  function specialListingReason(listing,item){
    for(const key of Object.keys(item.dataset||{})){
      if(!item.dataset[key])continue;
      if(/^part_name/i.test(key))return "parts attached";
      if(/^spell/i.test(key))return "spells";
      if(/^paint_(?:name|hex)$/i.test(key))return "paint";
    }
    for(const badge of listing.querySelectorAll(".listing-title small, .listing-title .label")){
      const text=(badge.textContent||"").replace(/\s+/g," ").trim();
      if(/\bparts?\b/i.test(text))return "parts attached";
      if(/\bspell/i.test(text))return "spells";
      if(/\bpaint/i.test(text))return "paint";
      if(/\bfestiviz/i.test(text))return "festivized";
    }
    return "";
  }

  function getMatchingListings(itemName,desiredSpec=null,priceSink=null,intent="buy"){
    // "buy" reads Buy Orders (bot buyers). "sell" reads the sell listings of the
    // same item, which the reverse scan compares with STN's buy price.
    const isSell=intent==="sell";
    const target=normalizeName(itemName);
    const desiredQuality=desiredSpec?.quality||null;
    const desiredCraftability=desiredSpec?.craftability||null;
    const qualityNames=new Set(["Unique","Genuine","Vintage","Strange","Unusual","Haunted","Collector's"]);
    const found=[];
    for(const listing of document.querySelectorAll("li.listing")){
      const item=listing.querySelector(".listing-item .item");
      if(!item)continue;
      const name=item.dataset.name||item.dataset.base_name||"";
      if(normalizeName(name)!==target)continue;
      if(getListingIntent(listing,item)!==intent)continue;

      // Classifieds can contain multiple quality variants for the same base
      // item. Match the actual listing quality to the requested variant so a
      // Strange item can never inherit the Unique price (or vice versa).
      if(desiredQuality){
        const listingQuality=String(item.dataset.q_name||"").trim();
        if(listingQuality&&qualityNames.has(listingQuality)&&listingQuality.toLowerCase()!==desiredQuality.toLowerCase())continue;
        const qualityIds={Unique:"6",Genuine:"1",Vintage:"3",Strange:"11",Unusual:"5",Haunted:"13","Collector's":"14"};
        const listingQualityId=String(item.dataset.quality||"").trim();
        if(listingQualityId&&qualityIds[desiredQuality]&&listingQualityId!==qualityIds[desiredQuality])continue;
      }
      if(desiredCraftability){
        const expected=desiredCraftability==="Craftable"?"1":"0";
        const listingCraft=String(item.dataset.craftable||"").trim();
        if(listingCraft && listingCraft!==expected)continue;
      }

      // Record every Buy Order's price before the bot and description filters
      // run. The background script uses the lowest price on the page to know
      // when this price-sorted list has dropped below the profit threshold.
      if(Array.isArray(priceSink)&&item.dataset.listing_price)priceSink.push(item.dataset.listing_price);

      const listingName=item.dataset.listing_name||"";
      const listingAccountId=String(item.dataset.listing_account_id||"").trim();

      // Skip blacklisted traders (see blacklist.js). Backpack.tf commonly
      // exposes data-listing_account_id as the Steam partner ID rather than the
      // 64-bit Steam ID; the blacklist matches both forms.
      const normalizeBuyerName=(value)=>String(value||"")
        .replace(/&(?:#0*39|#x27|apos);/gi,"'")
        .replace(/&amp;/gi,"&")
        .replace(/[\u200B-\u200D\uFEFF]/g,"")
        .replace(/\s+/g," ")
        .trim()
        .toLowerCase();
      const normalizedListingName=normalizeBuyerName(listingName);
      if(
        TraderBlacklist.isBlacklisted({listingAccountId,listingName:normalizedListingName})||
        /\bbluebus\b/i.test(normalizedListingName)
      )continue;

      const description=getListingDescription(listing,item);
      const traderProfile=getTraderProfile(listing,listingAccountId,listingName);

      // Real traders expose an "Add this user" button in the listing header.
      // A friend-related profile URL is another strong human-account signal.
      // Ignore these before applying the bot buyout rule so a real trader can
      // never become a false-positive bot hit.
      const userButton=listing.querySelector(
        '.listing-body .listing-header .listing-buttons a.btn.btn-success.btn-bottom.btn-xs'
      ) || listing.querySelector(
        '.listing-buttons a.btn.btn-success.btn-bottom.btn-xs'
      );
      const userButtonTitle=String(userButton?.getAttribute("title")||"").trim();
      const userButtonHref=String(userButton?.getAttribute("href")||"").trim();
      const humanSeller=userButtonTitle.includes("Add this user") || /friend/i.test(userButtonHref);
      if(!isSell&&humanSeller)continue;

      // ONLY treat a listing as bot-managed when Backpack.tf's actual green
      // buyout button explicitly says "Please only offer the buyout.".
      // This is intentionally strict: negotiation-enabled listings are real
      // player/manual listings for this scanner and must be ignored.
      const buyoutButton=listing.querySelector(
        '.listing-buttons .btn.btn-bottom.btn-xs.btn-success[title]'
      );
      const buttonTitle=String(buyoutButton?.getAttribute("title")||"").trim();
      const isBotBuyout=buttonTitle.includes("Please only offer the buyout.");
      const negotiationAllowed=buttonTitle.includes("Negotiation is allowed.");
      const botLike=isSell?(!humanSeller&&!negotiationAllowed):(isBotBuyout&&!negotiationAllowed);
      if(!isSell&&!botLike)continue;

      // Parts, spells, paint and the like make this a special-version order.
      if(specialListingReason(listing,item))continue;

      // The listing title itself can contain specialization signals (for
      // example "B> LEVEL 100 ONLY"), so inspect it together with the
      // actual Buy Order description. Do NOT include data-summary because
      // that contains normal item metadata such as "Level 1-100 Hat".
      const listingText=[listingName,description].filter(Boolean).join(" ").replace(/\s+/g," ").trim();
      const matchedTerms=badDescription(listingText);
      // Backpack.tf can expose the Buy Order comment in more than one place.
      // A quote-box may contain a one-word paint request such as exactly "Gold".
      // Normalize the actual description independently of the listing title so
      // a short paint request cannot slip through.
      const cleanDescription=description
        .replace(/[\uFE0F\u200D]/g, "")
        .replace(/[^\p{L}\p{N}#'\u2019\s-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const barePaintDescription=/^(?:black|white|pink|lime|green|purple|gold|yellow|orange|red|blue|brown|grey|gray|cyan|teal|navy|violet|magenta|after\s*eight|team\s*spirit|value|a\s+distinctive\s+lack\s+of\s+hue|an\s+extraordinary\s+abundance\s+of\s+tinge|a\s+deep\s+commitment\s+to\s+purple|mann(?:'|\u2019)?s\s+mint|operator(?:'|\u2019)?s\s+overalls|cream\s+spirit|waterlogged\s+lab\s+coat)$/i;
      const rawQuoteDescription=[...listing.querySelectorAll(".quote-box p")]
        .map(x=>x.textContent||"")
        .join(" ")
        .replace(/[\uFE0F\u200D]/g, "")
        .replace(/[^\p{L}\p{N}#'\u2019\s-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
      const paintOnlyDescription=barePaintDescription.test(cleanDescription) ||
        barePaintDescription.test(rawQuoteDescription);
      if(paintOnlyDescription&&!matchedTerms.includes("painted item request")){
        matchedTerms.push("painted item request");
      }
      if(item.dataset.paint_name||item.dataset.paint_hex||(!isSell&&matchedTerms.length))continue;
      if(!item.dataset.listing_price)continue;

      const tradeUrl=getListingTradeOfferUrl(listing,item);
      // Second guard: the trade-offer link names the trader (partner id) even
      // when the listing exposes no usable account id.
      if(TraderBlacklist.isBlacklisted({listingAccountId,listingName:normalizedListingName,tradeUrl}))continue;

      found.push({
        price:item.dataset.listing_price,
        intent,
        listingName,
        comment:item.dataset.listing_comment||"",
        description,
        ...traderProfile,
        rejectedTerms:[],
        listingAccountId,
        tradeUrl,
        botLike,
        userAgent:isBotBuyout,
        negotiationAllowed:false,
        listedAt:getListingPostedAt(listing),
        bumpedAt:getListingBumpedAt(listing),
        quantity:getListingQuantity(listing,item),
        currentStock:getListingCurrentStock(listing,item)
      });
    }
    return found;
  }

  function getPageNumber(){
    const n=Number(new URL(location.href).searchParams.get("page")||"1");
    return Number.isFinite(n)&&n>0?n:1;
  }

  function readNextPageHref(){
    const current=getPageNumber();
    const candidates=[];
    for(const a of document.querySelectorAll('a[href*="page="]')){
      const raw=a.getAttribute("href");
      if(!raw)continue;
      try{
        const u=new URL(raw,location.href);
        const p=Number(u.searchParams.get("page"));
        if(Number.isInteger(p)&&p>current)candidates.push({p,href:u.href});
      }catch(e){}
    }
    candidates.sort((a,b)=>a.p-b.p);
    return candidates[0]?.href||null;
  }

  // Backpack.tf answers with an error page (HTTP 500/502/503/504, 429 or a
  // Cloudflare 5xx) when it is overloaded. Reports a short description, or ""
  // for a normal page, so the scanner can reload instead of reading nothing.
  function detectBackpackServerError(){
    if(!/(?:^|\.)backpack\.tf$/i.test(location.hostname))return "";
    let status=0;
    try{status=Number(performance.getEntriesByType("navigation")[0]?.responseStatus)||0}catch(e){}
    if(status>=500||status===429)return `HTTP ${status}`;
    // A real page with listings is never an error page.
    if(document.querySelector("li.listing"))return "";
    const heading=[document.title,...[...document.querySelectorAll("h1,h2")].slice(0,3).map(x=>x.textContent)]
      .join(" ").replace(/\s+/g," ").trim().toLowerCase();
    const bodyText=String(document.body?.innerText||"").replace(/\s+/g," ").trim().toLowerCase();
    const codeInHeading=heading.match(/\b(?:429|500|502|503|504|52[0-4])\b/);
    if(codeInHeading&&bodyText.length<3000)return `HTTP ${codeInHeading[0]}`;
    if(bodyText.length<3000){
      const phrase=(heading+" "+bodyText).match(/internal server error|bad gateway|service (?:temporarily )?unavailable|gateway time-?out|too many requests|error 1015|server error/);
      if(phrase)return phrase[0];
    }
    return "";
  }

  function classifiedsState(itemName){
    const listings=[...document.querySelectorAll("li.listing")];
    const target=normalizeName(itemName);
    const signature=[];let matching=0;
    for(const listing of listings){
      const item=listing.querySelector(".listing-item .item");
      if(!item)continue;
      const name=item.dataset.name||item.dataset.base_name||"";
      if(normalizeName(name)!==target)continue;
      matching++;
      signature.push([
        item.dataset.listing_price||"",
        item.dataset.listing_name||"",
        item.dataset.listing_comment||"",
        getListingDescription(listing,item),
        item.dataset.listing_intent||""
      ].join("|"));
    }
    signature.sort();
    return{
      ready:document.readyState==="complete",
      count:listings.length,
      matching,
      page:getPageNumber(),
      signature:signature.join("||")
    };
  }

  // The "Sell it for" box of an STN item page: what STN pays for the item, and
  // how many more it is willing to buy ("We can buy <b data-stock-limit>N</b> more").
  function readStnSellPage(){
    if(!/^(?:www\.)?stntrading\.eu$/i.test(location.hostname)||!location.pathname.startsWith("/item/")){
      return {status:"failed",reason:"This is not an STN item page."};
    }
    const label=[...document.querySelectorAll("p")].find(p=>/^\s*sell it for\s*:?\s*$/i.test(p.textContent));
    const box=label?.parentElement;
    const price=box?.querySelector("b")?.textContent.trim().replace(/\s+/g," ")||"";
    if(!price||!/(?:keys?|ref)/i.test(price))return {status:"loading",reason:"STN's buy price is not visible yet."};
    const limitNode=box.querySelector("b[data-stock-limit]");
    let capacity=Number((limitNode?.textContent||"").trim());
    if(!Number.isFinite(capacity)){
      capacity=Number((box.textContent.match(/we can buy\s*(\d+)\s*more/i)||[])[1]);
    }
    return {status:"ready",price,capacity:Number.isFinite(capacity)?capacity:0};
  }

  function readStatsSellListings(itemName,desiredSpec=null){
    const listings=deduplicateListings(getMatchingListings(itemName,desiredSpec,null,"sell"));
    listings.sort((a,b)=>approx(a.price)-approx(b.price));
    return {listings};
  }

  function readStatsBuyOrders(itemName,desiredSpec=null){
    const listings=deduplicateListings(getMatchingListings(itemName,desiredSpec));
    listings.sort((a,b)=>approx(b.price)-approx(a.price));
    return {listings};
  }

  function readClassifiedsLink(){
    // Prefer the expand button used by the Buy Orders header. Do not select
    // the adjacent "/classifieds/buy/..." create-listing button.
    const links=[...document.querySelectorAll('a.btn.btn-default.btn-sm.btn-circle-sm[href*="/classifieds?"]')];
    const a=links.find(x=>x.getAttribute("href"));
    if(!a)return null;
    try{
      const url=new URL(a.href,location.href);
      if(url.protocol!=="https:"||! /^(?:www\.)?backpack\.tf$/i.test(url.hostname)||url.pathname!=="/classifieds")return null;
      url.searchParams.set("offers","1");
      url.searchParams.set("paint","None");
      return {href:url.href};
    }catch{return null}
  }

  function readClassifiedsPage(itemName,desiredSpec=null){
    const buyOrderPrices=[];
    const listings=deduplicateListings(getMatchingListings(itemName,desiredSpec,buyOrderPrices));
    listings.sort((a,b)=>approx(b.price)-approx(a.price));
    return{
      notFound:false,
      listings,
      page:getPageNumber(),
      nextHref:readNextPageHref(),
      buyOrderPrices
    };
  }

  function deduplicateListings(listings){
    const unique=new Map();
    for(const listing of listings){
      const accountId=String(listing.listingAccountId||"").trim();
      const tradeUrl=String(listing.tradeUrl||"").trim();
      const stableName=normalizeName(listing.listingName||"");
      let identity="";
      if(accountId)identity=`account:${accountId}`;
      else if(tradeUrl){
        try{
          const url=new URL(tradeUrl);
          url.hash="";
          identity=`trade:${url.origin.toLowerCase()}${url.pathname}${url.search}`;
        }catch{
          identity=`trade:${tradeUrl.toLowerCase()}`;
        }
      }else{
        identity=`listing:${stableName}|${String(listing.price||"").trim().toLowerCase()}|${normalizeName(listing.comment||listing.description||"")}`;
      }
      const existing=unique.get(identity);
      // Buy Orders keep a trader's highest price, sell listings their lowest.
      const better=listing.intent==="sell"?approx(listing.price)<approx(existing?.price):approx(listing.price)>approx(existing?.price);
      if(!existing||better)unique.set(identity,listing);
    }
    return [...unique.values()];
  }

  function readTradeOfferMetal(requiredRef){
    if(!/^\/tradeoffer\/new\/?$/i.test(location.pathname)){
      return Promise.resolve({status:"unverified",reason:"The listing link did not open Steam's new-trade page."});
    }
    const fragment=new URLSearchParams(location.hash.replace(/^#/,""));
    if(fragment.get("tmt_verify")!=="1"){
      return Promise.resolve({status:"unverified",reason:"This offer was not opened in TF2 Metal Trader verification mode."});
    }

    const expectedRef=Number(fragment.get("tmt_required_ref"));
    if(!Number.isFinite(requiredRef)||requiredRef!==expectedRef){
      return Promise.resolve({status:"unverified",reason:"The verification request does not match this offer's metal verification parameters."});
    }

    return new Promise((resolve,reject)=>{
      const requestId=`arb-metal-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const dispatchRequest=()=>window.dispatchEvent(new CustomEvent("tf2mt-verify-trader-metal",{
        detail:JSON.stringify({requestId,requiredRef})
      }));
      let retryTimer=null;
      let timeout=setTimeout(()=>{
        if(retryTimer!==null)clearInterval(retryTimer);
        window.removeEventListener("tf2mt-verify-trader-metal-result",onResult);
        window.removeEventListener("tf2mt-verify-trader-metal-started",onStarted);
        reject(new Error("TF2 Metal Trader did not respond to the metal availability test."));
      },10000);
      function onStarted(event){
        let detail;
        try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
        if(detail?.requestId!==requestId)return;
        if(retryTimer!==null){clearInterval(retryTimer);retryTimer=null}
        clearTimeout(timeout);
        timeout=setTimeout(()=>{
          window.removeEventListener("tf2mt-verify-trader-metal-result",onResult);
          window.removeEventListener("tf2mt-verify-trader-metal-started",onStarted);
          reject(new Error("TF2 Metal Trader did not finish the metal availability test in time."));
        },120000);
      }
      function onResult(event){
        let detail;
        try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
        if(!detail||detail.requestId!==requestId)return;
        clearTimeout(timeout);
        if(retryTimer!==null)clearInterval(retryTimer);
        window.removeEventListener("tf2mt-verify-trader-metal-result",onResult);
        window.removeEventListener("tf2mt-verify-trader-metal-started",onStarted);
        if(detail.result)resolve(detail.result);
        else reject(new Error("TF2 Metal Trader returned an empty inventory-check result."));
      }
      window.addEventListener("tf2mt-verify-trader-metal-started",onStarted);
      window.addEventListener("tf2mt-verify-trader-metal-result",onResult);
      retryTimer=setInterval(dispatchRequest,500);
      dispatchRequest();
    });
  }

  function findQuickBuyButton(select){
    const group=select?.closest(".input-group")||select?.parentElement;
    return group?.querySelector('button[aria-label="QuickBuy"]') ||
      group?.querySelector("button.btn.btn-warning.rounded-0") ||
      null;
  }

  function getQuickBuyOptions(){
    const select=document.querySelector("#quickBuySelect");
    if(!select)return {status:"pending",reason:"STN's QuickBuy quantity selector is not ready."};
    if(select.disabled)return {status:"pending",reason:"STN's QuickBuy quantity selector is still disabled."};
    const button=findQuickBuyButton(select);
    if(!button)return {status:"pending",reason:"STN's QuickBuy button is still loading."};
    const amounts=[...select.options]
      .filter(option=>!option.disabled)
      .map(option=>Number(String(option.value||"").trim()))
      .filter(amount=>Number.isSafeInteger(amount)&&amount>0);
    const uniqueAmounts=[...new Set(amounts)].sort((a,b)=>a-b);
    if(!uniqueAmounts.length)return {status:"pending",reason:"STN has not loaded any available QuickBuy quantities yet."};
    return {status:"ready",amounts:uniqueAmounts,maxAmount:uniqueAmounts[uniqueAmounts.length-1]};
  }

  async function waitForQuickBuyControl(timeoutMs=20000){
    const deadline=Date.now()+timeoutMs;
    let lastReason="";
    while(Date.now()<deadline){
      const result=getQuickBuyOptions();
      if(result.status==="ready")return result;
      lastReason=result.reason||lastReason;
      await new Promise(resolve=>setTimeout(resolve,250));
    }
    throw new Error(lastReason||"STN's QuickBuy selector did not become ready.");
  }

  async function quickBuyAmount(amount,strict=false){
    const select=document.querySelector("#quickBuySelect");
    if(!select)return {ok:false,reason:"quickBuySelect not found"};
    if(select.disabled)return {ok:false,reason:"STN's QuickBuy quantity selector is disabled."};

    const target=Math.max(1,Math.floor(Number(amount)||0));
    let option=[...select.options].find(o=>String(o.value)===String(target));
    if(option?.disabled)return {ok:false,reason:`STN's QuickBuy quantity ${target} is disabled.`};
    if(!option){
      if(strict)return {ok:false,reason:`STN does not offer a QuickBuy quantity of ${target}.`};
      option=document.createElement("option");
      option.value=String(target);
      option.textContent=String(target);
      select.appendChild(option);
    }

    // Set the actual option/index, not just the property, because some site
    // handlers read selectedIndex rather than value.
    select.selectedIndex=[...select.options].indexOf(option);
    select.value=String(target);
    if(select.value!==String(target))return {ok:false,reason:`STN did not select the requested quantity ${target}.`};
    select.focus();

    // Notify every normal form/change path before clicking the exact QuickBuy
    // button that belongs to this selector.
    for(const type of ["input","change"]){
      try{select.dispatchEvent(new Event(type,{bubbles:true,cancelable:true}));}catch(e){}
    }

    // STN's purchase control is the QuickBuy button immediately beside this
    // selector. Prefer the explicit aria-label, then fall back to the exact
    // button class used by the marketplace markup.
    const button=findQuickBuyButton(select);
    if(!button)return {ok:false,reason:"QuickBuy button not found"};
    if(button.getAttribute("aria-label")!=="QuickBuy"&&!button.classList.contains("btn-warning")){
      return {ok:false,reason:"The adjacent STN button is not the QuickBuy control."};
    }

    const buttonDeadline=Date.now()+5000;
    while(button.disabled&&Date.now()<buttonDeadline){
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(button.disabled)return {ok:false,reason:"STN's QuickBuy button stayed disabled after selecting the requested quantity."};

    try{
      button.scrollIntoView({behavior:"instant",block:"center",inline:"center"});
      button.focus({preventScroll:true});
    }catch(e){}

    // Click the page's native QuickBuy control exactly once. STN's handler is
    // attached to this button, not to the selector or its surrounding form.
    try{button.click();}
    catch(e){return {ok:false,reason:`QuickBuy click failed: ${e.message||e}`};}

    return {ok:true,amount:target,buttonFound:true,buttonClicked:true};
  }

  function steamPartnerIdFromSteam64(accountId){
    const raw=String(accountId||'').trim();
    if(!raw||!/^[0-9]+$/.test(raw))return '';
    const n=BigInt(raw);
    const base=BigInt('76561197960265728');
    // If Backpack.tf already supplied the partner ID, keep it as-is.
    if(n>base)return String(n-base);
    return raw;
  }

  let tradeAutomationRunning=false;

  function showHoverStatus(target, text, kind='working'){
    if(!target)return;
    let box=document.getElementById('tf2-arb-hover-status');
    if(!box){
      box=document.createElement('div');
      box.id='tf2-arb-hover-status';
      box.style.cssText='position:fixed;top:16px;left:50%;transform:translateX(-50%);z-index:2147483647;padding:9px 14px;background:#171717;color:#fff;border:3px solid #e7a34b;border-radius:4px;font:bold 13px Arial,sans-serif;box-shadow:0 4px 18px rgba(0,0,0,.75);pointer-events:none;';
      (document.body||document.documentElement).appendChild(box);
    }
    box.textContent='TF2 ARB: '+text;
    box.style.borderColor=kind==='success'?'#67d36b':kind==='error'?'#e05252':'#e7a34b';

    document.querySelectorAll('.tf2-arb-hover-target').forEach(x=>x.classList.remove('tf2-arb-hover-target'));
    if(target){
      target.classList.add('tf2-arb-hover-target');
      if(!document.getElementById('tf2-arb-hover-target-style')){
        const style=document.createElement('style');
        style.id='tf2-arb-hover-target-style';
        style.textContent='.tf2-arb-hover-target{outline:4px solid #66ccff!important;outline-offset:2px;box-shadow:0 0 0 3px #111,0 0 24px rgba(102,204,255,.95)!important;animation:tf2ArbHoverPulse .55s ease-in-out infinite alternate!important}@keyframes tf2ArbHoverPulse{from{filter:brightness(1)}to{filter:brightness(1.45)}}';
        (document.head||document.documentElement).appendChild(style);
      }
    }
  }

  function hideHoverStatus(){
    const box=document.getElementById('tf2-arb-hover-status');
    if(box)box.remove();
    document.querySelectorAll('.tf2-arb-hover-target').forEach(x=>x.classList.remove('tf2-arb-hover-target'));
  }

  function clearBackpackListingHighlights(){
    document.querySelectorAll('.tf2-arb-target-listing').forEach(x=>x.classList.remove('tf2-arb-target-listing'));
    document.querySelectorAll('.tf2-arb-target-label').forEach(x=>x.remove());
  }

  function findBackpackListing(accountId,listingName){
    const wantedId=String(accountId||'').trim();
    const wantedName=normalizeName(String(listingName||''));
    const listings=[...document.querySelectorAll('li.listing')];
    if(wantedId){
      for(const listing of listings){
        const item=listing.querySelector('.listing-item .item');
        if(item&&String(item.dataset.listing_account_id||'').trim()===wantedId)return listing;
      }
      return null;
    }
    if(wantedName)for(const listing of listings){
      const item=listing.querySelector('.listing-item .item');
      if(item&&normalizeName(item.dataset.listing_name||'')===wantedName)return listing;
    }
    return null;
  }

  function highlightExactBackpackListing(target,accountId,itemName,{clearExisting=true,scroll=true}={}){
    if(!target)return;
    if(clearExisting)clearBackpackListingHighlights();

    if(!document.getElementById('tf2-arb-target-listing-style')){
      const style=document.createElement('style');
      style.id='tf2-arb-target-listing-style';
      style.textContent=`
        .tf2-arb-target-listing{
          position:relative!important;
          z-index:50!important;
          outline:4px solid #e7a34b!important;
          outline-offset:3px!important;
          box-shadow:0 0 0 3px #202020,0 0 24px rgba(231,163,75,.95)!important;
          animation:tf2ArbTargetPulse 1s ease-in-out infinite!important;
        }
        .tf2-arb-target-label{
          position:absolute!important;
          top:-28px!important;
          left:0!important;
          z-index:100!important;
          padding:4px 8px!important;
          background:#e7a34b!important;
          color:#171717!important;
          border:2px solid #202020!important;
          border-radius:3px!important;
          font:bold 12px Arial,sans-serif!important;
          line-height:14px!important;
          white-space:nowrap!important;
          pointer-events:none!important;
          box-shadow:0 2px 8px rgba(0,0,0,.7)!important;
        }
        @keyframes tf2ArbTargetPulse{
          0%,100%{filter:brightness(1)}
          50%{filter:brightness(1.2)}
        }`;
      (document.head||document.documentElement).appendChild(style);
    }

    target.classList.add('tf2-arb-target-listing');
    const label=document.createElement('div');
    label.className='tf2-arb-target-label';
    const trader=String(accountId||'').trim();
    label.textContent=`TARGET TRADE${itemName?` — ${itemName}`:''}`;
    target.style.position=target.style.position||'relative';
    target.appendChild(label);
    if(scroll){
      try{target.scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});}catch(e){try{target.scrollIntoView()}catch(err){}}
    }
    return true;
  }

  function highlightListing(accountId,listingName,itemName){
    const wantedId=String(accountId||'').trim();
    const target=findBackpackListing(wantedId,listingName);
    if(!target)return {ok:false,reason:'exact Backpack.tf listing not found'};
    highlightExactBackpackListing(target,wantedId,itemName);
    return {ok:true,method:'highlight-only'};
  }

  function highlightListings(listings,itemName){
    const requested=Array.isArray(listings)?listings:[];
    clearBackpackListingHighlights();
    const highlighted=[];
    const missing=[];
    for(const entry of requested){
      const accountId=String(entry?.accountId||entry?.listingAccountId||'').trim();
      const listingName=String(entry?.listingName||'');
      const target=findBackpackListing(accountId,listingName);
      if(!target){
        missing.push(listingName||accountId||"unknown trader");
        continue;
      }
      highlightExactBackpackListing(target,accountId,itemName,{clearExisting:false,scroll:false});
      highlighted.push(target);
    }
    if(highlighted.length){
      try{highlighted[0].scrollIntoView({behavior:'smooth',block:'center',inline:'nearest'});}
      catch(e){try{highlighted[0].scrollIntoView()}catch(err){}}
    }
    return {ok:highlighted.length===requested.length&&requested.length>0,highlighted:highlighted.length,total:requested.length,missing};
  }

  const TRADED_LISTINGS_STORAGE_KEY="tf2ArbTradedListings";
  const TRADER_HISTORY_STORAGE_KEY="tf2ArbTraderHistory";
  let tradedListings={};
  let traderHistory={};
  let tradedListingsReady=null;
  let tradedMarkQueue=Promise.resolve();

  function storageGetTradedListings(){
    if(typeof browser!=="undefined")return browser.storage.local.get(TRADED_LISTINGS_STORAGE_KEY);
    return new Promise((resolve,reject)=>{
      api.storage.local.get(TRADED_LISTINGS_STORAGE_KEY,result=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function storageGetTraderHistory(){
    if(typeof browser!=="undefined")return browser.storage.local.get(TRADER_HISTORY_STORAGE_KEY);
    return new Promise((resolve,reject)=>{
      api.storage.local.get(TRADER_HISTORY_STORAGE_KEY,result=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve(result);
      });
    });
  }

  function storageSetTraderRecords(listings,history){
    const data={
      [TRADED_LISTINGS_STORAGE_KEY]:listings,
      [TRADER_HISTORY_STORAGE_KEY]:history
    };
    if(typeof browser!=="undefined")return browser.storage.local.set(data);
    return new Promise((resolve,reject)=>{
      api.storage.local.set(data,()=>{
        const error=api.runtime.lastError;
        if(error)reject(new Error(error.message));
        else resolve();
      });
    });
  }

  function tradedOrderKey(listing){
    const item=listing.querySelector(".listing-item .item");
    if(!item)return "";
    const name=normalizeName(item.dataset.name||item.dataset.base_name||"");
    const account=String(
      item.dataset.listing_account_id||
      listing.dataset.listing_account_id||
      item.dataset.listing_name||
      ""
    ).trim().toLowerCase().replace(/\s+/g," ");
    if(!name||!account)return "";
    const quality=String(item.dataset.q_name||item.dataset.quality||"").trim().toLowerCase();
    const craftability=String(item.dataset.craftable||"").trim();
    return JSON.stringify([name,quality,craftability,account]);
  }

  function setTradedListingAppearance(listing,button,isTraded){
    listing.classList.toggle("tf2-arb-traded-order",isTraded);
    button.classList.toggle("tf2-arb-marked-traded",isTraded);
    button.textContent=isTraded?"Already traded ✓":"Mark traded";
    button.setAttribute("aria-pressed",String(isTraded));
    button.title=isTraded?"Click to clear the traded mark":"Mark this trader's order as already traded";
  }

  function ensureTradedListingStyles(){
    if(document.getElementById("tf2-arb-traded-order-style"))return;
    const style=document.createElement("style");
    style.id="tf2-arb-traded-order-style";
    style.textContent=`
      .tf2-arb-mark-traded{display:inline-block!important;width:auto!important;margin:2px 4px!important;padding:4px 7px!important;border:1px solid #8a3030!important;border-radius:3px!important;background:#3a2424!important;color:#ffdada!important;font:600 11px/1.2 Arial,sans-serif!important;cursor:pointer!important;vertical-align:middle!important}
      .tf2-arb-mark-traded:hover{background:#573030!important}
      .tf2-arb-mark-traded.tf2-arb-marked-traded{border-color:#d34c4c!important;background:#792d2d!important;color:#fff!important}
      li.listing.tf2-arb-traded-order .listing-item{opacity:.48!important}
      li.listing.tf2-arb-traded-order .listing-item .item-name{text-decoration:line-through 2px #d34c4c!important}
    `;
    (document.head||document.documentElement).appendChild(style);
  }

  async function addTradedOrderButtons(){
    if(!tradedListingsReady)tradedListingsReady=storageGetTradedListings().then(result=>{
      const stored=result?.[TRADED_LISTINGS_STORAGE_KEY];
      tradedListings=stored&&typeof stored==="object"?stored:{};
    });
    await tradedListingsReady;
    ensureTradedListingStyles();

    for(const listing of document.querySelectorAll("li.listing")){
      const key=tradedOrderKey(listing);
      if(!key)continue;
      const item=listing.querySelector(".listing-item .item");
      if(!item||getListingIntent(listing,item)!=="buy")continue;
      let button=listing.querySelector(".tf2-arb-mark-traded");
      if(!button){
        button=document.createElement("button");
        button.type="button";
        button.className="tf2-arb-mark-traded";
        button.dataset.orderKey=key;
        const host=listing.querySelector(".listing-body .listing-header .listing-buttons")||
          listing.querySelector(".listing-buttons")||
          listing.querySelector(".listing-body .listing-header")||
          listing;
        host.appendChild(button);
        button.addEventListener("click",async event=>{
          event.preventDefault();
          event.stopPropagation();
          const orderKey=button.dataset.orderKey;
          button.disabled=true;
          const listingItem=listing.querySelector(".listing-item .item");
          const profile=getTraderProfile(
            listing,
            String(listingItem?.dataset?.listing_account_id||"").trim(),
            String(listingItem?.dataset?.listing_name||"").trim()
          );
          tradedMarkQueue=tradedMarkQueue.then(async()=>{
            const [storedListings,storedHistory]=await Promise.all([
              storageGetTradedListings(),
              storageGetTraderHistory()
            ]);
            const nextListings=storedListings?.[TRADED_LISTINGS_STORAGE_KEY]&&typeof storedListings[TRADED_LISTINGS_STORAGE_KEY]==="object"
              ? {...storedListings[TRADED_LISTINGS_STORAGE_KEY]}
              : {...tradedListings};
            const nextHistory=storedHistory?.[TRADER_HISTORY_STORAGE_KEY]&&typeof storedHistory[TRADER_HISTORY_STORAGE_KEY]==="object"
              ? {...storedHistory[TRADER_HISTORY_STORAGE_KEY]}
              : {...traderHistory};
            const shouldMark=!nextListings[orderKey];
            const traderKey=profile.traderId?`account:${profile.traderId}`:"";
            if(shouldMark){
              nextListings[orderKey]={markedAt:Date.now(),...profile};
              if(traderKey){
                const current=nextHistory[traderKey]||{count:0};
                nextHistory[traderKey]={
                  ...current,
                  ...profile,
                  count:(Number(current.count)||0)+1,
                  lastTradedAt:Date.now()
                };
              }
            }else{
              delete nextListings[orderKey];
              if(traderKey&&nextHistory[traderKey]){
                const count=Math.max(0,(Number(nextHistory[traderKey].count)||0)-1);
                if(count===0)delete nextHistory[traderKey];
                else nextHistory[traderKey]={...nextHistory[traderKey],count};
              }
            }
            try{
              await storageSetTraderRecords(nextListings,nextHistory);
              tradedListings=nextListings;
              traderHistory=nextHistory;
              setTradedListingAppearance(listing,button,shouldMark);
            }catch(error){
              console.error("TF2 Arbitrage: could not save trader history.",error);
              setTradedListingAppearance(listing,button,Boolean(tradedListings[orderKey]));
            }
          }).catch(error=>{
            console.error("TF2 Arbitrage: could not update trader history.",error);
          }).finally(()=>{button.disabled=false});
          await tradedMarkQueue;
        });
      }else{
        button.dataset.orderKey=key;
      }
      setTradedListingAppearance(listing,button,Boolean(tradedListings[key]));
    }
  }

  function initTradedOrderMarkers(){
    if(!/(^|\.)backpack\.tf$/i.test(location.hostname))return;
    let scheduled=false;
    const schedule=()=>{
      if(scheduled)return;
      scheduled=true;
      setTimeout(()=>{
        scheduled=false;
        addTradedOrderButtons().catch(error=>{
          console.error("TF2 Arbitrage: could not load traded-order marks.",error);
          tradedListingsReady=null;
        });
      },100);
    };
    schedule();
    const observer=new MutationObserver(schedule);
    observer.observe(document.body||document.documentElement,{childList:true,subtree:true});

    api.storage.onChanged?.addListener((changes,area)=>{
      if(area!=="local")return;
      if(changes[TRADED_LISTINGS_STORAGE_KEY]){
        const value=changes[TRADED_LISTINGS_STORAGE_KEY].newValue;
        tradedListings=value&&typeof value==="object"?value:{};
        tradedListingsReady=Promise.resolve();
      }
      if(changes[TRADER_HISTORY_STORAGE_KEY]){
        const value=changes[TRADER_HISTORY_STORAGE_KEY].newValue;
        traderHistory=value&&typeof value==="object"?value:{};
      }
      if(changes[TRADED_LISTINGS_STORAGE_KEY])schedule();
    });
  }

  function highlightMarketItem(itemName){
    const target=normalizeName(itemName);
    document.querySelectorAll(".tf2-arb-current-item").forEach(x=>x.classList.remove("tf2-arb-current-item"));
    let match=null;
    if(isScrapTf()){
      for(const node of document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")){
        if(normalizeName(scrapItemName(node))===target){match=node;break}
      }
    }else for(const node of document.querySelectorAll("a.mp-item-box-wrap")){
      const nameNode=node.querySelector(".item-name");
      if(nameNode&&normalizeName(nameNode.textContent)===target){match=node;break}
    }
    if(!match)return {ok:false};
    if(!document.getElementById("tf2-arb-highlight-style")){
      const style=document.createElement("style");
      style.id="tf2-arb-highlight-style";
      style.textContent=`
        .tf2-arb-current-item{position:relative!important;z-index:20!important;outline:3px solid #e7a34b!important;box-shadow:0 0 0 2px #2b2b2b,0 0 18px rgba(231,163,75,.95)!important;animation:tf2ArbPulse 1.2s ease-in-out infinite!important}
        @keyframes tf2ArbPulse{0%,100%{filter:brightness(1)}50%{filter:brightness(1.28)}}`;
      (document.head||document.documentElement).appendChild(style);
    }
    match.classList.add("tf2-arb-current-item");
    try{match.scrollIntoView({behavior:"smooth",block:"center",inline:"nearest"})}catch(e){match.scrollIntoView()}
    return {ok:true};
  }

  // ---- already-checked items on the marketplace pages ---------------------------
  // The "checkedItems" table (see checked-items.js) remembers every item checked
  // in the last 60 minutes. On the STN and scrap.tf listings those items get a
  // gray veil and a small countdown on top of them until their 60 minutes are up
  // (the next scan skips them while their price stays the same).
  function initCheckedMarkers(){
    const onScrap=isScrapTf();
    const onStn=/(?:^|\.)stntrading\.eu$/i.test(location.hostname);
    if(!onScrap&&!onStn)return;
    const KEY="checkedItems";
    const site=onScrap?"scrap.tf":"stn";
    let table={};
    let scheduled=false;
    const norm=text=>String(text||"").trim().replace(/\s+/g," ").toLowerCase();

    if(!document.getElementById("tf2-arb-checked-style")){
      const style=document.createElement("style");
      style.id="tf2-arb-checked-style";
      style.textContent=`
        .tf2-arb-veil{position:absolute;top:0;right:0;bottom:0;left:0;z-index:5;pointer-events:none;background:rgba(105,105,105,.62);-webkit-backdrop-filter:grayscale(1);backdrop-filter:grayscale(1)}
        .tf2-arb-veil.tf2-arb-veil-half{background:rgba(105,105,105,.2);-webkit-backdrop-filter:grayscale(.4);backdrop-filter:grayscale(.4)}
        .tf2-arb-timer{position:absolute;top:2px;left:50%;transform:translateX(-50%);z-index:6;pointer-events:none;padding:1px 6px;border:1px solid #111;border-radius:3px;background:rgba(25,25,25,.92);color:#e7a34b;font:bold 10px/14px Tahoma,Verdana,sans-serif;letter-spacing:.2px;white-space:nowrap}`;
      (document.head||document.documentElement).appendChild(style);
    }

    function candidateNodes(){
      return onScrap
        ?[...document.querySelectorAll("#buy-container .banking-category .item[data-item-value]")]
        :[...document.querySelectorAll("a.mp-item-box-wrap")];
    }
    function nodeInfo(node){
      if(onScrap){
        return {
          name:scrapItemName(node),
          price:node.querySelector(".item-value-indicator")?.textContent||""
        };
      }
      return {
        name:node.querySelector(".item-name")?.textContent||"",
        price:node.querySelector(".item-price")?.textContent||""
      };
    }
    function timerText(expiresAt,label){
      const left=Math.max(0,Math.ceil((expiresAt-Date.now())/1000));
      const minutes=Math.floor(left/60),seconds=left%60;
      return `${label||"Checked"} · next in ${minutes}:${String(seconds).padStart(2,"0")}`;
    }
    // How much of an item is checked. A scrap.tf item has one direction (buy there,
    // sell on Backpack.tf). An STN item has two: that one, and buying on
    // Backpack.tf to sell to STN. Both fresh = full, one = partial. A row from
    // before directions existed (no "forward"/"reverse" keys) is a forward check.
    function checkedState(entry,info,now){
      if(!entry)return null;
      const legacy=entry.forward===undefined&&entry.reverse===undefined;
      const forward=legacy?entry:entry.forward;
      const reverse=legacy?null:entry.reverse;
      const samePrice=block=>block&&Number(block.expiresAt)>now&&norm(block.price)===norm(info.price);
      const done=[];
      if(samePrice(forward)&&(entry.source==="scrap.tf"?"scrap.tf":"stn")===site)done.push({dir:"forward",expiresAt:Number(forward.expiresAt)});
      if(!onScrap&&samePrice(reverse))done.push({dir:"reverse",expiresAt:Number(reverse.expiresAt)});
      if(!done.length)return null;
      const full=done.length>=(onScrap?1:2);
      const missing=full?"":(done[0].dir==="forward"?"Not yet checked: buying on Backpack.tf to sell to STN.":"Not yet checked: buying here to sell on Backpack.tf.");
      return {
        full,
        expiresAt:Math.min(...done.map(block=>block.expiresAt)),
        label:full?"Checked":"Half checked",
        title:full?"Checked in every direction; checked again when the timer ends":missing
      };
    }
    function unmark(node){
      node.classList.remove("tf2-arb-checked");
      node.querySelector(":scope > .tf2-arb-timer")?.remove();
      node.querySelector(":scope > .tf2-arb-veil")?.remove();
      if(node.dataset.tf2ArbSetPosition){
        node.style.position="";
        delete node.dataset.tf2ArbSetPosition;
      }
      delete node.dataset.tf2ArbExpires;
      delete node.dataset.tf2ArbLabel;
    }
    function mark(node,entry){
      node.classList.add("tf2-arb-checked");
      node.dataset.tf2ArbExpires=String(entry.expiresAt);
      node.dataset.tf2ArbLabel=entry.label;
      // The veil is positioned against the item, so the item must be positioned.
      // The "currently checking" highlight positions its item too, but only while
      // it is highlighted: measure without it, or the veil would later spread over
      // the whole page once the highlight moves on to the next item.
      const highlighted=node.classList.contains("tf2-arb-current-item");
      if(highlighted)node.classList.remove("tf2-arb-current-item");
      const isStatic=getComputedStyle(node).position==="static";
      if(highlighted)node.classList.add("tf2-arb-current-item");
      if(isStatic&&!node.dataset.tf2ArbSetPosition){
        node.style.position="relative";
        node.dataset.tf2ArbSetPosition="1";
      }
      if(!node.querySelector(":scope > .tf2-arb-veil")){
        const veil=document.createElement("span");
        veil.className="tf2-arb-veil";
        node.appendChild(veil);
      }
      // Fully checked items are grayed out; items checked one way only just slightly.
      node.querySelector(":scope > .tf2-arb-veil").classList.toggle("tf2-arb-veil-half",!entry.full);
      let badge=node.querySelector(":scope > .tf2-arb-timer");
      if(!badge){
        badge=document.createElement("span");
        badge.className="tf2-arb-timer";
        badge.appendChild(document.createTextNode(""));
        node.appendChild(badge);
      }
      const text=timerText(entry.expiresAt,entry.label);
      if(badge.firstChild.nodeValue!==text)badge.firstChild.nodeValue=text;
      if(badge.title!==entry.title)badge.title=entry.title;
    }

    function apply(){
      scheduled=false;
      const now=Date.now();
      for(const node of candidateNodes()){
        const info=nodeInfo(node);
        const state=checkedState(table[norm(info.name)],info,now);
        if(state)mark(node,state);
        else if(node.classList.contains("tf2-arb-checked"))unmark(node);
      }
    }
    function schedule(){
      if(scheduled)return;
      scheduled=true;
      setTimeout(apply,400);
    }
    // Counts down in place without touching the layout.
    function tick(){
      const now=Date.now();
      let expired=false;
      for(const node of document.querySelectorAll(".tf2-arb-checked")){
        const expiresAt=Number(node.dataset.tf2ArbExpires);
        if(!(expiresAt>now)){expired=true;continue}
        const badge=node.querySelector(":scope > .tf2-arb-timer");
        const text=timerText(expiresAt,node.dataset.tf2ArbLabel);
        if(badge?.firstChild&&badge.firstChild.nodeValue!==text)badge.firstChild.nodeValue=text;
      }
      if(expired)apply();
    }

    const load=()=>{
      try{
        const done=value=>{
          const stored=value&&value[KEY];
          table={};
          if(stored&&typeof stored==="object"){
            for(const entry of Object.values(stored))if(entry?.name)table[norm(entry.name)]=entry;
          }
          schedule();
        };
        if(typeof browser!=="undefined")browser.storage.local.get({[KEY]:{}}).then(done).catch(()=>{});
        else api.storage.local.get({[KEY]:{}},done);
      }catch(error){console.warn("TF2 Arbitrage: could not read the checked items.",error)}
    };
    load();
    api.storage.onChanged?.addListener((changes,area)=>{
      if(area!=="local"||!changes[KEY])return;
      const value=changes[KEY].newValue;
      table={};
      if(value&&typeof value==="object"){
        for(const entry of Object.values(value))if(entry?.name)table[norm(entry.name)]=entry;
      }
      schedule();
    });
    // The listings are rendered and re-rendered by the page (filters, paging).
    new MutationObserver(schedule).observe(document.body||document.documentElement,{childList:true,subtree:true});
    setInterval(tick,1000);
  }

  initTradedOrderMarkers();
  initCheckedMarkers();

  window.addEventListener("tf2mt-arbitrage-purchase-progress", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    const pageOfferId=location.pathname.match(/^\/tradeoffer\/(\d+)\/?$/i)?.[1]||"";
    if(!detail?.tradeOfferId||String(detail.tradeOfferId)!==pageOfferId)return;
    notifyBackground({
      type:"TRADE_PURCHASE_PROGRESS",
      tradeOfferId:pageOfferId,
      phase:String(detail.phase||"acceptance-in-progress"),
      message:String(detail.message||""),
      evidence:String(detail.evidence||"")
    });
  });

  window.addEventListener("tf2mt-arbitrage-purchase-accepted", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    const pageOfferId=location.pathname.match(/^\/tradeoffer\/(\d+)\/?$/i)?.[1]||"";
    if(!detail?.tradeOfferId||String(detail.tradeOfferId)!==pageOfferId||detail.confirmed!==true)return;
    notifyBackground({
      type:"TRADE_PURCHASE_ACCEPTED",
      jobId:String(detail.jobId||""),
      tradeOfferId:pageOfferId,
      confirmed:true,
      evidence:String(detail.evidence||""),
      evidenceSource:String(detail.evidenceSource||""),
      needsConfirmation:detail.needsConfirmation===true
    });
  });

  window.addEventListener("tf2mt-arbitrage-purchase-failed", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    const pageOfferId=location.pathname.match(/^\/tradeoffer\/(\d+)\/?$/i)?.[1]||"";
    if(!detail?.tradeOfferId||String(detail.tradeOfferId)!==pageOfferId)return;
    notifyBackground({
      type:"TRADE_PURCHASE_FAILED",
      tradeOfferId:pageOfferId,
      message:String(detail.message||"Steam did not confirm acceptance.")
    });
  });

  window.addEventListener("tf2mt-arbitrage-listing-sent", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    if(!detail?.jobId||!/^\/tradeoffer\/new\/?$/i.test(location.pathname))return;
    notifyBackground({
      type:"TRADE_LISTING_SENT",
      jobId:detail.jobId,
      tradeOfferId:/^\d+$/.test(String(detail.tradeOfferId||""))?String(detail.tradeOfferId):"",
      assetIds:(Array.isArray(detail.assetIds)?detail.assetIds:[])
        .map(String)
        .filter(id=>/^\d{1,20}$/.test(id))
    });
  });

  window.addEventListener("tf2mt-arbitrage-listing-retrying", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    if(!detail?.jobId||!/^\/tradeoffer\/new\/?$/i.test(location.pathname))return;
    notifyBackground({
      type:"TRADE_LISTING_RETRYING",
      jobId:String(detail.jobId),
      attempt:Number(detail.attempt)||0,
      maxAttempts:Number(detail.maxAttempts)||0,
      message:String(detail.message||"Steam rejected the trade offer; refreshing the page to retry.")
    });
  });

  window.addEventListener("tf2mt-arbitrage-listing-retry-failed", event => {
    let detail;
    try{detail=typeof event.detail==="string"?JSON.parse(event.detail):event.detail}catch{return}
    if(!detail?.jobId||!/^\/tradeoffer\/new\/?$/i.test(location.pathname))return;
    notifyBackground({
      type:"TRADE_LISTING_RETRY_FAILED",
      jobId:String(detail.jobId),
      message:String(detail.message||"Steam rejected the trade offer after the automatic page-refresh retry.")
    });
  });

  api.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
    if(msg.type==="READ_BUY_PAGE")sendResponse({items:readBuyPage()});
    if(msg.type==="SCRAP_BUY"){
      if(!isScrapTf()){sendResponse({ok:false,reason:"This is not a scrap.tf page."});return}
      scrapBuy(msg.name,msg.quantity,msg.maxScrapValue)
        .then(sendResponse)
        .catch(error=>sendResponse({ok:false,reason:error.message||String(error)}));
      return true;
    }
    if(msg.type==="SCRAP_QUEUE_STATE"){
      sendResponse(isScrapTf()?scrapQueueState():{status:"error",text:"This is not a scrap.tf page."});
      return;
    }
    if(msg.type==="SCRAP_CANCEL_QUEUE"){
      sendResponse(isScrapTf()?scrapCancelQueue():{ok:false});
      return;
    }
    if(msg.type==="QUICK_BUY_AMOUNT"){
      quickBuyAmount(msg.amount).then(sendResponse).catch(error=>sendResponse({ok:false,reason:error.message||String(error)}));
      return true;
    }
    if(msg.type==="AUTOMATED_QUICK_BUY"){
      waitForQuickBuyControl()
        // STN can expose the quantity selector before its page handlers finish
        // attaching (especially after reusing the transaction tab). Let the
        // item page settle before dispatching the one and only purchase click.
        .then(()=>new Promise(resolve=>setTimeout(resolve,1200)))
        .then(()=>quickBuyAmount(msg.amount,true))
        .then(sendResponse)
        .catch(error=>sendResponse({ok:false,reason:error.message||String(error)}));
      return true;
    }
    if(msg.type==="GET_STN_QUICKBUY_OPTIONS"){
      if(!/^(?:www\.)?stntrading\.eu$/i.test(location.hostname)||!location.pathname.startsWith("/item/")){
        sendResponse({status:"failed",reason:"This is not an STN item page."});
        return;
      }
      sendResponse(getQuickBuyOptions());
      return;
    }
    if(msg.type==="READ_STN_ITEM_PAGE"){
      sendResponse(readStnItemPage());
      return;
    }
    if(msg.type==="READ_STN_SELL_PAGE"){
      sendResponse(readStnSellPage());
      return;
    }
    if(msg.type==="READ_STATS_SELL_LISTINGS"){
      sendResponse(readStatsSellListings(msg.itemName,msg.desiredSpec||null));
      return;
    }
    if(msg.type==="HIGHLIGHT_MARKET_ITEM")sendResponse(highlightMarketItem(msg.itemName));
    if(msg.type==="HIGHLIGHT_LISTING")sendResponse(highlightListing(msg.accountId,msg.listingName,msg.itemName));
    if(msg.type==="HIGHLIGHT_LISTINGS")sendResponse(highlightListings(msg.listings,msg.itemName));
    if(msg.type==="CHECK_CLASSIFIEDS_READY")sendResponse(classifiedsState(msg.itemName));
    if(msg.type==="CHECK_BACKPACK_ERROR")sendResponse({error:detectBackpackServerError()});
    if(msg.type==="GET_PAGE_VISIBILITY")sendResponse({hidden:document.hidden,state:document.visibilityState});
    if(msg.type==="READ_STATS_BUY_ORDERS")sendResponse(readStatsBuyOrders(msg.itemName,msg.desiredSpec||null));
    if(msg.type==="READ_CLASSIFIEDS_LINK")sendResponse(readClassifiedsLink());
    if(msg.type==="READ_CLASSIFIEDS_PAGE")sendResponse(readClassifiedsPage(msg.itemName,msg.desiredSpec||null));
    if(msg.type==="READ_TRADE_OFFER_METAL"){
      readTradeOfferMetal(Number(msg.requiredRef))
        .then(sendResponse)
        .catch(error=>sendResponse({status:"unverified",reason:error.message||String(error)}));
      return true;
    }
    if(msg.type==="GET_STN_PURCHASE_OFFER"){
      if(!/^(?:www\.)?stntrading\.eu$/i.test(location.hostname)||!location.pathname.startsWith("/item/")){
        sendResponse({status:"unavailable",reason:"This is not an STN item page."});
        return;
      }
      const header=document.querySelector("#alert-header");
      const headerText=(header?.textContent||"").trim().replace(/\s+/g," ").toLowerCase();
      if(headerText==="your trade has been sent"){
        const content=document.querySelector("#alert-content");
        const offer=[...(content?.querySelectorAll("a[href]")||[])].find(anchor=>{
          const text=(anchor.textContent||"").trim().replace(/\s+/g," ").toLowerCase();
          return text==="open trade offer"&&/^https?:\/\/steamcommunity\.com\/tradeoffer\/\d+\/?$/i.test(anchor.getAttribute("href")||"");
        });
        sendResponse(offer?{status:"sent",url:offer.href}:{status:"pending",reason:"STN confirmed the purchase, but its trade-offer URL is not visible yet."});
        return;
      }
      // Every error alert STN's own script can raise for a purchase request.
      // Reporting them lets the add-on stop (or retry) immediately instead of
      // waiting minutes for an offer that will never arrive.
      const failureHeaderPattern=/^(?:error|purchase failed|trade error|an error occured sending your trade|some items in your selection were reserved by other users\.?|we are overstocked on this item|we failed to process your trade request|we were unable to process your request|your trade has expired)$/;
      if(failureHeaderPattern.test(headerText)){
        const detail=(document.querySelector("#alert-content")?.textContent||"").trim().replace(/\s+/g," ");
        const title=(header?.textContent||"").trim().replace(/\s+/g," ");
        sendResponse({status:"failed",reason:(detail?`${title}: ${detail}`:title||"STN reported a purchase error.").slice(0,320)});
        return;
      }
      sendResponse({status:"pending"});
      return;
    }
    if(msg.type==="GET_TMT_AUTOMATION_STATUS"){
      const panel=document.querySelector("#tf2-metal-trader");
      const status=panel?.querySelector("#tmt-status");
      const text=(status?.textContent||"").trim();
      sendResponse({
        status:status?.classList.contains("error")?"failed":"running",
        message:text
      });
      return;
    }
  });
})();
