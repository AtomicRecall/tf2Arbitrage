// Keeps logins across browser restarts.
//
// Firefox discards "session" cookies (no expiry date) when it quits, unless it
// is restoring the previous session. Steam, STN, scrap.tf and backpack.tf keep parts of a
// login in such cookies, and this browser opens on a fixed home page instead of
// restoring tabs, so those logins would be lost every time. This turns session
// cookies of the sites below into cookies that last KEEP_SECONDS.
//
// A login that the site ends itself (logout, expiry) is not revived: removals
// are ignored, only newly set session cookies are made persistent.
(function(root){
  const api=typeof browser!=="undefined"?browser:(typeof chrome!=="undefined"?chrome:null);
  const KEEP_DOMAINS=["steamcommunity.com","steampowered.com","stntrading.eu","scrap.tf","backpack.tf"];
  const KEEP_SECONDS=30*24*60*60;
  const SETTING_KEY="keepLogins";

  function domainMatches(domain){
    const host=String(domain||"").replace(/^\./,"").toLowerCase();
    return KEEP_DOMAINS.some(site=>host===site||host.endsWith(`.${site}`));
  }

  // The details for cookies.set() that make `cookie` persistent, or null when
  // it should be left alone (not a session cookie, or not one of our sites).
  function persistentDetails(cookie,nowSeconds){
    if(!cookie||cookie.session!==true||!domainMatches(cookie.domain))return null;
    const host=String(cookie.domain).replace(/^\./,"");
    const path=cookie.path||"/";
    const details={
      url:`http${cookie.secure?"s":""}://${host}${path}`,
      name:cookie.name,
      value:cookie.value,
      path,
      secure:Boolean(cookie.secure),
      httpOnly:Boolean(cookie.httpOnly),
      expirationDate:nowSeconds+KEEP_SECONDS
    };
    // A host-only cookie must be set without a domain, or it would widen to subdomains.
    if(!cookie.hostOnly)details.domain=cookie.domain;
    if(cookie.sameSite&&cookie.sameSite!=="unspecified")details.sameSite=cookie.sameSite;
    if(cookie.storeId)details.storeId=cookie.storeId;
    if(cookie.firstPartyDomain!==undefined)details.firstPartyDomain=cookie.firstPartyDomain;
    if(cookie.partitionKey)details.partitionKey=cookie.partitionKey;
    return details;
  }

  async function keepEnabled(){
    try{
      const stored=await api.storage.local.get({[SETTING_KEY]:true});
      return stored[SETTING_KEY]!==false;
    }catch{return true}
  }

  async function persistCookie(cookie){
    const details=persistentDetails(cookie,Math.floor(Date.now()/1000));
    if(!details)return false;
    try{
      await api.cookies.set(details);
      return true;
    }catch(error){
      console.warn(`Could not keep the ${cookie.name} cookie of ${cookie.domain}:`,error?.message||error);
      return false;
    }
  }

  // Makes every session cookie that already exists persistent.
  async function sweep(){
    let kept=0;
    const cookies=await api.cookies.getAll({});
    for(const cookie of cookies){
      if(await persistCookie(cookie))kept++;
    }
    return kept;
  }

  function start(){
    if(!api?.cookies?.onChanged)return;
    api.cookies.onChanged.addListener(async change=>{
      if(change.removed||!change.cookie?.session)return;
      if(await keepEnabled())await persistCookie(change.cookie);
    });
    // Switching the option on keeps what is already there.
    api.storage.onChanged.addListener((changes,area)=>{
      if(area==="local"&&changes[SETTING_KEY]?.newValue===true)sweep().catch(()=>{});
    });
    keepEnabled().then(enabled=>enabled?sweep():0)
      .then(count=>{if(count)console.log(`Cookie keeper: made ${count} session cookies persistent.`)})
      .catch(error=>console.warn("Cookie keeper sweep failed:",error));
  }

  const exported={KEEP_DOMAINS,KEEP_SECONDS,SETTING_KEY,domainMatches,persistentDetails,start};
  if(typeof module!=="undefined"&&module.exports)module.exports=exported;
  else{root.TF2CookieKeeper=exported;start()}
})(typeof self!=="undefined"?self:this);
