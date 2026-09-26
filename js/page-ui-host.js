/*
 * Page playback UI host — runs in the player page (player.html).
 *
 * Owns one "UI session" at a time: the playback bar shown at the top of the web page and,
 * for right-click selection reading, the highlight over the text being read.
 * The page side (js/page-ui.js) connects back with brapi.runtime.connect(). Ending the
 * session closes those ports, and a closed player closes them too, which is what removes
 * the UI from the page — a stale bar can't outlive its playback.
 */
const pageUiHost = immediate(() => {
  const PORT_NAME = "readaloud-hrg-ui"
  let session = null
  let muted = false

  brapi.runtime.onConnect.addListener(onConnect)

  return {
    begin,
    attachDoc,
    detachDoc,
    noteSkip,
    isMuted: () => muted,
    //volume/rate changed in place from the bar: audio queued before the change must start with it too
    liveVolume: () => session && session.liveVolume != null ? session.liveVolume : null,
    liveRate: () => session && session.liveRate != null ? session.liveRate : null,
    //set just before the current segment is read again from where it was (swapSegment); taken by the
    //playAudio() call that restart makes, so no other audio gets it
    takeStartFraction() {
      const fraction = session ? session.startFraction : null
      if (session) session.startFraction = null
      return fraction ?? null
    },
  }


  function begin(ui) {
    end()
    session = {
      id: ui.sessionId,
      highlight: !!ui.highlight,
      //whole-page reading: paragraph-level highlight from the extracted paragraphs (sourceParas),
      //which arrive with onSpeech once the page's text is extracted
      docHighlight: !!ui.docHighlight,
      ports: {},
      doc: null,
      sourceText: null,
      sourceParas: null,
      speech: null,
      subs: [],
      state: "LOADING",
      //whether the whole text is known up front (total time); unknown until the first page is read
      singlePage: ui.pdfViewer ? false : ui.selection ? true : null,
      canMute: false,
      timing: makePlaybackTiming(),
      segTexts: null,
      alignment: null,
      word: null,
      lastHighlight: null,
      tick: null,
      params: null,
      liveVolume: null,
      liveRate: null,
      startFraction: null,
      carryOnLoad: false,
      swapToken: null,
    }
    return true
  }

  function attachDoc(doc, opts) {
    if (!session) return
    if (session.doc) {
      //a document was started without a UI session of its own
      end()
      return
    }
    const s = session
    s.doc = doc
    s.sourceText = s.highlight && opts && opts.sourceText || null
    doc.onSpeech = (speech, info) => {
      if (session == s && s.doc == doc) onSpeech(speech, info)
    }
    pushBar()
  }

  function detachDoc(doc) {
    if (session && session.doc == doc) end()
  }

  function noteSkip() {
    if (session) session.timing.markSkipped()
  }

  function end() {
    const s = session
    if (!s) return
    session = null
    stopTick(s)
    s.subs.forEach(sub => sub.unsubscribe())
    for (const role in s.ports) {
      post(s.ports[role], {type: "end"})
      try { s.ports[role].disconnect() } catch (err) {}
    }
    if (s.doc) s.doc.onSpeech = null
    if (muted) setMuted(false)
  }


  //page side connections -----------------------------------------------------

  function onConnect(port) {
    if (port.name != PORT_NAME) return
    let role = null
    port.onMessage.addListener(msg => {
      if (!role) {
        if (msg.type == "hello" && session && msg.sessionId == session.id && (msg.role == "bar" || msg.role == "highlight")) {
          role = msg.role
          const old = session.ports[role]
          session.ports[role] = port
          if (old) try { old.disconnect() } catch (err) {}
          if (role == "bar") pushBar()
          else pushHighlight(true)
        }
        else {
          post(port, {type: "end"})
          port.disconnect()
        }
      }
      else if (role == "bar" && session && session.ports.bar == port) {
        onBarCommand(msg)
      }
    })
    port.onDisconnect.addListener(() => {
      if (session && role && session.ports[role] == port) delete session.ports[role]
    })
  }

  function onBarCommand(msg) {
    //pause/resume/forward/rewind/stop are the player's own handlers (js/player.js)
    const s = session
    Promise.resolve()
      .then(() => {
        switch (msg.cmd) {
          case "togglePause": return s.state == "PAUSED" ? resume() : pause()
          case "forward": return forward()
          case "rewind": return rewind()
          case "stop": return stop()
          case "mute": return setMuted(!!msg.value)
          case "setParams": return applyParams(s, msg.params)
        }
      })
      .catch(console.error)
  }

  function post(port, msg) {
    try {
      port.postMessage(msg)
    }
    catch (err) {
      //port already closed by the page (navigated away / tab closed)
    }
  }


  //playback tracking ------------------------------------------------------------

  function onSpeech(speech, info) {
    const s = session
    s.subs.forEach(sub => sub.unsubscribe())
    s.subs = []
    if (s.singlePage == null) s.singlePage = info.singlePage
    s.speech = speech
    s.canMute = speech.canMute
    s.timing.setAudioBased(speech.reportsAudioTime)
    //a new speech (next page) starts with the saved values, which include what the bar changed
    s.liveVolume = s.liveRate = null
    s.carryOnLoad = false
    s.swapToken = null
    s.word = null
    s.segTexts = null
    if (s.docHighlight && info.sourceParas) s.sourceParas = info.sourceParas
    updateSegments(speech.getInfo().texts)
    s.subs.push(speech.state$.subscribe(onState))
    s.subs.push(speech.events$.subscribe({
      next: onSpeechEvent,
      complete: () => onState("LOADING"),
    }))
    pushBar()
    pushHighlight(true)
    loadParams(s)
  }

  //rate/pitch/volume as saved, read the same way as getSpeech() in js/document.js
  async function loadParams(s) {
    const settings = await getSettings()
    const rate = await getSetting("rate" + (settings.voiceName || ""))
    s.params = {
      rate: rate || defaults.rate,
      pitch: settings.pitch || defaults.pitch,
      volume: settings.volume || defaults.volume,
    }
    if (session == s) pushBar()
  }

  //from the bar's settings panel: save like the options page does, then apply to what's being read
  async function applyParams(s, params) {
    const settings = await getSettings(["voiceName"])
    if (params.rate != null) await updateSetting("rate" + (settings.voiceName || ""), Number(params.rate.toFixed(3)))
    const shared = {}
    if (params.pitch != null) shared.pitch = params.pitch
    if (params.volume != null) shared.volume = params.volume
    if (Object.keys(shared).length) await updateSettings(shared)
    if (session != s) return
    //what reading uses: 0 isn't a usable value there, same "|| default" as getSpeech() in js/document.js
    const applied = {}
    for (const key in params) applied[key] = params[key] || defaults[key]
    s.params = {...s.params, ...applied}
    const speech = s.speech
    if (speech && speech.appliesParamsLive) {
      const inPlace = {}, remade = {}
      for (const key in applied) {
        //rate/volume of audio files change on the audio element; a pitch the voice ignores changes nothing
        if (key == "pitch" ? !speech.usesPitch : speech.changesRateVolumeInPlace) inPlace[key] = applied[key]
        else remade[key] = applied[key]
      }
      if (Object.keys(inPlace).length) {
        speech.updateParams(inPlace)
        if (inPlace.rate != null) setOutputRate(s, inPlace.rate)
        if (inPlace.volume != null) {
          s.liveVolume = inPlace.volume
          setOutputVolume(inPlace.volume)
        }
      }
      if (Object.keys(remade).length) {
        if (remade.rate != null) s.timing.markRateChanged()
        speech.setParams(remade)
        if (speech.isMovePending()) {
          //next/previous is about to move: read the segment it goes to from its start, with the new values
          s.swapToken = null
          s.carryOnLoad = false
          speech.restartSegment()
        }
        else if (speech.reportsAudioTime) swapSegment(s, speech).catch(console.error)
        else restartFromWord(s, speech)
      }
    }
    pushBar()
  }

  //audio files: the old audio plays on while the current segment is made again with the new values,
  //then the new audio goes on from the same point
  async function swapSegment(s, speech) {
    const token = s.swapToken = {}
    const index = s.timing.current()
    const ready = await speech.prepareSegment()
    //not made (the old audio plays on, the next segment gets the new values), or a newer change,
    //another segment, or another reading since then
    if (!ready || session != s || s.speech != speech || s.swapToken != token || s.timing.current() != index) return
    s.startFraction = s.timing.audioFraction()
    s.carryOnLoad = true
    speech.restartSegment({carryOn: true})
    s.startFraction = null
  }

  //built-in voices take the values only when they start speaking, but start quickly: from the word being read
  function restartFromWord(s, speech) {
    s.swapToken = null
    const fromChar = s.word && s.word.index == s.timing.current() ? s.word.charIndex : 0
    s.carryOnLoad = fromChar > 0
    speech.restartSegment({fromChar, carryOn: fromChar > 0})
  }

  function onState(state) {
    const s = session
    if (!s) return
    s.state = state
    s.timing.onState(state)
    if (state == "PLAYING") startTick(s)
    else stopTick(s)
    pushBar()
  }

  function onSpeechEvent(event) {
    const s = session
    if (!s || !s.speech) return
    const info = s.speech.getInfo()
    let changed = updateSegments(info.texts)
    const index = info.position.index
    if (event.type == "end") s.timing.markEnded()
    if (index != s.timing.current()) {
      s.timing.switchTo(index, event.type == "sentence")
      s.word = null
      s.carryOnLoad = false
      changed = true
    }
    else if (event.type == "load") {
      //same segment started over: from its start (rewind within the first seconds), or from where it was
      //when the settings changed (swapSegment/restartFromWord), the time going on
      const keep = s.carryOnLoad
      s.carryOnLoad = false
      s.timing.restartCurrent(keep)
      if (!keep) s.word = null
    }
    if (event.type == "time" && s.timing.onAudioTime(event)) changed = true
    if (event.type == "word") s.word = {index, charIndex: event.charIndex, length: event.length}
    if (changed) pushBar()
    pushHighlight(false)
  }

  function updateSegments(texts) {
    const s = session
    if (!texts || texts == s.segTexts) return false
    s.segTexts = texts
    s.timing.setSegments(texts)
    s.alignment = null
    if (s.sourceText || s.sourceParas) {
      try {
        s.alignment = s.sourceText
          ? alignSegmentsToSource(s.sourceText, texts)
          : alignSegmentsToParas(s.sourceParas, texts, !!(s.speech && s.speech.options.splitParagraphs))
      }
      catch (err) {
        console.error("Cannot map segments to the source text", err)
      }
    }
    s.lastHighlight = null
    return true
  }

  function startTick(s) {
    //the bar shows whole seconds: refresh right when the shown second changes,
    //or once a second when the clock isn't moving
    if (s.tick) return
    let last = null
    const schedule = () => {
      const ms = s.timing.snapshot(s.singlePage !== false).elapsed * 1000
      const delay = ms !== last ? 1000 - ms % 1000 : 1000
      last = ms
      s.tick = setTimeout(() => {
        s.tick = null
        pushBar()
        if (session == s && s.state == "PLAYING") schedule()
      }, delay)
    }
    schedule()
  }

  function stopTick(s) {
    if (s.tick) {
      clearTimeout(s.tick)
      s.tick = null
    }
  }


  //outgoing UI updates ----------------------------------------------------------

  function pushBar() {
    const s = session
    if (!s || !s.ports.bar) return
    const time = s.timing.snapshot(s.singlePage !== false)
    post(s.ports.bar, {
      type: "update",
      state: s.speech ? s.state : "LOADING",
      elapsed: time.elapsed,
      total: time.total,
      progress: time.progress,
      //no total/progress until the document is known to be read in one piece
      paged: s.singlePage !== true,
      canMute: s.canMute,
      muted,
      params: s.params,
      //voices that ignore the pitch get no pitch slider
      usesPitch: s.speech ? s.speech.usesPitch : true,
    })
  }

  function pushHighlight(force) {
    const s = session
    if (!s || !s.ports.highlight) return
    const index = s.timing.current()
    let para = null, word = null
    if (s.alignment) {
      para = s.alignment.segmentRange(index)
      //whole-page reading lights whole paragraphs: a word offset would light its paragraph anyway
      if (!s.docHighlight && s.word && s.word.index == index) word = s.alignment.wordRange(index, s.word.charIndex, s.word.length)
    }
    const key = JSON.stringify([index, para, word])
    if (!force && s.lastHighlight && s.lastHighlight.key == key) return
    const scroll = !s.lastHighlight || s.lastHighlight.index != index
    s.lastHighlight = {key, index}
    post(s.ports.highlight, {type: "highlight", para, word, scroll})
  }


  //mute / volume / rate -------------------------------------------------------------

  function setOutputVolume(volume) {
    getSingletonAudio().volume = volume
    if (brapi.offscreen) sendToOffscreen({method: "setVolume", args: [volume]}).catch(() => {})
  }

  function setOutputRate(s, rate) {
    s.liveRate = rate
    //the rate the audio actually plays at, as playAudioHere() sets it (rateAdjust: Google Translate voices)
    const actual = rate * (s.speech.options.rateAdjust || 1)
    s.timing.changeRate(actual)
    const audio = getSingletonAudio()
    audio.defaultPlaybackRate = audio.playbackRate = actual
    if (brapi.offscreen) sendToOffscreen({method: "setRate", args: [rate]}).catch(() => {})
  }

  function setMuted(value) {
    muted = value
    getSingletonAudio().muted = value
    if (brapi.offscreen) {
      sendToOffscreen({method: "setMuted", args: [value]})
        .catch(() => {})    //no offscreen document yet, playAudio() passes the flag when it creates one
    }
    pushBar()
  }
})



