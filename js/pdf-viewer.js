
const ready = new Promise(f => document.addEventListener("DOMContentLoaded", f))
  .then(loadViewer)
  .then(loadDocument)

registerMessageListener("pdfViewer", {
  getDocumentInfo: function() {
    return {
      url: location.href,
      title: document.title,
    }
  },
  getCurrentIndex: async function() {
    const queue = await ready
    const res = await queue.send({method: "getCurrentIndex"})
    return res.value
  },
  getTexts: async function(index, quietly) {
    const queue = await ready
    const res = await queue.send({method: "getTexts", index: index, quietly: quietly})
    return res.value
  },
  //playback bar (js/page-ui.js); every open viewer gets this message, only the one being read shows it
  startPageUi: async function(sessionId, tabId) {
    const tab = await brapi.tabs.getCurrent()
    if (!tab || tab.id != tabId) return false
    const frame = document.getElementById("viewer-frame")
    const started = window.__readAloudHrgUi.startBar(sessionId, {
      onRemove() {
        frame.style.height = ""
      }
    })
    //keep the whole viewer usable: shrink it to end above the bar while the bar is shown
    const bar = document.querySelector("readaloud-hrg-bar")
    if (started && bar) frame.style.height = "calc(100% - " + bar.getBoundingClientRect().height + "px)"
    return started
  }
})

bgPageInvoke("pdfViewerCheckIn")
  .catch(console.error)



async function loadViewer() {
  const viewerUrl = new URL(config.pdfViewerUrl + "?embedded")
  const frame = document.getElementById("viewer-frame")
  frame.src = viewerUrl.href
  var queue
  await new Promise(f => queue = new MessageQueue(frame.contentWindow, viewerUrl.origin, {viewerReady: f}))
  return queue
}

async function loadDocument(queue) {
  const query = getQueryString()
  const res = await fetch(query.url)
  const buffer = await res.arrayBuffer()
  await queue.send({method: "loadDocument", buffer: buffer}, [buffer])
  return queue
}

function MessageQueue(targetWindow, targetOrigin, handlers) {
  const pending = {}
  window.addEventListener("message", event => {
    if (event.origin == targetOrigin) {
      if (handlers[event.data.method]) handlers[event.data.method](event.data)
      else if (pending[event.data.id]) pending[event.data.id](event.data)
      else console.error("Unhandled", event)
    }
  })
  this.send = function(message, transfer) {
    message.id = Math.random()
    targetWindow.postMessage(message, targetOrigin, transfer)
    return new Promise(f => pending[message.id] = f)
      .finally(() => delete pending[message.id])
  }
}
