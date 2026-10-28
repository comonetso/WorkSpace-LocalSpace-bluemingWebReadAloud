function Speech(texts, options) {
  options.rate = (options.rate || 1) * (isGoogleNative(options.voice) ? 0.9 : 1);
  //Google native voices get a safety end timeout that suits chunks cut for this rate (getChunks)
  const GOOGLE_NATIVE_END_TIMEOUT = 16*1000
  //a request to Google's voices (fitBytes)
  const GOOGLE_REQUEST_BYTES = 2000
  const chunkRate = options.rate
  //paragraphs kept apart (CharBreaker): a selection's every one (2026-10-28, as in the Paseo plugin — short ones were
  //joined to the next before), a page read by its lines (html-doc) all but short ones
  const keepApart = options.splitParagraphs && (options.selection ? "all" : "short")

  //a paragraph gets a '.' at its end, segments being cut at sentences (CharBreaker). A selection's lines
  //(splitParagraphs), which may be read together (CharBreaker), get it whenever they don't end in punctuation
  //whatever the language; other readings only after latin letters, digits or ')'. It's marked (ADDED_PERIOD,
  //js/defaults.js): the voice isn't given it, its lines end as the Paseo plugin has them (js/spoken-text.js).
  //replayed by alignSegmentsToSource() in js/page-ui-host.js for the selection highlight, keep them in sync
  var needsPeriod = options.splitParagraphs ? /[^\s.!?,;:…。！？、，；：]$/ : /[\w)]$/;
  for (var i=0; i<texts.length; i++) if (needsPeriod.test(texts[i])) texts[i] += ADDED_PERIOD;
  //the paragraphs the segments are cut from, for following what the page shows (follow())
  let paras = texts.slice()
  if (texts.length) texts = getChunks(texts.join("\n\n"));

  var self = this;
  const engine = pickEngine()
  const events$ = new rxjs.Subject()

  this.options = options;
  this.events$ = events$.asObservable()
  //engines playing each segment's audio file through playAudio(): they report its position ("time" events)
  this.reportsAudioTime = [
    googleTranslateTtsEngine, amazonPollyTtsEngine, googleWavenetTtsEngine,
    ibmWatsonTtsEngine, openaiTtsEngine, naverClovaTtsEngine, azureTtsEngine
  ].includes(engine)
  //audio played through playAudio() can be muted without stopping playback
  this.canMute = this.reportsAudioTime
  this.play = () => playbackState$.next("resumed")
  this.pause = () => playbackState$.next("paused")
  this.stop = () => cmd$.error({name: "CancellationException", message: "Playback cancelled"})
  this.getState = getState;
  this.getInfo = getInfo;
  this.canForward = () => engine.forward != null || playlist.canForward()
  this.canRewind = () => engine.rewind != null || playlist.canRewind()
  this.forward = () => cmd$.next({name: "forward", delay: 750})
  this.rewind = () => cmd$.next({name: "rewind", delay: 750})
  this.seek = index => {
    cmd$.next({name: "seek", index})
    playbackState$.next("resumed")
  }
  //audio played through playAudio() gets its rate and volume from the audio element, none of these engines
  //synthesizes with them (see NaverClovaTtsEngine), so they can change while it plays
  this.changesRateVolumeInPlace = this.reportsAudioTime
  //engines whose voice follows the pitch; the others make the same audio whatever it is
  this.usesPitch = ![
      googleTranslateTtsEngine, amazonPollyTtsEngine, ibmWatsonTtsEngine, openaiTtsEngine, azureTtsEngine
    ].includes(engine)
    && !(engine == googleWavenetTtsEngine && /^GoogleChirp/.test(options.voice.voiceName))
  //every engine takes new rate/pitch/volume while reading (js/page-ui-host.js checks this)
  this.appliesParamsLive = true

  //new rate/pitch/volume from the page bar ----------------------------------------
  //applied by the audio element (changesRateVolumeInPlace): same object, so prefetched audio stays usable
  this.updateParams = params => {
    Object.assign(options, params)
  }
  //values the voice is made with: a new object, so audio made with the old values isn't reused.
  //The segment being read goes on as it was; restartSegment() or prepareSegment() brings the new values in
  this.setParams = params => {
    options = {...options, ...params}
    if (params.rate != null) options.rate = params.rate * (isGoogleNative(options.voice) ? 0.9 : 1)
    self.options = options
    if (engine.setEndTimeout) engine.setEndTimeout(GOOGLE_NATIVE_END_TIMEOUT * chunkRate / options.rate)
  }
  //next/previous wait a moment before moving (their delay), the current index already being where they go
  this.isMovePending = () => movePending
  //read the current segment again with the current values. carryOn: it goes on from where it was (fromChar
  //for the built-in voices, or the position the page bar hands to playAudio), so it keeps its start time,
  //which "rewind" looks at
  this.restartSegment = ({fromChar, carryOn} = {}) => {
    if (engine.seek == null && playlist.getIndex() != null) {
      cmd$.next({name: "seek", index: playlist.getIndex(), fromChar, keepTs: carryOn})
    }
  }
  //make the current segment's audio with the current values while the old audio keeps playing (engines whose
  //prefetch() resolves true when done). True if it's ready and still the segment being read: restartSegment()
  //then plays it without waiting. False if it couldn't be made: the old audio plays on
  this.prepareSegment = async () => {
    const index = playlist.getIndex()
    if (index == null || engine.prefetch == null || movePending) return false
    const ready = await engine.prefetch(spokenOf(texts[index]).text, options)
    return ready === true && !movePending && playlist.getIndex() == index
  }
  this.gotoEnd = () => cmd$.next({name: "gotoEnd"})

  //whole-page reading following what the page shows (2026-10-24): the page may rewrite its text while it's read
  //(the DeepL extension translates what comes near the view, ~2 s after). Before a segment is made — prefetched or
  //read — the paragraphs are read again from the page and the segments not begun yet are cut again from them; one
  //whose paragraph the translator hasn't done yet isn't prefetched, and before it's read the translation is waited
  //for (js/document.js gives how long). provider: refresh() -> {texts, keys, waiting, prevKeys} | null, and
  //waitTranslated(page paragraph index)
  this.follow = provider => {
    cover = coverOf(paras, texts)
    follower = cover ? provider : null
    followVersion++
  }

  let follower = null
  let cover = null          //for each segment, the first and last of paras it's cut from
  let paraKeys = null       //each of paras' key on the page (element:line, js/content/html-doc.js)
  let pageParas = null      //the page's paragraphs when last asked: {keys, waiting, at: key -> index}
  let followVersion = 0     //changes whenever the segments or their paragraphs' places on the page may have
  let begunIndex = -1       //the last segment begun: it and those before aren't cut again
  let pageRanges = null

  //segments are cut from the paragraphs joined with "\n\n", the separator going with the segment before: joined
  //again they're that text, and their offsets tell the paragraphs. Null if they aren't
  function coverOf(paraList, chunks) {
    if (chunks.join("") != paraList.join("\n\n")) return null
    const ends = []
    let off = 0
    for (let i = 0; i < paraList.length; i++) {
      if (i) off += 2
      off += paraList[i].length
      ends.push(off)
    }
    const result = []
    let start = 0, p = 0
    for (const chunk of chunks) {
      const end = start + chunk.length
      while (p < ends.length - 1 && start >= ends[p]) p++
      let q = p
      while (q < ends.length - 1 && end > ends[q] + 2) q++
      result.push([p, q])
      start = end
    }
    return result
  }

  const elementOf = key => key.slice(0, key.indexOf(":") + 1)

  //a paragraph's place among the page's paragraphs now; when its line moved (the element's lines changed), its
  //element's first or last line. -1: gone
  function pageIndexOf(p, last) {
    if (!pageParas || !paraKeys) return p
    const key = paraKeys[p]
    const at = pageParas.at.get(key)
    if (at != null) return at
    const elem = elementOf(key)
    return last ? pageParas.keys.findLastIndex(k => k.startsWith(elem)) : pageParas.keys.findIndex(k => k.startsWith(elem))
  }

  //for each segment, the first and last of the page's paragraphs it reads (the page highlight lights them)
  function getPageRanges() {
    if (!follower || !cover) return null
    if (pageRanges && pageRanges.version == followVersion) return pageRanges.list
    const list = cover.map(([p, q]) => {
      const a = pageIndexOf(p, false), b = pageIndexOf(q, true)
      return a >= 0 && b >= a ? [a, b] : null
    })
    pageRanges = {version: followVersion, list}
    return list
  }

  //the page's paragraph a segment waits for (not translated yet), or null
  function waitingPageIndex(index) {
    if (!pageParas || !cover || !cover[index]) return null
    for (let p = cover[index][0]; p <= cover[index][1]; p++) {
      const i = pageIndexOf(p, false)
      if (i >= 0 && pageParas.waiting[i]) return i
    }
    return null
  }

  //the page's elements segments index and index + 1 are cut from (places among the elements read): only those are
  //read again. All of them the first time, the paragraphs' keys not known yet
  function elementRange(index) {
    if (!paraKeys || !cover || !cover[index]) return [null, null]
    const elemNo = p => Number(paraKeys[p].slice(0, paraKeys[p].indexOf(":")))
    return [elemNo(cover[index][0]), elemNo(cover[Math.min(index + 1, cover.length - 1)][1])]
  }

  //ask the page for its paragraphs and cut the segments from index on again where they changed
  async function syncFollow(index) {
    if (!follower || index >= texts.length) return
    let page
    try {
      page = await follower.refresh(...elementRange(index))
    }
    catch (err) {
      console.warn("Cannot read the page again", err)
      return
    }
    if (!follower) return
    if (!page || !page.texts || !page.keys) {
      follower = null
      followVersion++
      return
    }
    if (!paraKeys) {
      //the paragraphs handed out at the start, in the same order then
      if (!page.prevKeys || page.prevKeys.length != paras.length) {
        follower = null
        followVersion++
        return
      }
      paraKeys = page.prevKeys.slice()
    }
    pageParas = {keys: page.keys, waiting: page.waiting || [], at: new Map(page.keys.map((key, i) => [key, i]))}
    followVersion++
    recut(index, page.texts.map(text => needsPeriod.test(text) ? text + ADDED_PERIOD : text), page.keys)
  }

  //from the first segment at or after index (and after those begun) that starts a new paragraph. Inside an element
  //partly read (a list read item by item), from its next line if it has as many lines as before (each line is the
  //same item), else from the next element: its lines may have moved
  function recut(index, fresh, keys) {
    let k = Math.max(index, begunIndex + 1)
    const count = (list, elem) => list.reduce((n, key) => n + (key.startsWith(elem) ? 1 : 0), 0)
    const linesKept = elem => count(paraKeys, elem) == count(keys, elem)
    const midElement = (a, b) => elementOf(paraKeys[a]) == elementOf(paraKeys[b]) && !linesKept(elementOf(paraKeys[a]))
    while (k < texts.length && k > 0 && (cover[k][0] <= cover[k - 1][1] || midElement(cover[k][0], cover[k - 1][1]))) k++
    if (k >= texts.length) return
    const p0 = cover[k][0]
    const elem = elementOf(paraKeys[p0])
    let q0 = keys.indexOf(paraKeys[p0])
    if (q0 < 0) q0 = keys.findIndex(key => key.startsWith(elem))
    if (q0 < 0) return
    const tail = fresh.slice(q0), tailKeys = keys.slice(q0)
    const keysNow = paraKeys.slice(0, p0).concat(tailKeys)
    if (tail.length == paras.length - p0 && tail.every((text, i) => text == paras[p0 + i])) {
      paraKeys = keysNow
      return
    }
    const chunks = tail.length ? getChunks(tail.join("\n\n")) : []
    if (!chunks.length) return
    const nextParas = paras.slice(0, p0).concat(tail)
    const nextTexts = texts.slice(0, k).concat(chunks)
    const nextCover = coverOf(nextParas, nextTexts)
    if (!nextCover) return
    paras = nextParas
    paraKeys = keysNow
    texts = nextTexts
    cover = nextCover
    followVersion++
  }

  //before a segment is read: its paragraphs as the page shows them now, translated if they're being. keepCurrent
  //(read again from where it was): it stays as it was, the ones after follow
  async function prepareToRead(index, keepCurrent) {
    begunIndex = keepCurrent ? index : index - 1
    await syncFollow(keepCurrent ? index + 1 : index)
    if (keepCurrent || !follower) return
    const waiting = waitingPageIndex(index)
    if (waiting == null) return
    await follower.waitTranslated(waiting).catch(err => console.warn("Cannot wait for the translation", err))
    await syncFollow(index)
  }

  //while a segment is read: the next one as the page shows it, prefetched unless it waits for its translation
  async function followAhead(index) {
    await syncFollow(index + 1)
    if (playlist.getIndex() != index || engine.prefetch == null) return
    const next = texts[index + 1]
    if (next && waitingPageIndex(index + 1) == null) engine.prefetch(spokenOf(next).text, options)
  }

  function pickEngine() {
    if (isNaverClova(options.voice)) return naverClovaTtsEngine;
    if (isAzure(options.voice)) return azureTtsEngine;
    if (isOpenai(options.voice)) return openaiTtsEngine;
    if (isGoogleTranslate(options.voice) && !/\s(Hebrew|Telugu)$/.test(options.voice.voiceName)) {
      return googleTranslateTtsEngine
    }
    if (isAmazonPolly(options.voice)) return amazonPollyTtsEngine;
    if (isGoogleWavenet(options.voice)) return googleWavenetTtsEngine;
    if (isIbmWatson(options.voice)) return ibmWatsonTtsEngine;
    if (isGoogleNative(options.voice)) return new TimeoutTtsEngine(browserTtsEngine, 3*1000, GOOGLE_NATIVE_END_TIMEOUT);
    return browserTtsEngine;
  }

  //what the voice is given for a segment (js/spoken-text.js), while the page shows the segment as it is
  function spokenOf(text) {
    return spokenText(text)
  }
  //if it can't be made, the voice reads the text as it is rather than not at all
  function spokenText(text) {
    try {
      return makeSpokenText(text, options.voice && options.voice.lang || options.lang)
    }
    catch (err) {
      console.error(err)
      return {text, sourceIndex: i => i}
    }
  }

  function getChunks(text) {
    var isEA = /^zh|ko|ja/.test(options.lang);
    var punctuator = isEA ? new EastAsianPunctuator() : new LatinPunctuator();
    if (isGoogleNative(options.voice)) {
      var wordLimit = (/^(de|ru|es|pt|id)/.test(options.lang) ? 32 : 36) * (isEA ? 2 : 1) * options.rate;
      return fitSpoken(new WordBreaker(wordLimit, punctuator).breakText(text),
        text => punctuator.getWords(text).length, wordLimit, limit => new WordBreaker(limit, punctuator));
    }
    else {
      if (isGoogleTranslate(options.voice)) {
        return fitSpoken(new CharBreaker(200, punctuator, null, keepApart).breakText(text),
          text => text.length, 200, limit => new CharBreaker(limit, punctuator, null, keepApart));
      }
      var chunks = new CharBreaker(750, punctuator, 200, keepApart).breakText(text);
      return isGoogleWavenet(options.voice) ? fitBytes(chunks, GOOGLE_REQUEST_BYTES, punctuator) : chunks;
    }
  }

  //a request to Google's voices is kept within 2000 bytes, its pause markup counted, as in the Paseo plugin (2026-10-28,
  //tts.ts INPUT_CHUNK_BYTES); a segment over it is broken again, smaller, on the same breaks
  function fitBytes(chunks, limit, punctuator) {
    const bytes = text => googleWavenetTtsEngine.requestBytes(spokenText(text).text, options.voice)
    return chunks.flatMap(chunk => {
      const size = bytes(chunk)
      if (size <= limit || chunk.length < 2) return [chunk]
      const smaller = Math.max(1, Math.min(chunk.length - 1, Math.floor(chunk.length * limit / size)))
      return fitBytes(new CharBreaker(smaller, punctuator, null, keepApart).breakText(chunk), limit, punctuator)
    })
  }

  //the voice is given the spoken text (spokenText), which can be longer than the segment. Where the engine takes only
  //so much (Google Translate: 200 chars; Google native voices: the words their end timeout suits), a segment that
  //grows past it (measure > limit) is broken again, smaller (breakerOf cuts by the same measure)
  function fitSpoken(chunks, measure, limit, breakerOf) {
    return chunks.flatMap(chunk => {
      const size = measure(spokenText(chunk).text), own = measure(chunk)
      if (size <= limit || own < 2) return [chunk]
      const smaller = Math.max(1, Math.min(own - 1, Math.floor(own * limit / size)))
      return fitSpoken(breakerOf(smaller).breakText(chunk), measure, limit, breakerOf)
    })
  }

  async function getState() {
    if (playbackState$.value == "resumed") {
      return await rxjs.firstValueFrom(isLoading$) ? "LOADING" : "PLAYING"
    } else {
      return "PAUSED"
    }
  }

  function getInfo() {
    return {
      texts: texts,
      position: {
        index: playlist.getIndex()
      },
      isRTL: /^(ar|az|dv|he|iw|ku|fa|ur)\b/.test(options.lang),
      //following the page (follow()): each segment's paragraphs on the page, and a number changing with them
      pageRanges: getPageRanges(),
      followVersion,
    }
  }



  const playbackState$ = new rxjs.BehaviorSubject("paused")
  const playlist = makePlaylist()
  const cmd$ = new rxjs.Subject()
  let movePending = false
  const isLoadingSubject = new rxjs.BehaviorSubject(false)
  const isLoading$ = isLoadingSubject.pipe(
    rxjs.distinctUntilChanged(),
    rxjs.scan((previous$, isLoading) =>
      rxjs.iif(() => previous$ && isLoading, rxjs.timer(2000), rxjs.of(0)).pipe(
        rxjs.map(() => isLoading)
      ),
      null
    ),
    rxjs.switchAll(),
    rxjs.shareReplay({bufferSize: 1, refCount: false})
  )
  this.state$ = rxjs.combineLatest([playbackState$.pipe(rxjs.distinctUntilChanged()), isLoading$]).pipe(
    rxjs.map(([state, isLoading]) => state == "resumed" ? (isLoading ? "LOADING" : "PLAYING") : "PAUSED"),
    rxjs.distinctUntilChanged()
  )

  cmd$.pipe(
    rxjs.startWith({name: "first"}),
    rxjs.scan((current, cmd) => {
      switch (cmd.name) {
        case "first": {
          const playback$ = playlist.first()
          return playback$ ? {playback$, ts: Date.now()} : null
        }
        case "forward": {
          if (engine.forward != null) {
            engine.forward()
            return current
          } else {
            const playback$ = playlist.forward()
            return playback$ ? {playback$, ts: Date.now(), delay: cmd.delay} : null
          }
        }
        case "rewind": {
          if (engine.rewind != null) {
            engine.rewind()
            return current
          } else if (Date.now()-current.ts > 3000) {
            const playback$ = playlist.seek(playlist.getIndex())
            return playback$ ? {playback$, ts: Date.now()} : current
          } else {
            const playback$ = playlist.rewind()
            return playback$ ? {playback$, ts: Date.now(), delay: cmd.delay} : current
          }
        }
        case "seek": {
          if (engine.seek != null) {
            engine.seek(cmd.index)
            return current
          } else {
            const playback$ = playlist.seek(cmd.index, cmd.fromChar, cmd.keepTs)
            return playback$ ? {playback$, ts: cmd.keepTs && current ? current.ts : Date.now()} : current
          }
        }
        case "gotoEnd": {
          const playback$ = playlist.gotoEnd()
          return playback$ ? {playback$, ts: Date.now()} : current
        }
      }
    }, null),
    rxjs.takeWhile(x => x),
    rxjs.distinctUntilChanged(),
    rxjs.tap(x => {
      if (x.delay) movePending = true
    }),
    rxjs.debounce(x => x.delay ? rxjs.timer(x.delay) : rxjs.of(0)),
    rxjs.tap(() => movePending = false),
    rxjs.switchMap(x =>
      rxjs.concat(
        rxjs.of({type: "load"}),
        x.playback$
      )
    )
  )
  .subscribe({
    next(event) {
      isLoadingSubject.next(event.type == "load")
      //announce "end" before moving on, otherwise listeners get the next segment's "load" first
      if (event.type == "end") events$.next({...event, index: playlist.getIndex()})
      switch (event.type) {
        case "start": {
          if (follower) followAhead(playlist.getIndex()).catch(console.error)
          else {
            const nextText = texts[playlist.getIndex() + 1]
            if (nextText && engine.prefetch != null) engine.prefetch(spokenOf(nextText).text, options)
          }
          break
        }
        case "end":
          if (!movePending) {
            //a forward/rewind already waiting for its delay decides where to go next
            cmd$.next({name: "forward"})
          }
          break
      }
      if (event.type != "end") events$.next({...event, index: playlist.getIndex()})
    },
    complete() {
      events$.complete()
      if (self.onEnd) self.onEnd()
    },
    error(err) {
      events$.complete()
      if (err.name != "CancellationException") {
        if (self.onEnd) self.onEnd(err)
      }
    }
  })



  function makePlaylist() {
    let index
    return {
      getIndex() {
        return index
      },
      first() {
        if (0 < texts.length) {
          index = 0
          return makePlaybackAt(index)
        }
      },
      canForward() {
        return index+1 < texts.length
      },
      canRewind() {
        return index > 0
      },
      forward() {
        if (index+1 < texts.length) {
          index++
          return makePlaybackAt(index)
        }
      },
      rewind() {
        if (index > 0) {
          index--
          return makePlaybackAt(index)
        }
      },
      seek(toIndex, fromChar, keepCurrent) {
        if (toIndex >= 0 && toIndex < texts.length) {
          index = toIndex
          return makePlaybackAt(index, fromChar, keepCurrent)
        }
      },
      gotoEnd() {
        const toIndex = texts.length - 1
        if (toIndex >= 0) {
          index = toIndex
          return makePlaybackAt(index)
        }
      }
    }
  }



  //the segment's text is taken when it's read: following the page (follow()), it may be cut again just before
  function makePlaybackAt(index, fromChar, keepCurrent) {
    if (!follower) return makePlayback(texts[index], fromChar)
    const keep = keepCurrent || fromChar > 0
    return rxjs.defer(() => rxjs.from(prepareToRead(index, keep).catch(console.error))).pipe(
      rxjs.switchMap(() => {
        begunIndex = Math.max(begunIndex, index)
        return makePlayback(texts[index], fromChar)
      })
    )
  }

  function makePlayback(text, fromChar) {
    if (engine.stop != null) return makePlaybackLegacy(text, fromChar)
    else return engine.speak(spokenOf(text).text, options, playbackState$)
  }

  //fromChar: speak only the rest of the text; event positions still count from the start of it
  function makePlaybackLegacy(text, fromChar) {
    const from = fromChar > 0 && fromChar < text.length ? fromChar : 0
    //the rest of the whole segment's spoken text, from where its char "from" is said: a word run together or a
    //sentence in capitals reads as it did when the segment began (README's "me" isn't spelled out)
    const spoken = spokenOf(text)
    let start = 0
    while (from && start < spoken.text.length && spoken.sourceIndex(start) < from) start++
    //an event's position in what the voice was given (a word: charIndex and length), in the text
    const toText = event => {
      const charIndex = spoken.sourceIndex(start + event.charIndex)
      const moved = {...event, charIndex}
      if (event.length > 0) moved.length = spoken.sourceIndex(start + event.charIndex + event.length - 1) + 1 - charIndex
      return moved
    }
    return playbackState$.pipe(
      rxjs.distinctUntilChanged(),
      rxjs.scan((playing$, state) => {
        if (state == "resumed") {
          if (playing$) {
            engine.resume()
            return playing$
          } else {
            return new rxjs.Observable(observer => {
              engine.speak(spoken.text.slice(start), options, event => {
                if (event.type == "error") observer.error(event.error)
                else observer.next(event.charIndex != null ? toText(event) : event)
              })
            })
          }
        } else if (state == "paused") {
          if (playing$) {
            if (isGoogleNative(options.voice) || isChromeOSNative(options.voice)) {
              engine.stop()
              return null
            } else {
              engine.pause()
              return playing$
            }
          } else {
            return null
          }
        }
      }, null),
      rxjs.distinctUntilChanged(),
      rxjs.switchMap(playing$ => {
        if (playing$) {
          return playing$.pipe(
            rxjs.finalize(() => engine.stop())
          )
        } else {
          return rxjs.EMPTY
        }
      }),
      rxjs.takeWhile(event => event.type != "end", true)
    )
  }



  //text breakers

  function WordBreaker(wordLimit, punctuator) {
    this.breakText = breakText;
    function breakText(text) {
      return punctuator.getParagraphs(text).flatMap(breakParagraph)
    }
    function breakParagraph(text) {
      return punctuator.getSentences(text).flatMap(breakSentence)
    }
    function breakSentence(sentence) {
      return merge(punctuator.getPhrases(sentence), breakPhrase);
    }
    function breakPhrase(phrase) {
      var words = punctuator.getWords(phrase);
      var splitPoint = Math.min(Math.ceil(words.length/2), wordLimit);
      var result = [];
      while (words.length) {
        result.push(words.slice(0, splitPoint).join(""));
        words = words.slice(splitPoint);
      }
      return result;
    }
    function merge(parts, breakPart) {
      var result = [];
      var group = {parts: [], wordCount: 0};
      var flush = function() {
        if (group.parts.length) {
          result.push(group.parts.join(""));
          group = {parts: [], wordCount: 0};
        }
      };
      parts.forEach(function(part) {
        var wordCount = punctuator.getWords(part).length;
        if (wordCount > wordLimit) {
          flush();
          var subParts = breakPart(part);
          for (var i=0; i<subParts.length; i++) result.push(subParts[i]);
        }
        else {
          if (group.wordCount + wordCount > wordLimit) flush();
          group.parts.push(part);
          group.wordCount += wordCount;
        }
      });
      flush();
      return result;
    }
  }

  function CharBreaker(charLimit, punctuator, paragraphCombineThreshold, keepParagraphsApart) {
    //keepParagraphsApart: "all" (a selection) reads every paragraph on its own; "short" (a page read by its lines)
    //too, except that lines this short (spaces not counted) go with the next: they're over before the next segment's
    //audio is made, leaving a gap. Counted in UTF-8 bytes: 20 Korean characters (3 bytes each), or 60 English ones
    var SHORT_LINE_BYTES = 60;
    var utf8 = new TextEncoder();
    this.breakText = breakText;
    function breakText(text) {
      return merge(punctuator.getParagraphs(text), breakParagraph, paragraphCombineThreshold, keepParagraphsApart);
    }
    function breakParagraph(text) {
      return merge(punctuator.getSentences(text), breakSentence);
    }
    function breakSentence(sentence) {
      return merge(punctuator.getPhrases(sentence), breakPhrase);
    }
    function breakPhrase(phrase) {
      return merge(punctuator.getWords(phrase), breakWord);
    }
    function breakWord(word) {
      var result = [];
      while (word) {
        result.push(word.slice(0, charLimit));
        word = word.slice(charLimit);
      }
      return result;
    }
    function merge(parts, breakPart, combineThreshold, keepApart) {
      var result = [];
      var group = {parts: [], charCount: 0, spokenBytes: 0};
      var flush = function() {
        if (group.parts.length) {
          result.push(group.parts.join(""));
          group = {parts: [], charCount: 0, spokenBytes: 0};
        }
      };
      parts.forEach(function(part) {
        var charCount = part.length;
        if (charCount > charLimit) {
          flush();
          var subParts = breakPart(part);
          for (var i=0; i<subParts.length; i++) result.push(subParts[i]);
        }
        else {
          var full = keepApart
            ? (keepApart == "all" ? group.parts.length > 0 : group.spokenBytes > SHORT_LINE_BYTES) || group.charCount + charCount > charLimit
            : group.charCount + charCount > (combineThreshold || charLimit);
          if (full) flush();
          group.parts.push(part);
          group.charCount += charCount;
          //a line's closing '.' isn't counted: Speech() adds one to lines without punctuation (with its mark)
          if (keepApart) group.spokenBytes += utf8.encode(part.replace(/\s+/g, "").replace(/⁣/g, "").replace(/\.$/, "")).length;
        }
      });
      flush();
      return result;
    }
  }

  function LatinPunctuator() {
    this.getParagraphs = function(text) {
      return recombine(text.split(/((?:\r?\n\s*){2,})/));
    }
    this.getSentences = function(text) {
      return recombine(text.split(/([.!?]+[\s\u200b]+)/), /\b(\w|[A-Z][a-z]|Assn|Ave|Capt|Col|Comdr|Corp|Cpl|Gen|Gov|Hon|Inc|Lieut|Ltd|Rev|Univ|Jan|Feb|Mar|Apr|Aug|Sept|Oct|Nov|Dec|dept|ed|est|vol|vs)\.\s+$/);
    }
    this.getPhrases = function(sentence) {
      return recombine(sentence.split(/([,;:]\s+|\s-+\s+|—\s*)/));
    }
    this.getWords = function(sentence) {
      var tokens = sentence.split(/([~@#%^*_+=<>]|[\s\-—/]+|\.(?=\w{2,})|,(?=[0-9]))/);
      var result = [];
      for (var i=0; i<tokens.length; i+=2) {
        if (tokens[i]) result.push(tokens[i]);
        if (i+1 < tokens.length) {
          if (/^[~@#%^*_+=<>]$/.test(tokens[i+1])) result.push(tokens[i+1]);
          else if (result.length) result[result.length-1] += tokens[i+1];
        }
      }
      return result;
    }
    function recombine(tokens, nonPunc) {
      var result = [];
      for (var i=0; i<tokens.length; i+=2) {
        var part = (i+1 < tokens.length) ? (tokens[i] + tokens[i+1]) : tokens[i];
        if (part) {
          if (nonPunc && result.length && nonPunc.test(result[result.length-1])) result[result.length-1] += part;
          else result.push(part);
        }
      }
      return result;
    }
  }

  function EastAsianPunctuator() {
    this.getParagraphs = function(text) {
      return recombine(text.split(/((?:\r?\n\s*){2,})/));
    }
    this.getSentences = function(text) {
      return recombine(text.split(/([.!?]+[\s\u200b]+|[\u3002\uff01]+)/));
    }
    this.getPhrases = function(sentence) {
      return recombine(sentence.split(/([,;:]\s+|[\u2025\u2026\u3000\u3001\uff0c\uff1b]+)/));
    }
    this.getWords = function(sentence) {
      return sentence.replace(/\s+/g, "").split("");
    }
    function recombine(tokens) {
      var result = [];
      for (var i=0; i<tokens.length; i+=2) {
        if (i+1 < tokens.length) result.push(tokens[i] + tokens[i+1]);
        else if (tokens[i]) result.push(tokens[i]);
      }
      return result;
    }
  }
}
