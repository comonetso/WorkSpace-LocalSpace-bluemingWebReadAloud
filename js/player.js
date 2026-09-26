
const isEmbedded = top != self
var queryString = new URLSearchParams(location.search)
var activeDoc;
var playbackError = null;



const idleSubject = new rxjs.BehaviorSubject(true)

if (queryString.has("autoclose"))
  idleSubject
    .pipe(
      rxjs.switchMap(isIdle => {
        if (isIdle) return rxjs.timer(queryString.get("autoclose") == "long" ? 15*60*1000 : 5*60*1000)
        else return rxjs.EMPTY
      })
    )
    .subscribe(closePlayer)



var messageHandlers = {
  playText: playText,
  playTab: playTab,
  stop: stop,
  pause: pause,
  resume: resume,
  getPlaybackState: getPlaybackState,
  forward: forward,
  rewind: rewind,
  seek: seek,
  close: closePlayer,
  //inside a page (not a tab of its own): which tab it's in (js/events.js readyPlayer)
  getPlayerTab: () => ({embedded: isEmbedded, tabId: isEmbedded ? Number(queryString.get("tab")) || null : null}),
  shouldPlaySilence: shouldPlaySilence.bind({}),
  beginUiSession: ui => pageUiHost.begin(ui),
}

registerMessageListener("player", messageHandlers)

if (queryString.has("opener")) {
  brapi.runtime.sendMessage({dest: queryString.get("opener"), method: "playerCheckIn"})
    .catch(console.error)
} else {
  bgPageInvoke("playerCheckIn")
    .catch(console.error)
}

document.addEventListener("DOMContentLoaded", initialize)



async function initialize() {
  setI18nText()

  //only when the tab was chosen in the options: otherwise this tab is here because the page couldn't take the player
  $("#hidethistab-link")
    .toggle(canUseEmbeddedPlayer() && (await getSettings()).useEmbeddedPlayer === false)
    .click(function() {
      $("#dialog-backdrop, #hidethistab-dialog").show()
    })

  $("#hidethistab-dialog .btn, #hidethistab-dialog .close")
    .click(function(event) {
      $("#dialog-backdrop, #hidethistab-dialog").hide()
      if ($(event.target).is(".btn-ok")) {
        updateSettings({useEmbeddedPlayer: true})
          .then(() => window.close())
          .catch(console.error)
      }
    })
}

