
brapi.runtime.onInstalled.addListener(function() {
  installContentScripts()
  installContextMenus()
  //scripts registered at runtime are dropped when the extension is updated
  syncSelectionButton(true)
})

/**
 * Toolbar icon. By default it reads the page directly, without the popup (2026-09-26 user decision);
 * the popup can be brought back in the options (iconOpensPopup), e.g. for its highlight window.
 * setPopup doesn't outlive the service worker reliably, so it's set again whenever the worker starts.
 */
syncIconPopup()

brapi.storage.onChanged.addListener(function(changes) {
  if (changes.iconOpensPopup) syncIconPopup()
})

async function syncIconPopup() {
  try {
    const {iconOpensPopup} = await getSettings(["iconOpensPopup"])
    await brapi.action.setPopup({popup: iconOpensPopup === true ? "popup.html?isPopup=1" : ""})
  }
  catch (err) {
    console.error("Cannot sync the icon popup", err)
  }
}

//no popup set: a click reads the clicked tab. On the tab being read it pauses/resumes;
//on another tab it ends that reading and starts this tab's (2026-09-26 user decision)
if (brapi.action)
brapi.action.onClicked.addListener(function(tab) {
  Promise.all([getPlaybackState(), getReadingTabId()])
    .then(function([stateInfo, readingTabId]) {
      const sameTab = tab && tab.id != null && tab.id == readingTabId
      switch (stateInfo.state) {
        case "PLAYING": return sameTab ? pause() : playTab(tab && tab.id)
        case "PAUSED": return sameTab ? resume() : playTab(tab && tab.id)
        case "STOPPED": return playTab(tab && tab.id)
      }
    })
    .catch(handleHeadlessError)
})

//the tab being (or paused while being) read: the embedded player sits inside it; a player tab
//of its own doesn't tell, then the last whole-page source (sourceUri) does
async function getReadingTabId() {
  const where = await sendToPlayer({method: "getPlayerTab"}).catch(err => null)
  if (where && where.embedded && where.tabId != null) return where.tabId
  const {sourceUri} = await brapi.storage.local.get("sourceUri")
  if (sourceUri && sourceUri.startsWith("contentscript:")) return Number(sourceUri.substr(14))
  return null
}


/**
 * IPC handlers
 */
var handlers = {
  playText: playText,
  playTab: playTab,
  reloadAndPlayTab: reloadAndPlayTab,
  stop: stop,
  pause: pause,
  resume: resume,
  getPlaybackState: getPlaybackState,
  forward: forward,
  rewind: rewind,
  seek: seek,
  authWavenet: authWavenet,
}

registerMessageListener("serviceWorker", handlers)


/**
 * Installers
 */
async function installContentScripts() {
  const scripts = [
    {
      matches: ["https://docs.google.com/document/*"],
      id: "google-docs",
      js: ["js/page/google-doc.js"],
      runAt: "document_start",
      world: "MAIN"
    },
  ]
  const registeredIds = await brapi.scripting.getRegisteredContentScripts({ids: scripts.map(x => x.id)})
    .then(scripts => scripts.map(x => x.id))
    .catch(err => {
      console.error(err)
      return []
    })
  if (registeredIds.length) {
    console.info("Already registered content scripts", registeredIds)
  }
  const scriptsToRegister = scripts.filter(script => !registeredIds.includes(script.id))
  for (const script of scriptsToRegister) {
    await brapi.scripting.registerContentScripts([script])
      .then(() => console.info("Successfully registered content script", script.id))
      .catch(err => console.error("Failed to register content script", script.id, err))
  }
}

/**
 * The red dot next to selected text (js/selection-button.js). On unless turned off in the options;
 * it needs access to all sites (host_permissions), and is registered only while it's on and allowed.
 */
const SELECTION_BUTTON_SCRIPT = {
  id: "selection-button",
  matches: ["http://*/*", "https://*/*"],
  js: ["js/selection-button.js"],
  allFrames: true,
  runAt: "document_idle",
}

brapi.storage.onChanged.addListener(function(changes) {
  if (changes.selectionButton) syncSelectionButton(true)
})
//site access limited in the browser's extension settings: the dot pauses, and comes back with the access
if (brapi.permissions.onRemoved) brapi.permissions.onRemoved.addListener(() => syncSelectionButton(false))
if (brapi.permissions.onAdded) brapi.permissions.onAdded.addListener(() => syncSelectionButton(true))

