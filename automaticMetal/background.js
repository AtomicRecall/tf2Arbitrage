browser.runtime.onMessage.addListener((message, sender) => {
  if (!message) return;

  if (message.type === "tmt-open-trade-offer") {
    const url = String(message.url || "").trim();
    if (!/^https?:\/\/steamcommunity\.com\/tradeoffer\/\d+\/?$/i.test(url)) {
      return Promise.reject(new Error("Refused to open an invalid Steam trade-offer URL."));
    }
    return browser.tabs.create({ url }).then(() => ({ ok: true }));
  }

  if (message.type === "tmt-close-current-tab") {
    const tabId = sender?.tab?.id;
    if (typeof tabId !== "number") {
      return Promise.reject(new Error("Could not determine the current trade-offer tab."));
    }
    return browser.tabs.remove(tabId).then(() => ({ ok: true }));
  }
});