/**
 * Elapsed/total time of the current reading.
 * Segments are the pieces the speech engine reads one at a time (Speech.getInfo().texts).
 * A segment's real duration is known either from its audio file (online voices) or after
 * it has been read to the end (built-in voices). Unknown segments are estimated with the
 * average speed of everything measured so far; until something is measured the total is null.
 * The rate can change partway through a segment, and a segment can be read again from where it
 * was (settings changed on the page bar): its time is then counted in stretches, see `audio`.
 */
function makePlaybackTiming() {
  let segs = []
  let totalChars = 0
  let cur = 0
  let segWall = 0, segSince = null        //playing time spent in the current segment (ms)
  let allWall = 0, allSince = null        //playing time over the whole session (ms)
  //the current segment's audio: {currentTime, duration, rate, at} as last reported, plus the stretch played
  //at this rate: it began at audio position pos0, sec0 seconds into the segment (0 unless the rate changed
  //in place or the segment was read again from where it was)
  let audio = null
  let carry = null                        //seconds played before the segment was read again from where it was
  let carryFraction = null                //and how far into its audio (0-1), until the new audio reports
  let rateSwitch = false                  //rate changed in place: events sent at the old rate may still arrive
  let curRate = null                      //the audio's playback rate now (audio files)
  let audioBased = false                  //segments report their audio position; before it arrives nothing is playing yet
  let endPending = false, skipPending = false

  const now = () => Date.now()
  const segPlayed = () => segWall + (segSince != null ? now() - segSince : 0)
  const allPlayed = () => allWall + (allSince != null ? now() - allSince : 0)
  //audio position, moved forward by the playing time since the last "time" event
  const audioPos = () => {
    const since = segSince != null ? now() - Math.max(audio.at, segSince) : 0
    return Math.min(audio.duration, audio.currentTime + Math.max(0, since) / 1000 * audio.rate)
  }
  const audioPlayed = () => audio.sec0 + Math.max(0, audioPos() - audio.pos0) / audio.rate
  const audioSegmentSec = () => audio.sec0 + Math.max(0, audio.duration - audio.pos0) / audio.rate
  //how far into the current segment's audio (0-1), null before its position is known
  const audioFraction = () => audio ? audioPos() / audio.duration : carryFraction
  const sameRate = (a, b) => Math.abs(a - b) < 1e-6

  return {
    setSegments(texts) {
      segs = texts.map(text => ({chars: countSpokenChars(text), sec: null}))
      totalChars = segs.reduce((sum, seg) => sum + seg.chars, 0)
      cur = 0
      resetSegment()
    },
    onState(state) {
      const playing = state == "PLAYING"
      if (playing && segSince == null) {
        segSince = allSince = now()
      }
      else if (!playing && segSince != null) {
        //keep the interpolated audio position, so the clock doesn't jump back when pausing
        if (audio) audio = {...audio, currentTime: audioPos(), at: now()}
        segWall += now() - segSince
        allWall += now() - allSince
        segSince = allSince = null
      }
    },
    current: () => cur,
    setAudioBased(value) {
      audioBased = !!value
    },
    markEnded() {
      endPending = true
    },
    markSkipped() {
      skipPending = true
    },
    //the rate of a built-in voice changed: segments already read keep their real time for "elapsed" but
    //no longer tell the speed, and the rest will be measured again
    markRateChanged() {
      const speed = measuredSpeed()
      segs.forEach((seg, i) => {
        if (i < cur) {
          //a skipped one keeps its estimate at the old speed, so "elapsed" doesn't drop
          if (seg.sec == null && speed) seg.sec = seg.chars / speed
          seg.oldRate = true
        }
        else seg.sec = null
      })
      //if it goes on from where it was (restartCurrent(true)) its time mixes both rates
      if (segs[cur]) segs[cur].mixed = true
    },
    switchTo(index, endedBySentence) {
      const seg = segs[cur]
      if (seg && seg.sec == null && (endPending || endedBySentence) && !skipPending) {
        const played = segPlayed() / 1000
        if (played > 0) {
          seg.sec = played
          //read at two rates: its time counts for "elapsed", but it doesn't tell the speed
          seg.oldRate = !!seg.mixed
        }
      }
      cur = index
      resetSegment()
    },
    //the current segment is read again: from its start, or (keepPlayed) from where it was, the time going on
    restartCurrent(keepPlayed) {
      if (!keepPlayed) return resetSegment()
      //built-in voices: the wall clock of the segment just keeps running
      if (audioBased) {
        if (audio) {
          carry = audioPlayed()
          carryFraction = audioPos() / audio.duration
        }
        //nothing played yet: it's read from its start
        else if (carryFraction == null) carry = 0
        audio = null
        rateSwitch = false
      }
    },
    //the audio element's rate changed in place: what was played so far stays, the rest goes at the new rate
    changeRate(rate) {
      //skipped segments keep their estimate at the old rate, so "elapsed" doesn't jump
      const speed = measuredSpeed()
      if (speed) segs.forEach((seg, i) => {
        if (i < cur && seg.sec == null) seg.sec = seg.chars / speed
      })
      curRate = rate
      if (!audio || sameRate(rate, audio.rate)) return
      const pos = audioPos(), played = audioPlayed()
      audio = {...audio, currentTime: pos, at: now(), pos0: pos, sec0: played, rate}
      rateSwitch = true
      if (segs[cur]) segs[cur].sec = audioSegmentSec()
    },
    audioFraction,
    onAudioTime(event) {
      if (!(event.duration > 0) || !isFinite(event.duration)) return false
      const rate = event.rate > 0 ? event.rate : 1
      if (audio && rateSwitch) {
        //sent before the new rate reached the audio: its position doesn't belong to the new stretch
        if (!sameRate(rate, audio.rate)) return false
        rateSwitch = false
      }
      const first = !audio
      if (first) {
        //read again from where it was: this audio starts partway, at the time already played
        audio = {pos0: carry != null ? event.currentTime : 0, sec0: carry || 0, rate}
        carry = carryFraction = null
      }
      else if (!sameRate(rate, audio.rate)) {
        //the rate changed without changeRate(): a new stretch from here
        audio = {...audio, pos0: event.currentTime, sec0: audioPlayed(), rate}
      }
      audio = {...audio, currentTime: event.currentTime, duration: event.duration, at: now()}
      curRate = rate
      if (segs[cur]) {
        segs[cur].sec = audioSegmentSec()
        segs[cur].dur = event.duration
      }
      return first
    },
    snapshot(singlePage) {
      if (!singlePage) return {elapsed: allPlayed() / 1000, total: null, progress: null}
      const speed = measuredSpeed()
      const estimate = i => segs[i].sec != null ? segs[i].sec : speed ? segs[i].chars / speed : 0
      const curPlayed = audio ? audioPlayed() : audioBased ? carry || 0 : segPlayed() / 1000
      let before = 0, charsBefore = 0
      for (let i = 0; i < cur && i < segs.length; i++) {
        before += estimate(i)
        charsBefore += segs[i].chars
      }
      const elapsed = before + curPlayed
      let total = null
      if (speed) {
        total = 0
        for (let i = 0; i < segs.length; i++) total += i == cur ? Math.max(estimate(i), curPlayed) : estimate(i)
      }
      let progress
      if (total) progress = Math.min(1, elapsed / total)
      else if (totalChars) progress = (charsBefore + (audioFraction() || 0) * (segs[cur] ? segs[cur].chars : 0)) / totalChars
      else progress = 0
      return {elapsed, total, progress}
    },
  }

  //average speed (chars/s) at the current rate. Audio files: from their length, which doesn't depend on the
  //rate they're played at, so a rate change doesn't lose what was measured. Built-in voices: from the
  //segments read to the end at the current rate
  function measuredSpeed() {
    let knownChars = 0, knownSec = 0
    for (const seg of segs) {
      if (audioBased ? seg.dur > 0 : seg.sec > 0 && !seg.oldRate) {
        knownChars += seg.chars
        knownSec += audioBased ? seg.dur / (curRate || 1) : seg.sec
      }
    }
    return knownChars > 0 ? knownChars / knownSec : null
  }

  function resetSegment() {
    segWall = 0
    if (segSince != null) segSince = now()
    audio = null
    carry = carryFraction = null
    rateSwitch = false
    endPending = skipPending = false
    if (segs[cur]) segs[cur].mixed = false
  }
}