async function syncSelectionButton(injectOpenTabs) {
  try {
    const {selectionButton} = await getSettings(["selectionButton"])
    const on = selectionButton !== false
    const granted = await brapi.permissions.contains({origins: config.selectionButtonOrigins})
    const registered = (await brapi.scripting.getRegisteredContentScripts({ids: [SELECTION_BUTTON_SCRIPT.id]})).length > 0
    if (on && granted) {
      if (registered) return
      await brapi.scripting.registerContentScripts([SELECTION_BUTTON_SCRIPT])
      //pages opened before it was turned on get it too
      if (injectOpenTabs) {
        const tabs = await brapi.tabs.query({url: SELECTION_BUTTON_SCRIPT.matches})
        for (const tab of tabs) {
          brapi.scripting.executeScript({target: {tabId: tab.id, allFrames: true}, files: SELECTION_BUTTON_SCRIPT.js})
            .catch(() => {})
        }
      }
    }
    else {
      if (registered) await brapi.scripting.unregisterContentScripts({ids: [SELECTION_BUTTON_SCRIPT.id]})
      //site access limited: pages that have the dot stop showing it too (turned off in the options,
      //they see the setting change themselves)
      if (on && !granted) {
        const tabs = await brapi.tabs.query({})
        for (const tab of tabs) {
          brapi.tabs.sendMessage(tab.id, {dest: "selectionButton", method: "pause"})
            .catch(() => {})
        }
      }
    }
  }
  catch (err) {
    console.error("Cannot update the selection button", err)
  }
}

function installContextMenus() {
  if (brapi.contextMenus)
  brapi.contextMenus.create({
    id: "read-selection",
    title: brapi.i18n.getMessage("context_read_selection"),
    contexts: ["selection"]
  },
  function() {
    if (brapi.runtime.lastError) console.error(brapi.runtime.lastError)
    else console.info("Installed context menus")
  })
}


/**
 * Context menu handlers
 */
if (brapi.contextMenus)
brapi.contextMenus.onClicked.addListener(function(info, tab) {
  if (info.menuItemId == "read-selection")
    readSelectionInTab(tab, info.frameId, info.selectionText)
      .catch(handleHeadlessError)
})

//the red dot next to selected text (js/selection-button.js): the frame that sent it has the selection
brapi.runtime.onMessage.addListener(function(request, sender) {
  if (request.dest == "readSelection" && sender.tab)
    readSelectionInTab(sender.tab, sender.frameId, request.text)
      .catch(handleHeadlessError)
})

async function readSelectionInTab(tab, frameId, fallbackText) {
  const hasTab = tab && tab.id != -1
  const sessionId = newPageUiSessionId()
  //the context menu's info.selectionText has line breaks collapsed: read the selection from the page
  //to keep paragraph breaks (fallbackText is used only when that fails)
  const captured = hasTab ? await captureSelection(tab.id, frameId, sessionId) : null
  const text = (captured && captured.text) || fallbackText
  const lang = hasTab ? await detectTabLanguage(tab.id) : undefined
  const ui = hasTab ? {
    sessionId,
    tabId: tab.id,
    selection: true,
    highlight: !!(captured && captured.mappable && captured.text == text),
    highlightFrameId: frameId || 0,
  } : null
  return playText(text, {lang: lang, splitParagraphs: true}, ui)
}


/**
 * Shortcut keys handlers
 */
if (brapi.commands)
brapi.commands.onCommand.addListener(function(command) {
  if (command == "play") {
    getPlaybackState()
      .then(function(stateInfo) {
        switch (stateInfo.state) {
          case "PLAYING": return pause()
          case "PAUSED": return resume()
          case "STOPPED": return playTab()
        }
      })
      .catch(handleHeadlessError)
  }
  else if (command == "stop") {
    stop()
      .catch(handleHeadlessError)
  }
  else if (command == "forward") {
    forward()
      .catch(handleHeadlessError)
  }
  else if (command == "rewind") {
    rewind()
      .catch(handleHeadlessError)
  }
})


/**
 * Listener for external calls
 */
