/*
 * A small red dot shown next to selected text; clicking it reads the selection, the same as the
 * context menu's "Read selection". On unless turned off in the options, registered on every page by
 * syncSelectionButton() in js/events.js.
 */
(function() {
  const brapi = (typeof chrome != 'undefined') ? chrome : (typeof browser != 'undefined' ? browser : {})
  const existing = window.__readAloudHrgSelectionButton
  if (existing && typeof existing.isAlive == "function" && existing.isAlive()) return
  //left behind by a previous version of the extension (reloaded/updated): clean it up
  if (existing && typeof existing.destroy == "function") existing.destroy()

  const SIZE = 22       //clickable area
  const DOT = 12        //the visible dot
  const GAP = 4         //from the end of the selection

  let button = null     //{host, range}
  let pending = null

  window.__readAloudHrgSelectionButton = {isAlive, destroy}
  listen(true)


  function listen(on) {
    const method = on ? "addEventListener" : "removeEventListener"
    document[method]("mouseup", onSelectionMaybeChanged, true)
    document[method]("keyup", onSelectionMaybeChanged, true)
    document[method]("selectionchange", onSelectionChange)
    window[method]("scroll", reposition, true)
    window[method]("resize", reposition)
    try {
      if (on) {
        brapi.storage.onChanged.addListener(onSettingsChanged)
        brapi.runtime.onMessage.addListener(onMessage)
      }
      else {
        brapi.storage.onChanged.removeListener(onSettingsChanged)
        brapi.runtime.onMessage.removeListener(onMessage)
      }
    }
    catch (err) {}
  }

  function isAlive() {
    try {
      return !!brapi.runtime.id
    }
    catch (err) {
      return false
    }
  }

  function destroy() {
    listen(false)
    clearTimeout(pending)
    if (button) button.host.remove()
    button = null
    //turned on again later: the script injected into this page then starts over
    if (window.__readAloudHrgSelectionButton && window.__readAloudHrgSelectionButton.destroy == destroy) {
      delete window.__readAloudHrgSelectionButton
    }
  }

  //turned off in the options: pages that already have it stop showing it
  function onSettingsChanged(changes) {
    if (changes.selectionButton && changes.selectionButton.newValue === false) destroy()
  }

  //site access limited in the browser's extension settings (syncSelectionButton() in js/events.js);
  //given back, the script is injected again
  function onMessage(message) {
    if (message && message.dest == "selectionButton" && message.method == "pause") destroy()
  }

  function onSelectionMaybeChanged(event) {
    if (button && event.composedPath().includes(button.host)) return
    //let the browser finish updating the selection first
    clearTimeout(pending)
    pending = setTimeout(update)
  }

  function onSelectionChange() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed) hide()
  }

  function update() {
    if (!isAlive()) return destroy()
    const range = selectedRange()
    if (range) show(range)
    else hide()
  }

  //a text selection, but not while editing (fields, rich-text editors): the dot would get in the way
  function selectedRange() {
    const selection = window.getSelection()
    if (!selection || selection.isCollapsed || !selection.rangeCount) return null
    if (!selection.toString().trim()) return null
    const active = document.activeElement
    if (active && (active.isContentEditable || /^(INPUT|TEXTAREA)$/.test(active.tagName))) return null
    return selection.getRangeAt(0)
  }

  function show(range) {
    if (!button) create()
    button.range = range
    reposition()
  }

  function hide() {
    if (!button) return
    button.range = null
    button.host.style.setProperty("display", "none", "important")
  }

  //right after the last line of the selection, kept inside the window
  function reposition() {
    if (!button || !button.range) return
    const rects = button.range.getClientRects()
    const line = rects[rects.length - 1]
    if (!line || line.bottom < 0 || line.top > window.innerHeight) {
      button.host.style.setProperty("display", "none", "important")
      return
    }
    const left = Math.max(0, Math.min(line.right + GAP, window.innerWidth - SIZE))
    const top = Math.max(0, Math.min(line.top + (line.height - SIZE) / 2, window.innerHeight - SIZE))
    const style = button.host.style
    style.setProperty("left", left + "px", "important")
    style.setProperty("top", top + "px", "important")
    style.setProperty("display", "block", "important")
  }

  function create() {
    const host = document.createElement("readaloud-hrg-selection-button")
    host.className = "no-read-aloud"
    for (const [name, value] of Object.entries({
      all: "initial", display: "none", position: "fixed", width: SIZE + "px", height: SIZE + "px", "z-index": "2147483647",
    })) host.style.setProperty(name, value, "important")
    const shadow = host.attachShadow({mode: "closed"})
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(`
      button {
        all: unset;
        box-sizing: border-box;
        width: ${SIZE}px;
        height: ${SIZE}px;
        display: flex;
        align-items: center;
        justify-content: center;
        border-radius: 50%;
        cursor: pointer;
      }
      button::before {
        content: "";
        width: ${DOT}px;
        height: ${DOT}px;
        border-radius: 50%;
        background: #ff3b30;
        transition: transform 0.1s;
      }
      button:hover::before {
        transform: scale(1.25);
      }
      button:focus-visible {
        outline: 2px solid #8fb3ff;
      }
    `)
    shadow.adoptedStyleSheets = [sheet]
    const dot = document.createElement("button")
    dot.type = "button"
    dot.title = message("selection_button_title", "Read the selected text")
    dot.setAttribute("aria-label", dot.title)
    //pressing it must not clear the selection, and the page shouldn't react to it
    for (const type of ["pointerdown", "mousedown"]) {
      dot.addEventListener(type, event => {
        event.preventDefault()
        event.stopPropagation()
      })
    }
    dot.addEventListener("click", event => {
      event.preventDefault()
      event.stopPropagation()
      read()
    })
    shadow.append(dot)
    //on <html>, not <body>: a transform/filter on body would make "fixed" relative to the body
    document.documentElement.append(host)
    button = {host, range: null}
  }

  //the service worker reads the selection from this frame (js/events.js readSelectionInTab)
  function read() {
    const text = window.getSelection().toString().trim()
    hide()
    if (!isAlive()) return destroy()
    brapi.runtime.sendMessage({dest: "readSelection", text})
      .catch(() => {})
  }

  function message(name, fallback) {
    try {
      return brapi.i18n.getMessage(name) || fallback
    }
    catch (err) {
      return fallback
    }
  }
})();
