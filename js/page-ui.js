/*
 * Page playback UI — injected into the web page by js/events.js.
 *   bar        playback bar fixed to the top of the page: progress, elapsed/total time,
 *              previous/next paragraph, pause/resume, mute, stop
 *   highlight  marks the part of the right-click selection that is being read
 * Both are driven by the player through a port (js/page-ui-host.js). When the port closes
 * (reading ended, player closed) the UI removes itself.
 */
(function() {
  const brapi = (typeof chrome != 'undefined') ? chrome : (typeof browser != 'undefined' ? browser : {})
  const existing = window.__readAloudHrgUi
  if (existing && typeof existing.isAlive == "function" && existing.isAlive()) return
  //left behind by a previous version of the extension (reloaded/updated): clean it up
  if (existing && typeof existing.destroy == "function") existing.destroy()

  const PORT_NAME = "readaloud-hrg-ui"
  const HIGHLIGHT_PARA = "readaloud-hrg-para"
  const HIGHLIGHT_WORD = "readaloud-hrg-word"

  let bar = null
  let highlight = null
  let captured = null
  let docSpans = null

  window.__readAloudHrgUi = {
    isAlive,
    destroy,
    captureSelection,
    startBar,
    startHighlight,
    docMapChanged,
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
    removeBar()
    removeHighlight()
    captured = null
    docSpans = null
  }



  //selection capture ----------------------------------------------------------

  /**
   * Reads the current selection keeping its line breaks (info.selectionText collapses them)
   * and remembers where each of its characters sits in the DOM, for the highlight.
   */
  function captureSelection(sessionId) {
    captured = null
    const active = document.activeElement
    if (active && active.tagName == "TEXTAREA" && typeof active.selectionStart == "number") {
      return {text: active.value.slice(active.selectionStart, active.selectionEnd).trim(), mappable: false}
    }
    const selection = window.getSelection()
    if (!selection || !selection.rangeCount) return {text: "", mappable: false}
    const text = selection.toString().trim()
    const range = selection.getRangeAt(0).cloneRange()
    let map = null
    try {
      map = mapTextToNodes(text, range)
    }
    catch (err) {
      console.error("Blueming Web Read Aloud: cannot map the selection", err)
    }
    if (map) captured = {sessionId, text, range, released: false, ...map}
    return {text, mappable: !!map}
  }

  /**
   * Walks the selected text nodes alongside selection.toString(), pairing their visible
   * characters in order. Whitespace is compared loosely because toString() reflows it.
   * Stops at the first real mismatch; everything before it stays mappable.
   * lenient (whole-page reading, whose text is innerText plus inserted characters — a '.' added
   * to a line, list numbering): a mismatched character is taken as inserted and skipped on the
   * text side only, and the walk goes on.
   */
  function mapTextToNodes(text, range, lenient, dropNode) {
    const nodes = selectedTextNodes(range, dropNode)
    const nodeOf = new Int32Array(text.length).fill(-1)
    const offsetOf = new Int32Array(text.length).fill(-1)
    let ni = 0
    let off = nodes.length ? nodes[0].start : 0
    let mapped = 0
    for (let i = 0; i < text.length; i++) {
      const c = text[i]
      if (isSkippable(c)) continue
      let found = false
      while (ni < nodes.length) {
        const value = nodes[ni].node.nodeValue
        while (off < nodes[ni].end && isSkippable(value[off])) off++
        if (off < nodes[ni].end) {
          found = true
          break
        }
        ni++
        if (ni < nodes.length) off = nodes[ni].start
      }
      if (!found) break
      if (!sameChar(nodes[ni].node.nodeValue[off], c)) {
        if (lenient) continue
        break
      }
      nodeOf[i] = ni
      offsetOf[i] = off
      off++
      mapped++
    }
    return mapped ? {nodes, nodeOf, offsetOf} : null
  }

  //text nodes whose text selection.toString() includes: laid out, visible and selectable.
  //dropNode: an extra exclusion (whole-page reading drops what the extraction didn't read)
  function selectedTextNodes(range, dropNode) {
    const result = []
    const cache = new Map()
    const add = node => {
      if (!node.nodeValue || !isInSelectionText(node, cache)) return
      if (dropNode && dropNode(node, cache)) return
      const start = node == range.startContainer ? range.startOffset : 0
      const end = node == range.endContainer ? range.endOffset : node.nodeValue.length
      if (start < end) result.push({node, start, end})
    }
    const root = range.commonAncestorContainer
    if (root.nodeType == Node.TEXT_NODE) {
      add(root)
    }
    else {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (range.intersectsNode(node)) add(node)
      }
    }
    return result
  }

  function isInSelectionText(textNode, cache) {
    const parent = textNode.parentElement
    if (!parent || parent.closest("script, style, noscript, template")) return false
    if (getComputedStyle(parent).visibility != "visible") return false
    if (!isSelectable(parent, cache)) return false
    if (parent.tagName == "DETAILS" && !parent.open) return false     //loose text of a closed <details>
    if (isSkippedContent(parent, cache)) return false
    //the text's own boxes, not its parent's: a display:contents parent has none but its text does
    const range = document.createRange()
    range.selectNodeContents(textNode)
    return range.getClientRects().length > 0
  }

  //user-select isn't inherited but "auto" follows the parent: the nearest non-auto value decides
  function isSelectable(elem, cache) {
    if (!elem) return true
    const key = "selectable"
    const cached = cache.get(elem)
    if (cached && key in cached) return cached[key]
    const style = getComputedStyle(elem)
    const value = style.userSelect || style.webkitUserSelect
    const result = value == "none" ? false : value && value != "auto" ? true : isSelectable(elem.parentElement, cache)
    cache.set(elem, {...cached, [key]: result})
    return result
  }

  //inside content the browser skips: content-visibility:hidden, or a closed <details> outside its summary
  function isSkippedContent(elem, cache) {
    if (!elem) return false
    const key = "skipped"
    const cached = cache.get(elem)
    if (cached && key in cached) return cached[key]
    const up = elem.parentElement
    const result = getComputedStyle(elem).contentVisibility == "hidden"
      || !!(up && up.tagName == "DETAILS" && !up.open && elem.tagName != "SUMMARY")
      || isSkippedContent(up, cache)
    cache.set(elem, {...cache.get(elem), [key]: result})
    return result
  }

  function isSkippable(c) {
    //whitespace, soft hyphen and zero-width characters don't survive selection.toString() reliably
    return /[\s­​-‍⁠﻿]/.test(c)
  }

  function sameChar(a, b) {
    return a == b || a.toLowerCase() == b.toLowerCase()
  }



  //highlight --------------------------------------------------------------------

  //opts.doc: whole-page reading — offsets refer to the extracted paragraphs (js/content/html-doc.js
  //publishDocMap) joined with "\n\n", and whole paragraphs are lit, not characters
  function startHighlight(sessionId, opts) {
    removeHighlight()
    const isDoc = !!(opts && opts.doc)
    if (typeof CSS == "undefined" || !CSS.highlights) return false
    if (!isDoc && (!captured || captured.sessionId != sessionId)) return false
    const port = brapi.runtime.connect({name: PORT_NAME})
    highlight = {port, doc: isDoc, lastMsg: null}
    port.onMessage.addListener(msg => {
      if (!highlight || highlight.port != port) return
      if (msg.type == "highlight") {
        if (isDoc) applyDocHighlight(msg)
        else if (captured && captured.sessionId == sessionId) applyHighlight(msg)
      }
      else if (msg.type == "end") removeHighlight()
    })
    port.onDisconnect.addListener(() => {
      if (highlight && highlight.port == port) removeHighlight()
    })
    port.postMessage({type: "hello", sessionId, role: "highlight"})
    return true
  }

  //the extraction runs after the highlight session starts: redo the waiting update with the new map
  function docMapChanged() {
    docSpans = null
    if (highlight && highlight.doc && highlight.lastMsg) applyDocHighlight(highlight.lastMsg)
  }

  //offset spans of the extracted paragraphs in their "\n\n"-joined text, with each one's element;
  //must count the same way as alignSegmentsToParas() in js/page-ui-host.js
  function getDocSpans() {
    if (docSpans) return docSpans
    const map = window.__readAloudHrgDocMap
    if (!map || !map.texts) return null
    docSpans = []
    let off = 0
    for (let i = 0; i < map.texts.length; i++) {
      if (i > 0) off += 2
      docSpans.push({start: off, end: off + map.texts[i].length, text: map.texts[i], elem: map.elements[i]})
      off += map.texts[i].length
    }
    resolveSharedElements(docSpans, map.ignore)
    return docSpans
  }

  //find each paragraph's place inside its element, so reading it lights its own text only —
  //not the whole element (a figure's image around its caption, an article container holding
  //several paragraphs). Elements shared by several paragraphs are walked once
  function resolveSharedElements(spans, ignoreSelector) {
    for (let i = 0; i < spans.length; ) {
      let j = i
      while (j + 1 < spans.length && spans[j + 1].elem == spans[i].elem) j++
      if (spans[i].elem && spans[i].elem.isConnected) mapSharedGroup(spans, i, j, ignoreSelector)
      i = j + 1
    }
  }

  function mapSharedGroup(spans, i, j, ignoreSelector) {
    try {
      const range = document.createRange()
      range.selectNodeContents(spans[i].elem)
      const cache = new Map()
      //drop what the extraction didn't read (getTexts() in js/content/html-doc.js hides these)
      const dropNode = node => {
        const parent = node.parentElement
        if (!parent) return false
        if (ignoreSelector && parent.closest(ignoreSelector)) return true
        return isFloatedAside(parent, cache)
      }
      let joined = ""
      for (let k = i; k <= j; k++) joined += (k > i ? "\n" : "") + spans[k].text
      const map = mapTextToNodes(joined, range, true, dropNode)
      if (!map) return
      let off = 0
      for (let k = i; k <= j; k++) {
        //per text node, so nothing between them (an image between a paragraph's lines) is lit
        spans[k].runs = nodeRunsIn(map, off, off + spans[k].text.length)
        off += spans[k].text.length + 1
      }
    }
    catch (err) {
      console.error(err)
    }
  }

  //dontRead() in js/content/html-doc.js: floated-right and fixed content isn't read
  function isFloatedAside(elem, cache) {
    if (!elem) return false
    const cached = cache.get(elem)
    if (cached && "aside" in cached) return cached.aside
    const style = getComputedStyle(elem)
    const result = style.float == "right" || style.position == "fixed" || isFloatedAside(elem.parentElement, cache)
    cache.set(elem, {...cache.get(elem), aside: result})
    return result
  }

  function applyDocHighlight(msg) {
    highlight.lastMsg = msg
    const spans = getDocSpans()
    if (!spans) return
    const ranges = msg.para ? docRangesFor(spans, msg.para) : []
    if (ranges.length) CSS.highlights.set(HIGHLIGHT_PARA, new Highlight(...ranges))
    else CSS.highlights.delete(HIGHLIGHT_PARA)
    //word positions aren't mapped for whole-page reading (paragraph precision only)
    CSS.highlights.delete(HIGHLIGHT_WORD)
    if (msg.scroll && ranges.length) revealRanges(ranges)
  }

  //[from, to) offsets in the joined text -> the overlapped paragraphs as ranges: the paragraph's own
  //text stretches when mapped (runs), otherwise the whole element
  function docRangesFor(spans, span) {
    const [from, to] = span
    const ranges = []
    const seen = new Set()
    for (const s of spans) {
      if (s.end <= from || s.start >= to) continue
      try {
        const runs = s.runs && s.runs.filter(r => r.node.isConnected && r.end <= r.node.nodeValue.length)
        if (runs && runs.length) {
          for (const r of runs) {
            const range = document.createRange()
            range.setStart(r.node, r.start)
            range.setEnd(r.node, r.end)
            ranges.push(range)
          }
          continue
        }
        if (!s.elem || !s.elem.isConnected || seen.has(s.elem)) continue
        seen.add(s.elem)
        const range = document.createRange()
        range.selectNodeContents(s.elem)
        ranges.push(range)
      }
      catch (err) {}
    }
    return ranges
  }

  function removeHighlight() {
    if (highlight) {
      const port = highlight.port
      highlight = null
      try { port.disconnect() } catch (err) {}
    }
    if (typeof CSS != "undefined" && CSS.highlights) {
      CSS.highlights.delete(HIGHLIGHT_PARA)
      CSS.highlights.delete(HIGHLIGHT_WORD)
    }
  }

  function applyHighlight(msg) {
    if (!captured) return
    const paraRange = rangeFor(msg.para)
    const wordRange = rangeFor(msg.word)
    setHighlight(HIGHLIGHT_PARA, paraRange)
    setHighlight(HIGHLIGHT_WORD, wordRange)
    if (paraRange || wordRange) releaseSelection()
    if (msg.scroll && paraRange) revealRanges([paraRange])
  }

  function setHighlight(name, range) {
    if (range) CSS.highlights.set(name, new Highlight(range))
    else CSS.highlights.delete(name)
  }

  //[from, to) offsets in the captured text -> DOM range
  function rangeFor(span) {
    if (!span) return null
    return rangeIn(captured, span[0], span[1])
  }

  //[from, to) offsets in a mapped text -> one stretch per text node ({node, start, end})
  function nodeRunsIn(map, from, to) {
    const runs = []
    let cur = null
    for (let idx = from; idx < to && idx < map.nodeOf.length; idx++) {
      const ni = map.nodeOf[idx]
      if (ni < 0) continue
      const off = map.offsetOf[idx]
      if (cur && cur.ni == ni) {
        cur.end = off + 1
      }
      else {
        cur = {ni, node: map.nodes[ni].node, start: off, end: off + 1}
        runs.push(cur)
      }
    }
    return runs.length ? runs : null
  }

  //[from, to) offsets in a mapped text ({nodes, nodeOf, offsetOf}) -> DOM range
  function rangeIn(map, from, to) {
    let a = from
    while (a < to && map.nodeOf[a] < 0) a++
    let b = to - 1
    while (b >= a && map.nodeOf[b] < 0) b--
    if (a >= to || b < a) return null
    const startNode = map.nodes[map.nodeOf[a]].node
    const endNode = map.nodes[map.nodeOf[b]].node
    const startOffset = map.offsetOf[a]
    const endOffset = map.offsetOf[b] + 1
    //the page may have changed since the text was mapped
    if (!startNode.isConnected || !endNode.isConnected) return null
    if (startOffset > startNode.nodeValue.length || endOffset > endNode.nodeValue.length) return null
    const range = document.createRange()
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  }

  //the selection's own color is drawn above highlights, so let it go once the highlight shows
  function releaseSelection() {
    if (captured.released) return
    captured.released = true
    try {
      const selection = window.getSelection()
      if (!selection || !selection.rangeCount) return
      const current = selection.getRangeAt(0)
      const same = current.compareBoundaryPoints(Range.START_TO_START, captured.range) == 0
        && current.compareBoundaryPoints(Range.END_TO_END, captured.range) == 0
      if (same) selection.removeAllRanges()
    }
    catch (err) {
      console.error(err)
    }
  }

  //scroll so the whole paragraph being read is visible — its last line included, which the
  //playback bar at the bottom, or what the page floats over it (a chat's message box), would otherwise
  //cover. Each box that scrolls it is moved in turn, from the innermost out to the window, as far as that
  //box can go, the paragraph measured again after each: the nearest box alone may hardly move (a table or
  //code box that scrolls sideways) or be out of view.
  //It jumps there: a smooth scroll may be held back or cut off by the page (ChatGPT's conversation started
  //one 0.5-1.2s late or not at all, 2026-09-27)
  function revealRanges(ranges) {
    const measure = () => {
      let rect = null
      for (const range of ranges) {
        const b = range.getBoundingClientRect()
        if (!b || (b.width == 0 && b.height == 0)) continue
        rect = rect ? {top: Math.min(rect.top, b.top), bottom: Math.max(rect.bottom, b.bottom)} : {top: b.top, bottom: b.bottom}
      }
      return rect
    }
    let rect = measure()
    if (!rect) return
    //the bar lives in the top frame: a subframe (e.g. a blog whose article is a full-page iframe)
    //can't see it, so it counts the bar's height at the bottom as covered
    const barTop = bar ? bar.host.getBoundingClientRect().top
      : window.top !== window ? window.innerHeight - BAR_HEIGHT
      : Infinity
    const boxes = scrollingBoxes(ranges[0].startContainer.parentElement)
    const screen = uncovered(ranges, boxes, 0, Math.min(window.innerHeight, barTop))
    for (const box of [...boxes, null]) {
      let visibleTop = screen.top, visibleBottom = screen.bottom
      if (box) {
        const boxTop = box.getBoundingClientRect().top + box.clientTop
        const boxBottom = boxTop + box.clientHeight
        //the part of the box on screen; the whole box when none is (a box further out brings it in)
        visibleTop = Math.max(boxTop, screen.top)
        visibleBottom = Math.min(boxBottom, screen.bottom)
        if (visibleBottom <= visibleTop) {
          visibleTop = boxTop
          visibleBottom = boxBottom
        }
      }
      if (rect.top >= visibleTop && rect.bottom <= visibleBottom) continue
      const height = rect.bottom - rect.top
      const visible = visibleBottom - visibleTop
      //centered when it fits; a paragraph taller than the view starts at the top instead
      const wanted = height <= visible
        ? rect.top - (visibleTop + (visible - height) / 2)
        : rect.top - visibleTop
      const room = scrollRoom(box)
      const delta = Math.max(room.up, Math.min(room.down, wanted))
      if (Math.abs(delta) < 1) continue
      if (box) box.scrollBy({top: delta, behavior: "instant"})
      else window.scrollBy({top: delta, behavior: "instant"})
      rect = measure()
      if (!rect) return
    }
  }

  //[top, bottom] of the screen, less what the page floats over a line of the ranges that's on screen and not
  //cut off by a box it scrolls in: the nearest positioned (absolute, fixed, sticky) element over the line's
  //middle, not holding the ranges. Below the middle of what's left it takes the bottom, above it the top.
  //As it was if nothing would be left
  function uncovered(ranges, boxes, top, bottom) {
    const own = ranges.map(range => {
      const node = range.commonAncestorContainer
      return node.nodeType == Node.ELEMENT_NODE ? node : node.parentElement
    }).filter(Boolean)
    const ownOf = el => own.some(o => o.contains(el) || el.contains(o))
    const shown = boxes.map(box => {
      const boxTop = box.getBoundingClientRect().top + box.clientTop
      return {top: boxTop, bottom: boxTop + box.clientHeight}
    })
    let coverTop = top, coverBottom = bottom
    for (const range of ranges) {
      for (const line of range.getClientRects()) {
        const x = (line.left + line.right) / 2, y = (line.top + line.bottom) / 2
        if (!line.width || y < coverTop || y > coverBottom || x < 0 || x >= window.innerWidth) continue
        if (shown.some(s => y < s.top || y > s.bottom)) continue
        const hit = document.elementFromPoint(x, y)
        if (!hit || ownOf(hit)) continue
        let cover = null
        for (let el = hit; el && !cover; el = el.parentElement) {
          if (/^(absolute|fixed|sticky)$/.test(getComputedStyle(el).position)) cover = el
        }
        if (!cover || own.some(o => cover.contains(o))) continue
        const c = cover.getBoundingClientRect()
        if ((c.top + c.bottom) / 2 > (coverTop + coverBottom) / 2) coverBottom = Math.min(coverBottom, c.top)
        else coverTop = Math.max(coverTop, c.bottom)
      }
    }
    return coverBottom > coverTop ? {top: coverTop, bottom: coverBottom} : {top, bottom}
  }

  //how far box (null: the page) can scroll from where it is: up (<= 0) and down (>= 0). A box laid out
  //bottom up (column-reverse, as in a chat) has its scrollTop 0 at the bottom and below 0 above
  function scrollRoom(box) {
    if (!box) {
      const page = document.scrollingElement || document.documentElement
      return {up: -window.scrollY, down: page.scrollHeight - window.innerHeight - window.scrollY}
    }
    const most = box.scrollHeight - box.clientHeight
    const bottomUp = box.scrollTop < 0 || getComputedStyle(box).flexDirection == "column-reverse"
    return bottomUp
      ? {up: -most - box.scrollTop, down: -box.scrollTop}
      : {up: -box.scrollTop, down: most - box.scrollTop}
  }

  //the boxes that scroll up and down with elem in them, innermost first (the page itself not included)
  function scrollingBoxes(elem) {
    const boxes = []
    for (let el = elem; el && el != document.body && el != document.documentElement; el = el.parentElement) {
      const overflowY = getComputedStyle(el).overflowY
      if (/(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight) boxes.push(el)
    }
    return boxes
  }



  //playback bar -------------------------------------------------------------------

  function startBar(sessionId) {
    removeBar()
    askUiMessages()
    const port = brapi.runtime.connect({name: PORT_NAME})
    const host = document.createElement("readaloud-hrg-bar")
    host.className = "no-read-aloud"
    for (const [name, value] of Object.entries({
      all: "initial", display: "block", position: "fixed", bottom: "0", left: "0", right: "0", "z-index": "2147483647",
    })) host.style.setProperty(name, value, "important")
    const shadow = host.attachShadow({mode: "closed"})
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(BAR_CSS)
    shadow.adoptedStyleSheets = [sheet]

    const els = {}
    const button = (key, onClick) => {
      const b = els[key] = h("button", {type: "button", class: key})
      b.addEventListener("click", onClick)
      return b
    }
    shadow.append(
      h("div", {class: "bar"}, [
        els.progress = h("div", {class: "progress"}, [els.fill = h("div", {class: "fill"})]),
        h("div", {class: "center"}, [
          h("div", {class: "time"}, [
            els.elapsed = h("span", {class: "elapsed"}, ["00:00:00"]),
            els.totalPart = h("span", {class: "total"}, [" / ", els.total = h("span", {}, [message("pagebar_calculating", "Calculating…")])]),
          ]),
          button("prev", () => send({cmd: "rewind"})),
          button("play", () => send({cmd: "togglePause"})),
          button("next", () => send({cmd: "forward"})),
          button("mute", () => send({cmd: "mute", value: !(bar && bar.muted)})),
        ]),
        h("div", {class: "end"}, [
          button("settings", () => togglePanel()),
          button("close", () => {
            send({cmd: "stop"})
            host.style.setProperty("display", "none", "important")
          }),
        ]),
        els.panel = h("div", {class: "panel"}, Object.keys(PARAMS).map(key => paramRow(key))),
      ])
    )
    setIcon(els.prev, ICONS.prev, message("pagebar_prev", "Previous paragraph"))
    setIcon(els.next, ICONS.next, message("pagebar_next", "Next paragraph"))
    setIcon(els.settings, ICONS.settings, message("pagebar_settings", "Voice settings"))
    setIcon(els.close, ICONS.close, message("pagebar_stop", "Stop reading"))
    els.mute.hidden = true
    els.panel.hidden = true
    els.settings.disabled = true
    els.settings.setAttribute("aria-expanded", "false")

    const editing = {}
    //the page's own mouse/key handlers (copy protection, shortcut keys) must not get the panel's input
    for (const type of ["mousedown", "pointerdown", "keydown"]) els.panel.addEventListener(type, event => event.stopPropagation())

    bar = {port, host, els, editing, muted: false, state: null, last: null, timer: null, onOutside: null}
    renderPlayButton("LOADING")
    //on <html>, not <body>: a transform/filter on body would make "fixed" relative to the body
    document.documentElement.append(host)

    port.onMessage.addListener(msg => {
      if (msg.type == "update") renderBar(msg)
      else if (msg.type == "end") removeBar()
    })
    port.onDisconnect.addListener(() => {
      if (bar && bar.port == port) removeBar()
    })
    port.postMessage({type: "hello", sessionId, role: "bar"})
    return true

    function send(msg) {
      try {
        port.postMessage(msg)
      }
      catch (err) {
        removeBar()
      }
    }

    //one slider of the settings panel; a change is sent when the slider is released
    function paramRow(key) {
      const p = PARAMS[key]
      const input = els[key] = h("input", {type: "range", min: p.min, max: p.max, step: p.step})
      const value = els[key + "Value"] = h("span", {class: "value"})
      input.addEventListener("input", () => {
        editing[key] = true
        value.textContent = p.format(p.fromSlider(Number(input.value)))
      })
      input.addEventListener("change", () => {
        editing[key] = false
        send({cmd: "setParams", params: {[key]: p.fromSlider(Number(input.value))}})
      })
      //released where it started gives no change event: the next update shows the current value again
      input.addEventListener("pointerup", () => editing[key] = false)
      input.addEventListener("blur", () => editing[key] = false)
      return els[key + "Row"] = h("label", {class: "row"}, [h("span", {class: "name"}, [p.label()]), input, value])
    }

    function togglePanel(open = els.panel.hidden) {
      els.panel.hidden = !open
      els.settings.setAttribute("aria-expanded", String(open))
      if (open && !bar.onOutside) {
        //close when clicking anywhere else on the page, on Escape, or when focus leaves this window
        //(a click into an iframe reaches only the iframe's document)
        bar.onOutside = event => {
          if (event.type == "blur"
            || (event.type == "keydown" ? event.key == "Escape" : !event.composedPath().includes(host))) togglePanel(false)
        }
        listenOutside(bar.onOutside, true)
      }
      else if (!open && bar.onOutside) {
        listenOutside(bar.onOutside, false)
        bar.onOutside = null
      }
    }
  }

  function removeBar() {
    if (!bar) return
    const {port, host, timer, onOutside} = bar
    bar = null
    clearTimeout(timer)
    if (onOutside) listenOutside(onOutside, false)
    host.remove()
    try { port.disconnect() } catch (err) {}
  }

  //on the window in the capture phase: pages that stop or cancel pointer/mouse events further down
  //(copy protection, drag libraries) can't hide the outside click from the panel
  function listenOutside(listener, on) {
    const method = on ? "addEventListener" : "removeEventListener"
    window[method]("pointerdown", listener, true)
    window[method]("keydown", listener, true)
    window[method]("blur", listener)
  }

  function renderBar(msg) {
    if (!bar) return
    const els = bar.els
    bar.last = {msg, at: Date.now()}
    bar.muted = msg.muted
    els.progress.hidden = msg.paged
    els.totalPart.hidden = msg.paged
    renderTime()
    scheduleTime()
    renderPlayButton(msg.state)
    const navigable = msg.state == "PLAYING" || msg.state == "PAUSED"
    els.prev.disabled = els.next.disabled = !navigable
    els.mute.hidden = !msg.canMute
    setIcon(els.mute, msg.muted ? ICONS.muted : ICONS.volume, msg.muted ? message("pagebar_unmute", "Unmute") : message("pagebar_mute", "Mute"))
    //the voice being read ignores the pitch (most online voices)
    els.pitchRow.hidden = msg.usesPitch === false
    renderParams(msg.params)
  }

  function renderParams(params) {
    const els = bar.els
    els.settings.disabled = !params
    if (!params) return
    for (const key in PARAMS) {
      if (bar.editing[key] || params[key] == null) continue
      const p = PARAMS[key]
      els[key].value = Math.max(p.min, Math.min(p.max, p.toSlider(params[key])))
      els[key + "Value"].textContent = p.format(params[key])
    }
  }

  //the player's updates can be throttled (a hidden pinned tab), so the bar keeps its own clock
  //from the last update while playing
  function displayedTime() {
    const {msg, at} = bar.last
    const elapsed = msg.elapsed + (msg.state == "PLAYING" ? (Date.now() - at) / 1000 : 0)
    const total = msg.total != null ? Math.max(msg.total, elapsed) : null
    return {elapsed, total, progress: total ? elapsed / total : msg.progress}
  }

  function renderTime() {
    const els = bar.els
    const {elapsed, total, progress} = displayedTime()
    els.fill.style.width = (Math.max(0, Math.min(1, progress || 0)) * 100).toFixed(2) + "%"
    els.elapsed.textContent = formatTime(elapsed)
    els.total.textContent = total != null
      ? message("pagebar_about", "about") + " " + formatTime(total)
      : message("pagebar_calculating", "Calculating…")
  }

  //refresh right when the shown second changes
  function scheduleTime() {
    clearTimeout(bar.timer)
    if (bar.last.msg.state != "PLAYING") return
    const ms = displayedTime().elapsed * 1000
    bar.timer = setTimeout(() => {
      if (!bar) return
      renderTime()
      scheduleTime()
    }, 1000 - ms % 1000)
  }

  function renderPlayButton(state) {
    if (bar.state == state) return
    bar.state = state
    const play = bar.els.play
    if (state == "LOADING") {
      play.replaceChildren(h("span", {class: "spinner"}))
      play.title = message("pagebar_loading", "Loading")
      play.setAttribute("aria-label", play.title)
    }
    else if (state == "PAUSED") setIcon(play, ICONS.play, message("pagebar_play", "Resume"))
    else setIcon(play, ICONS.pause, message("pagebar_pause", "Pause"))
  }

  function setIcon(button, path, label) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("viewBox", "0 0 24 24")
    svg.setAttribute("aria-hidden", "true")
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path")
    p.setAttribute("d", path)
    svg.append(p)
    button.replaceChildren(svg)
    button.title = label
    button.setAttribute("aria-label", label)
  }

  function h(tag, attrs, children) {
    const el = document.createElement(tag)
    for (const name in attrs) el.setAttribute(name, attrs[name])
    if (children) el.append(...children)
    return el
  }

  function formatTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0))
    const pad = n => String(n).padStart(2, "0")
    return pad(Math.floor(sec / 3600)) + ":" + pad(Math.floor(sec / 60) % 60) + ":" + pad(sec % 60)
  }

  //the words of the language chosen in the options, which the service worker reads (a web page can't read
  //_locales), asked for as each reading starts; until they come, or with none chosen, the browser's
  let uiMessages = null
  function askUiMessages() {
    try {
      brapi.runtime.sendMessage({dest: "serviceWorker", method: "getUiMessages", args: []})
        .then(messages => { uiMessages = messages && !messages.error ? messages : null })
        .catch(() => {})
    }
    catch (err) {}
  }

  function message(name, fallback) {
    try {
      const entry = uiMessages && uiMessages[name]
      return entry ? entry.message : brapi.i18n.getMessage(name) || fallback
    }
    catch (err) {
      return fallback
    }
  }



  const ICONS = {
    play: "M8 5v14l11-7z",
    pause: "M6 19h4V5H6v14zm8-14v14h4V5h-4z",
    prev: "M6 6h2v12H6zm3.5 6l8.5 6V6z",
    next: "M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z",
    volume: "M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z",
    muted: "M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z",
    close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
    settings: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  }

  //settings panel sliders: same ranges and 40 steps as the options page (options.html #rate/#pitch/#volume),
  //the rate slider is logarithmic there too (rate = 3^value)
  const PARAMS = {
    rate: {
      label: () => message("pagebar_rate", "Speed"),
      min: -1, max: 1, step: 0.05,
      toSlider: rate => Math.log(rate) / Math.log(3),
      fromSlider: value => Number(Math.pow(3, value).toFixed(3)),
      format: rate => rate.toFixed(2) + "x",
    },
    pitch: {
      label: () => message("pagebar_pitch", "Pitch"),
      min: 0, max: 2, step: 0.05,
      toSlider: pitch => pitch,
      fromSlider: value => Number(value.toFixed(2)),
      format: pitch => pitch.toFixed(2),
    },
    volume: {
      label: () => message("pagebar_volume", "Volume"),
      min: 0.2, max: 1, step: 0.02,
      toSlider: volume => volume,
      fromSlider: value => Number(value.toFixed(2)),
      format: volume => Math.round(volume * 100) + "%",
    },
  }

  const BAR_HEIGHT = 48

  const BAR_CSS = `
    .bar {
      position: relative;
      box-sizing: border-box;
      height: ${BAR_HEIGHT}px;
      padding: 0 12px;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      background: rgba(86, 86, 86, 0.95);
      color: #fff;
      font: 14px/1 system-ui, -apple-system, "Segoe UI", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif;
      box-shadow: 0 -1px 4px rgba(0, 0, 0, 0.35);
      user-select: none;
    }
    .progress {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: rgba(255, 255, 255, 0.18);
    }
    .fill {
      width: 0;
      height: 100%;
      background: #3d7cff;
      transition: width 1s linear;
    }
    .center {
      grid-column: 2;
      display: flex;
      align-items: center;
      gap: 6px;
    }
    .time {
      min-width: 160px;
      margin-right: 8px;
      text-align: right;
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
    }
    .total {
      color: rgba(255, 255, 255, 0.7);
    }
    button {
      all: unset;
      box-sizing: border-box;
      width: 36px;
      height: 36px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      cursor: pointer;
    }
    button:hover {
      background: rgba(255, 255, 255, 0.14);
    }
    button:focus-visible {
      outline: 2px solid #8fb3ff;
      outline-offset: 1px;
    }
    button:disabled {
      opacity: 0.35;
      cursor: default;
      background: none;
    }
    button.play {
      width: 40px;
      height: 40px;
      background: #333;
      color: #4d8dff;
    }
    button.play:hover {
      background: #2a2a2a;
    }
    .end {
      grid-column: 3;
      justify-self: end;
      display: flex;
      gap: 4px;
    }
    button.settings[aria-expanded="true"] {
      background: rgba(255, 255, 255, 0.14);
    }
    .panel {
      position: absolute;
      right: 12px;
      bottom: calc(100% + 8px);
      width: 280px;
      box-sizing: border-box;
      padding: 8px 14px;
      background: rgba(56, 56, 56, 0.97);
      border-radius: 10px;
      box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 10px;
      height: 36px;
    }
    .row .name {
      width: 40px;
      font-size: 13px;
      color: rgba(255, 255, 255, 0.85);
    }
    .row input {
      flex: 1;
      min-width: 0;
      margin: 0;
      accent-color: #4d8dff;
      cursor: pointer;
    }
    .row .value {
      width: 48px;
      text-align: right;
      font-size: 13px;
      font-variant-numeric: tabular-nums;
    }
    svg {
      width: 22px;
      height: 22px;
      fill: currentColor;
    }
    .spinner {
      width: 16px;
      height: 16px;
      box-sizing: border-box;
      border: 2px solid rgba(77, 141, 255, 0.3);
      border-top-color: #4d8dff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    [hidden] {
      display: none !important;
    }
    @media print {
      .bar { display: none; }
    }
  `
})();