brapi.runtime.onMessageExternal.addListener(
  (request, sender) => {
    if (request.method == "play" && typeof request.text == "string") {
      playText(request.text)
        .catch(handleHeadlessError)
    }
    else if (request.method == "pause") {
      pause()
        .catch(handleHeadlessError)
    }
    else if (request.method == "stop") {
      stop()
        .catch(handleHeadlessError)
    }
    else if (request.method == "resume") {
      resume()
        .catch(handleHeadlessError)
    }
    else {
      handleHeadlessError(new Error("Bad method call"))
    }
  })



/**
 * METHODS
 */
var currentTask = {
  task: null,
  isActive() {
    return this.task && this.task.isActive
  },
  begin() {
    if (this.task) this.task.cancel()
    return this.task = {
      isActive: true,
      cancel() {
        this.isActive = false
      },
      end() {
        if (!this.isActive) throw new Error("Canceled")
        this.isActive = false
      }
    }
  },
  cancel() {
    if (this.task) {
      this.task.cancel()
      this.task = null
    }
  }
}

async function playText(text, opts, ui) {
  //the player goes inside the page read from (a selection's tab), which may not be the active one
  const tab = ui && await getTab(ui.tabId) || await getActiveTab()
  if (!await readyPlayer(tab)) await injectPlayer(tab)
  if (ui) await startPageUi(ui)
  await sendToPlayer({method: "playText", args: [text, opts]})
}

async function playTab(tabId) {
  const tab = tabId ? await getTab(tabId) : await getActiveTab()
  if (!tab) throw new Error(JSON.stringify({code: "error_page_unreadable"}))

  const task = currentTask.begin()
  let ui = null
  try {
    const handler = contentHandlers.find(h => h.match(tab.url || "", tab.title))
    if (handler.validate) await handler.validate(tab)
    if (handler.getSourceUri) {
      const sourceUri = handler.getSourceUri(tab)
      await brapi.storage.local.set({"sourceUri": sourceUri})
    }
    else {
      const frameId = handler.getFrameId && await getAllFrames(tab.id).then(frames => handler.getFrameId(frames))
      if (!await contentScriptAlreadyInjected(tab, frameId)) await injectContentScript(tab, frameId, handler.extraScripts)
      await brapi.storage.local.set({"sourceUri": "contentscript:" + tab.id})
      //docHighlight: the source highlight over the page, like selection reading; documents whose
      //content script leaves no paragraph map (js/content/html-doc.js) just show no highlight
      ui = {sessionId: newPageUiSessionId(), tabId: tab.id, highlight: true, docHighlight: true, highlightFrameId: frameId || 0}
    }
  }
  finally {
    task.end()
  }

  if (!await readyPlayer(tab)) await injectPlayer(tab)
  if (ui) await startPageUi(ui)
  await sendToPlayer({method: "playTab"})
}

//stops the player; true if it's there to read in this tab. One inside another page is closed instead: that page
//going (closed, or elsewhere) would stop the reading
async function readyPlayer(tab) {
  const hasPlayer = await stop().then(res => res == true, err => false)
  if (!hasPlayer) return false
  const where = await sendToPlayer({method: "getPlayerTab"}).catch(err => null)
  if (where && where.embedded && tab && where.tabId != tab.id) {
    await sendToPlayer({method: "close"}).catch(console.error)
    return false
  }
  return true
}



/**
 * Page playback UI: playback bar on top of the page, and highlight of the selection being read.
 * The UI lives in js/page-ui.js (page side) and js/page-ui-host.js (player side).
 * Failing to show it never stops the reading itself.
 */
const PAGE_UI_HIGHLIGHT_CSS = `
  ::highlight(readaloud-hrg-para) { background-color: rgba(255, 226, 0, 0.3); }
  ::highlight(readaloud-hrg-word) { background-color: rgba(255, 213, 0, 0.9); color: #000; }
`
let pageUiSessionSeq = 0

function newPageUiSessionId() {
  return Date.now().toString(36) + "." + (++pageUiSessionSeq)
}