function countSpokenChars(text) {
  return Array.from(text.replace(/\s+/g, "")).length
}



/**
 * Maps every segment the engine reads back to character offsets in the source text — the selected
 * text (alignSegmentsToSource) or the extracted paragraphs of whole-page reading (alignSegmentsToParas).
 *
 * The source goes through these steps before it's spoken, and each is replayed here
 * while keeping, for every output character, the offset it came from (-1 = inserted):
 *   1. split into paragraphs         js/player.js      playText() (selections only)
 *   2. repeated chars / URLs         js/document.js    preprocess()
 *   3. '.' added to paragraph ends   js/speech.js      Speech()
 *   4. paragraphs joined with "\n\n" js/speech.js      Speech()
 *   5. split into segments           js/speech.js      getChunks()
 * Step 5 only cuts the joined text (some breakers drop whitespace), so segments are matched
 * against it in order. If anything doesn't line up, returns null and the page shows no highlight.
 */
function alignSegmentsToSource(sourceText, segTexts) {
  //selections: playText() splits them at every line break (splitParagraphs)
  const separator = /\s*\r?\n\s*/g
  const paragraphs = []
  let last = 0, match
  while ((match = separator.exec(sourceText))) {
    paragraphs.push({text: sourceText.slice(last, match.index), offset: last})
    last = match.index + match[0].length
  }
  paragraphs.push({text: sourceText.slice(last), offset: last})
  //the '.' rule of Speech() in js/speech.js for a selection (splitParagraphs)
  return alignParagraphs(paragraphs, /[^\s.!?,;:…。！？、，；：]$/, segTexts)
}