function playText(text, opts) {
  opts = opts || {}
  playbackError = null
  if (!activeDoc) {
    //reading a selection (splitParagraphs) takes every line on its own, so list items and headings aren't lumped together;
    //replayed by alignSegmentsToSource() in js/page-ui-host.js for the selection highlight, keep them in sync
    const paragraphs = text.split(opts.splitParagraphs ? /\s*\r?\n\s*/ : /(?:\r?\n){2,}/)
    openDoc(new SimpleSource(paragraphs, {lang: opts.lang, splitParagraphs: opts.splitParagraphs}), function(err) {
      if (err) playbackError = err
    }, {sourceText: text})
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function playTab() {
  playbackError = null
  if (!activeDoc) {
    openDoc(new TabSource(), function(err) {
      if (err) playbackError = err
    })
  }
  const doc = activeDoc
  return activeDoc.play()
    .catch(function(err) {
      if (doc == activeDoc) {
        handleError(err);
        closeDoc();
      }
      throw err;
    })
}

function stop() {
  if (activeDoc) {
    activeDoc.stop();
    closeDoc();
  }
  return true;
}

function pause() {
  if (activeDoc) return activeDoc.pause();
  else return Promise.resolve();
}

function resume() {
  if (activeDoc) return activeDoc.play()
  else return Promise.resolve()
}

function getPlaybackState() {
  if (activeDoc) {
    return Promise.all([activeDoc.getState(), activeDoc.getActiveSpeech()])
      .then(function(results) {
        return {
          state: results[0],
          speechInfo: results[1] && results[1].getInfo(),
          playbackError: errorToJson(playbackError),
        }
      })
      .finally(() => {
        playbackError = null
      })
  }
  else {
    return {
      state: "STOPPED",
      playbackError: errorToJson(playbackError),
    }
  }
}

function openDoc(source, onEnd, uiOpts) {
  activeDoc = new Doc(source, function(err) {
    handleError(err);
    closeDoc();
    if (typeof onEnd == "function") onEnd(err);
  })
  pageUiHost.attachDoc(activeDoc, uiOpts)
  idleSubject.next(false)
}

function closeDoc() {
  if (activeDoc) {
    const doc = activeDoc
    activeDoc.close();
    activeDoc = null;
    idleSubject.next(true)
    pageUiHost.detachDoc(doc)
  }
}

function forward() {
  pageUiHost.noteSkip()
  if (activeDoc) return activeDoc.forward();
  else return Promise.reject(new Error("Can't forward, not active"));
}

function rewind() {
  pageUiHost.noteSkip()
  if (activeDoc) return activeDoc.rewind();
  else return Promise.reject(new Error("Can't rewind, not active"));
}

function seek(n) {
  pageUiHost.noteSkip()
  if (activeDoc) return activeDoc.seek(n);
  else return Promise.reject(new Error("Can't seek, not active"));
}

function closePlayer() {
  if (top == self) window.close()
  else location.href = "about:blank"
}

function handleError(err) {
  if (err) reportError(err);
}

//logged to the console only
function reportError(err) {
  if (err && err.stack) {
    var details = err.stack;
    if (!details.startsWith(err.name)) details = err.name + ": " + err.message + "\n" + details;
    console.error(details)
  }
}

function playAudio(urlPromise, options, playbackState$) {
  if (brapi.offscreen) {
    return playAudioOffscreen(urlPromise, options, playbackState$)
  }
  else {
    //the bar's mute/volume/rate state is read when the audio actually starts, not when the segment was queued
    const volume = options.volume, rate = options.rate
    options = Object.defineProperties({...options, startFraction: pageUiHost.takeStartFraction()}, {
      muted: {get: () => pageUiHost.isMuted(), enumerable: true},
      volume: {get: () => pageUiHost.liveVolume() ?? volume, enumerable: true},
      rate: {get: () => pageUiHost.liveRate() ?? rate, enumerable: true},
    })
    return playAudioHere(requestAudioPlaybackPermission().then(() => urlPromise), options, playbackState$)
  }
}

var requestAudioPlaybackPermission = lazy(async function() {
  const thisTab = await brapi.tabs.getCurrent()
  const prevTab = await brapi.tabs.query({windowId: thisTab.windowId, active: true}).then(tabs => tabs[0])
  await brapi.tabs.update(thisTab.id, {active: true})
  $("#dialog-backdrop, #audio-playback-permission-dialog").show()
  await new Audio(brapi.runtime.getURL("sound/silence.mp3")).play()
  $("#dialog-backdrop, #audio-playback-permission-dialog").hide()
  await brapi.tabs.update(prevTab.id, {active: true})
})

async function createOffscreen() {
  const readyPromise = new Promise(f => messageHandlers.offscreenCheckIn = f)
  brapi.offscreen.createDocument({
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Blueming Web Read Aloud would like to play audio in the background",
    url: brapi.runtime.getURL("offscreen.html")
  })
  await readyPromise
}

let offscreenPlaySeq = 0

//mute/volume/rate state as of sending the audio to the offscreen document (the bar may change them while a segment loads)
function withPlaybackState(options) {
  return {
    ...options,
    muted: pageUiHost.isMuted(),
    volume: pageUiHost.liveVolume() ?? options.volume,
    rate: pageUiHost.liveRate() ?? options.rate,
  }
}

function playAudioOffscreen(urlPromise, options, playbackState$) {
  //the offscreen document tags its events with this id, so late events of the previous audio are dropped
  const playId = ++offscreenPlaySeq
  //startFraction: the segment is read again from where it was (settings changed on the page bar)
  options = {...options, playId, startFraction: pageUiHost.takeStartFraction()}
  return rxjs.from(urlPromise).pipe(
    rxjs.exhaustMap(url =>
      playbackState$.pipe(
        rxjs.distinctUntilChanged(),
        rxjs.skipWhile(state => state != "resumed"),
        rxjs.scan((playback$, state) => {
          if (state == "resumed") {
            return rxjs.defer(async () => {
              if (!playback$) {
                const result = await sendToOffscreen({method: "play", args: [url, withPlaybackState(options)]})
                if (result != true) throw "Offscreen doc not present"
              } else {
                const result = await sendToOffscreen({method: "resume"})
                if (result != true) throw "Offscreen doc gone"
              }
            }).pipe(
              rxjs.catchError(err => {
                console.debug(err)
                return rxjs.defer(createOffscreen).pipe(
                  rxjs.exhaustMap(async () => {
                    const result = await sendToOffscreen({method: "play", args: [url, withPlaybackState(options)]})
                    if (result != true) throw new Error("Offscreen doc inaccessible")
                  })
                )
              }),
              rxjs.exhaustMap(() =>
                rxjs.NEVER.pipe(
                  rxjs.finalize(() => {
                    sendToOffscreen({method: "pause"})
                      .catch(console.error)
                  })
                )
              )
            )
          } else {
            return rxjs.EMPTY
          }
        }, null),
        rxjs.switchAll()
      )
    ),
    rxjs.mergeWith(
      new rxjs.Observable(observer => {
        messageHandlers.offscreenPlaybackEvent = function(event) {
          if (event.playId != null && event.playId != playId) return
          if (event.type == "error") observer.error(event.error)
          else observer.next(event)
        }
      })
    ),
    rxjs.takeWhile(event => event.type != "end", true)
  )
}

async function sendToOffscreen(message) {
  message.dest = "offscreen"
  const result = await brapi.runtime.sendMessage(message)
    .catch(err => {
      if (/^(A listener indicated|Could not establish)/.test(err.message)) throw new Error(err.message + " " + message.method)
      throw err
    })
  if (result && result.error) throw result.error
  else return result
}

async function shouldPlaySilence(providerId) {
  const should = await getPlaybackState().then(x => x.state == "PLAYING")
  const now = Date.now()
  if (providerId == this.providerId) {
    this.nextExpectedCheckIn = now + (now - this.lastCheckIn)
    this.lastCheckIn = now
    return should
  }
  else {
    if (now < this.nextExpectedCheckIn) {
      return false
    }
    else {
      this.providerId = providerId
      this.lastCheckIn = now
      return should
    }
  }
}