async function captureSelection(tabId, frameId, sessionId) {
  try {
    const target = {tabId, frameIds: [frameId || 0]}
    await brapi.scripting.executeScript({target, files: ["js/page-ui.js"]})
    const [item] = await brapi.scripting.executeScript({
      target,
      func: id => window.__readAloudHrgUi.captureSelection(id),
      args: [sessionId],
    })
    return item && item.result
  }
  catch (err) {
    console.warn("Cannot read selection from page", err)
    return null
  }
}

async function startPageUi(ui) {
  try {
    await sendToPlayer({method: "beginUiSession", args: [ui]})
  }
  catch (err) {
    console.warn("Cannot start page UI session", err)
    return
  }
  //not awaited: reading starts right away, the bar shows up as soon as it's injected
  showPageUi(ui)
}

async function showPageUi(ui) {
  //the bar and the highlight can live in different frames: failing one doesn't stop the other
  await Promise.all([showPageBar(ui), ui.highlight && showPageHighlight(ui)])
}

async function showPageBar(ui) {
  try {
    const top = {tabId: ui.tabId, frameIds: [0]}
    await brapi.scripting.executeScript({target: top, files: ["js/page-ui.js"]})
    await brapi.scripting.executeScript({target: top, func: id => window.__readAloudHrgUi.startBar(id), args: [ui.sessionId]})
  }
  catch (err) {
    console.warn("Cannot show playback bar on page", err)
  }
}

async function showPageHighlight(ui) {
  try {
    const target = {tabId: ui.tabId, frameIds: [ui.highlightFrameId]}
    await brapi.scripting.insertCSS({target, css: PAGE_UI_HIGHLIGHT_CSS})
    //whole-page reading hasn't injected it yet (selection reading does in captureSelection)
    await brapi.scripting.executeScript({target, files: ["js/page-ui.js"]})
    await brapi.scripting.executeScript({
      target,
      func: (id, doc) => window.__readAloudHrgUi.startHighlight(id, doc ? {doc: true} : undefined),
      args: [ui.sessionId, !!ui.docHighlight],
    })
  }
  catch (err) {
    console.warn("Cannot highlight the selection on page", err)
  }
}

async function reloadAndPlayTab(tabId) {
  const tab = tabId ? await getTab(tabId) : await getActiveTab()

  const task = currentTask.begin()
  try {
    const tabLoadComplete = new Promise(fulfill => {
      function listener(changeTabId, changeInfo) {
        if (changeTabId == tab.id && changeInfo.status == "complete") {
          brapi.tabs.onUpdated.removeListener(listener)
          fulfill()
        }
      }
      brapi.tabs.onUpdated.addListener(listener)
    })
    await brapi.tabs.reload(tab.id)
    await tabLoadComplete
  }
  finally {
    task.end()
  }

  await playTab(tab.id)
}

function stop() {
  currentTask.cancel()
  return sendToPlayer({method: "stop"})
}

function pause() {
  return sendToPlayer({method: "pause"})
}

function resume() {
  return sendToPlayer({method: "resume"})
}

async function getPlaybackState() {
  if (currentTask.isActive()) return {state: "LOADING"}
  try {
    return await sendToPlayer({method: "getPlaybackState"}) || {state: "STOPPED"}
  }
  catch (err) {
    return {state: "STOPPED"}
  }
}

function forward() {
  return sendToPlayer({method: "forward"})
}

function rewind() {
  return sendToPlayer({method: "rewind"})
}

function seek(n) {
  return sendToPlayer({method: "seek", args: [n]})
}



function handleHeadlessError(err) {
  console.error(err)
  //TODO: let user knows somehow
}

