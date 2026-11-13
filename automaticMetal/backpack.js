(() => {
  "use strict";

  function buildListingUrl(link) {
    const listing = link.closest(".listing-item");
    const item = listing?.querySelector(".item[data-listing_offers_url]");
    if (!item) {
      console.warn("TF2 Metal Trader: clicked trade button, but no listing item was found.");
      return null;
    }

    // Carry the listing direction and, for sell orders, the exact listed asset.
    const url = new URL(link.href, location.href);
    const params = new URLSearchParams();
    params.set("tmt_name", item.dataset.name || "");
    params.set("tmt_price", item.dataset.listing_price || "");
    params.set("tmt_listing", "1");
    const listingCard = listing.closest("li.listing") || listing;
    const intentElement = listingCard.querySelector(".listing-intent, .listing-type, [data-listing-intent]");
    params.set(
      "tmt_intent",
      item.dataset.listing_intent ||
        listingCard.dataset.listing_intent ||
        intentElement?.dataset?.listingIntent ||
        intentElement?.textContent?.trim() ||
        ""
    );
    params.set("tmt_comment", item.dataset.listing_comment || "");
    params.set(
      "tmt_description",
      [...listingCard.querySelectorAll(".quote-box p, .listing-comment, .listing-description")]
        .map(element => element.textContent.trim())
        .filter(Boolean)
        .join(" ")
    );

    // Sell orders may expose the exact Steam inventory asset in either the
    // trade URL (for_item=440_2_<assetid>) or Backpack.tf's listing element
    // itself (data-id=<assetid>). Prefer the trade URL when available, then
    // fall back to data-id. This matters for some managed sell listings,
    // including listings where the Steam trade URL does not carry for_item.
    const forItem = url.searchParams.get("for_item") || "";
    const assetMatch = forItem.match(/^440_2_(\d+)$/);
    const listingAssetId = String(item.dataset.id || "").match(/^\d+$/);
    const exactAssetId = assetMatch?.[1] || (item.dataset.listing_intent === "sell" && listingAssetId ? listingAssetId[0] : "");
    if (exactAssetId) params.set("tmt_asset", exactAssetId);

    // Put the payload in the fragment so Steam's trade URL does not need to
    // receive or understand these custom parameters.
    url.hash = params.toString();

    console.info("TF2 Metal Trader: original trade URL:", link.href);
    console.info("TF2 Metal Trader: enriched trade URL:", url.toString());
    return url.toString();
  }

  document.addEventListener("click", event => {
    // Do not depend on Backpack.tf's exact button classes. Any trade-offer
    // link inside a listing is enough for this test.
    const link = event.target.closest?.(
      'a[href*="steamcommunity.com/tradeoffer/new/"]'
    );

    if (!link) return;

    const enrichedUrl = buildListingUrl(link);
    if (!enrichedUrl) return;

    // Stop Backpack.tf's own click handler from opening the unmodified URL.
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    console.info("TF2 Metal Trader: opening enriched trade URL.");

    // Open synchronously from the user click, then assign the enriched URL.
    // This avoids another click/navigation handler replacing our URL.
    const newTab = window.open("about:blank", "_blank");
    if (newTab) {
      newTab.location.href = enrichedUrl;
    } else {
      console.warn("TF2 Metal Trader: popup was blocked; navigating current tab.");
      location.href = enrichedUrl;
    }
  }, true);


  // STN Trading sends the Steam offer from its own /item/ page. The alert is
  // created dynamically, so watch for the final "Your trade has been sent"
  // state instead of trying to catch it during the initial loading state.
  function getSentTradeOfferHref() {
    const header = document.querySelector("#alert-header");
    if (!header) return null;

    // The first STN popup is a loading message. We only care about
    // the final popup that explicitly says the trade was sent.
    const headerText = (header.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .toLowerCase();

    if (headerText !== "your trade has been sent") return null;

    const content = document.querySelector("#alert-content");
    if (!content) return null;

    // Find the exact button STN renders for opening the sent trade.
    const link = [...content.querySelectorAll("a[href]")].find(anchor => {
      const href = anchor.getAttribute("href") || "";
      const text = (anchor.textContent || "")
        .trim()
        .replace(/\s+/g, " ")
        .toLowerCase();

      return (
        text === "open trade offer" &&
        /^https?:\/\/steamcommunity\.com\/tradeoffer\/\d+\/?$/i.test(href)
      );
    });

    return link ? link.href : null;
  }

  function watchForSentTradeOffer() {
    if (!/^stntrading\.eu$/i.test(location.hostname)) return;
    if (!location.pathname.startsWith("/item/")) return;
    const pageParams = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (pageParams.has("tmt_arb_job")) return;

    let opened = false;

    const tryOpen = () => {
      if (opened) return;

      const href = getSentTradeOfferHref();
      if (!href) return;

      // Once we have the exact href from STN's own button, there is
      // nothing else to do. Ask Firefox to open that exact URL.
      opened = true;
      console.info("TF2 Metal Trader: STN sent-trade offer found. Opening:", href);

      browser.runtime.sendMessage({
        type: "tmt-open-trade-offer",
        url: href
      }).catch(error => {
        // Allow a retry if Firefox rejected the request to open the tab.
        opened = false;
        console.error("TF2 Metal Trader: could not open sent trade offer:", error);
      });
    };

    // It may already exist when the content script starts.
    tryOpen();

    // Otherwise, simply wait for STN to replace its loading popup with
    // the final "Your trade has been sent" popup.
    const observer = new MutationObserver(tryOpen);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  watchForSentTradeOffer();

  console.info("TF2 Metal Trader: Backpack.tf/STN bridge active.");
})();