//whole-page reading: the source is the extracted paragraphs themselves, and offsets refer to them
//joined with "\n\n" — the page side (getDocSpans() in js/page-ui.js) counts the same way.
//splitParagraphs: they're read like a selection (html-doc), with its wider '.' rule
function alignSegmentsToParas(sourceParas, segTexts, splitParagraphs) {
  const paragraphs = []
  let off = 0
  for (let i = 0; i < sourceParas.length; i++) {
    if (i > 0) off += 2
    paragraphs.push({text: sourceParas[i], offset: off})
    off += sourceParas[i].length
  }
  //the '.' rules of Speech() in js/speech.js
  return alignParagraphs(paragraphs, splitParagraphs ? /[^\s.!?,;:…。！？、，；：]$/ : /[\w)]$/, segTexts)
}

/**
 * Maps every segment the engine reads back to character offsets in the source text —
 * paragraphs at the given offsets in it, transformed as described in the header comment above.
 */
function alignParagraphs(paragraphs, needsPeriod, segTexts) {
  let joined = "", joinedSrc = []

  for (let i = 0; i < paragraphs.length; i++) {
    const original = paragraphs[i].text
    const base = paragraphs[i].offset
    let src = []
    for (let k = 0; k < original.length; k++) src.push(base + k)
    let step = truncateRepeatedCharsTracked(original, src, 3)
    step = replaceUrlsTracked(step.text, step.src)
    //must stay identical to preprocess() in js/document.js
    if (step.text != truncateRepeatedChars(original, 3).replace(/https?:\/\/\S+/g, "HTTP URL.")) return null
    let text = step.text
    src = step.src
    //the '.' added to paragraph ends by Speech() in js/speech.js
    if (needsPeriod.test(text)) {
      text += "."
      src.push(-1)
    }
    if (i > 0) {
      joined += "\n\n"
      joinedSrc.push(-1, -1)
    }
    joined += text
    joinedSrc = joinedSrc.concat(src)
  }

  const maps = []
  let pos = 0
  for (const seg of segTexts) {
    const map = new Array(seg.length).fill(-1)
    for (let j = 0; j < seg.length; j++) {
      const c = seg[j]
      while (pos < joined.length && joined[pos] != c && /\s/.test(joined[pos])) pos++
      if (pos < joined.length && joined[pos] == c) map[j] = joinedSrc[pos++]
      else if (!/\s/.test(c)) return null
    }
    maps.push(map)
  }

  return {
    segmentRange(index) {
      const map = maps[index]
      return map ? spanOf(map, 0, map.length) : null
    },
    wordRange(index, charIndex, length) {
      const map = maps[index]
      const seg = segTexts[index]
      if (!map || !(charIndex >= 0) || charIndex >= seg.length) return null
      let end = length > 0 ? charIndex + length : charIndex
      if (!(length > 0)) while (end < seg.length && !/[\s.,!?;:"'()[\]{}、。，！？]/.test(seg[end])) end++
      return spanOf(map, charIndex, Math.max(end, charIndex + 1))
    },
  }

  function spanOf(map, from, to) {
    let min = Infinity, max = -1
    for (let j = from; j < to && j < map.length; j++) {
      if (map[j] >= 0) {
        if (map[j] < min) min = map[j]
        if (map[j] > max) max = map[j]
      }
    }
    return max >= 0 ? [min, max + 1] : null
  }
}

//same as truncateRepeatedChars() in js/defaults.js, also carrying each char's source offset
function truncateRepeatedCharsTracked(text, src, max) {
  let result = "", resultSrc = []
  let startIndex = 0
  let count = 1
  for (let i = 1; i < text.length; i++) {
    if (text.charCodeAt(i) == text.charCodeAt(i-1) && !/^\d$/.test(text.charAt(i))) {
      count++
      if (count == max) {
        result += text.slice(startIndex, i+1)
        resultSrc = resultSrc.concat(src.slice(startIndex, i+1))
      }
    }
    else {
      if (count >= max) startIndex = i
      count = 1
    }
  }
  if (count < max) {
    result += text.slice(startIndex)
    resultSrc = resultSrc.concat(src.slice(startIndex))
  }
  return {text: result, src: resultSrc}
}

//URLs are read as "HTTP URL."; its first and last chars point at the URL's ends so the highlight covers it
function replaceUrlsTracked(text, src) {
  const replacement = "HTTP URL."
  const urls = /https?:\/\/\S+/g
  let result = "", resultSrc = []
  let last = 0, match
  while ((match = urls.exec(text))) {
    result += text.slice(last, match.index)
    resultSrc = resultSrc.concat(src.slice(last, match.index))
    result += replacement
    for (let k = 0; k < replacement.length; k++) {
      resultSrc.push(k == 0 ? src[match.index] : k == replacement.length-1 ? src[match.index + match[0].length - 1] : -1)
    }
    last = match.index + match[0].length
  }
  result += text.slice(last)
  resultSrc = resultSrc.concat(src.slice(last))
  return {text: result, src: resultSrc}
}