function authWavenet() {
  createTab("https://cloud.google.com/text-to-speech/#put-text-to-speech-into-action", true)
    .then(function(tab) {
      addRequestListener();
      brapi.tabs.onRemoved.addListener(onTabRemoved);
      return showInstructions();

      function addRequestListener() {
        brapi.webRequest.onBeforeRequest.addListener(onRequest, {
          urls: ["https://cxl-services.appspot.com/proxy*"],
          tabId: tab.id
        })
      }
      function onTabRemoved(tabId) {
        if (tabId == tab.id) {
          brapi.tabs.onRemoved.removeListener(onTabRemoved);
          brapi.webRequest.onBeforeRequest.removeListener(onRequest);
        }
      }
      function onRequest(details) {
        var parser = new URL(details.url);
        var qs = parser.search ? parseQueryString(parser.search) : {};
        if (qs.token) {
          updateSettings({gcpToken: qs.token});
          showSuccess();
        }
      }
      function showInstructions() {
        return brapi.scripting.executeScript({
          target: {tabId: tab.id},
          func: function() {
            var elem = document.createElement('DIV')
            elem.id = 'ra-notice'
            elem.style.position = 'fixed'
            elem.style.top = '0'
            elem.style.left = '0'
            elem.style.right = '0'
            elem.style.backgroundColor = 'yellow'
            elem.style.padding = '20px'
            elem.style.fontSize = 'larger'
            elem.style.zIndex = 999000
            elem.style.textAlign = 'center'
            elem.innerHTML = 'Please click the blue SPEAK-IT button, then check the I-AM-NOT-A-ROBOT checkbox.'
            document.body.appendChild(elem)
          }
        })
      }
      function showSuccess() {
        return brapi.scripting.executeScript({
          target: {tabId: tab.id},
          func: function() {
            var elem = document.getElementById('ra-notice')
            elem.style.backgroundColor = '#0d0'
            elem.innerHTML = 'Successful, you can now use Google Wavenet voices. You may close this tab.'
          }
        })
      }
    })
}




async function contentScriptAlreadyInjected(tab, frameId) {
  const items = await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    func: function() {
      return typeof brapi != "undefined"
    }
  })
  return items[0].result == true
}

async function injectContentScript(tab, frameId, extraScripts) {
  await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    files: [
      "js/rxjs.umd.min.js",
      "js/jquery-3.7.1.min.js",
      "js/defaults.js",
      "js/messaging.js",
      "js/content.js",
    ]
  })
  const files = extraScripts || await brapi.tabs.sendMessage(tab.id, {dest: "contentScript", method: "getRequireJs"})
  await brapi.scripting.executeScript({
    target: {
      tabId: tab.id,
      frameIds: frameId ? [frameId] : undefined,
    },
    files: files
  })
  console.info("Content handler", files)
}

//the player goes inside the page being read, out of sight, unless the tab was chosen in the options
//(useEmbeddedPlayer false); pages it can't go into get the tab
async function injectPlayer(tab) {
  const settings = await getSettings(["useEmbeddedPlayer"])
  const promise = new Promise(f => handlers.playerCheckIn = f)
  if (tab && settings.useEmbeddedPlayer !== false && canUseEmbeddedPlayer()) {
    try {
      if (tab.incognito) {
        //https://developer.chrome.com/docs/extensions/mv3/manifest/incognito/
        throw new Error("Incognito tab")
      }
      await brapi.scripting.executeScript({
        target: {tabId: tab.id},
        func: createPlayerFrame,
        args: [tab.id],
      })
    }
    catch (err) {
      console.warn("Cannot embed player", err)
      await createPlayerTab()
    }
  }
  else {
    await createPlayerTab()
  }
  await promise
}

//tabId: the tab it's in, which the player tells (getPlayerTab)
function createPlayerFrame(tabId) {
  const brapi = (typeof chrome != 'undefined') ? chrome : (typeof browser != 'undefined' ? browser : {})
  const frame = document.createElement("iframe")
  frame.src = brapi.runtime.getURL("player.html?tab=" + tabId)
  frame.style.position = "absolute"
  frame.style.height = "0"
  frame.style.borderWidth = "0"
  document.body.appendChild(frame)
}

//only ever one: a player tab still there didn't answer (injectPlayer is called when none did), so it goes
async function createPlayerTab() {
  const playerUrl = brapi.runtime.getURL("player.html")
  const left = (await brapi.tabs.query({})).filter(tab => (tab.url || tab.pendingUrl || "").startsWith(playerUrl))
  if (left.length) await brapi.tabs.remove(left.map(tab => tab.id)).catch(console.error)
  const tab = await brapi.tabs.create({
    url: brapi.runtime.getURL("player.html?autoclose"),
    index: 0,
    active: false,
  })
  await brapi.tabs.update(tab.id, {pinned: true})
}



async function sendToPlayer(message) {
  message.dest = "player"
  const result = await brapi.runtime.sendMessage(message)
  if (result && result.error) throw result.error
  else return result
}
