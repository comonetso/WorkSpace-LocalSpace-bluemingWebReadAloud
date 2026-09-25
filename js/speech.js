function Speech(texts, options) {
  options.rate = (options.rate || 1) * (isGoogleNative(options.voice) ? 0.9 : 1);
  //Google native voices get a safety end timeout that suits chunks cut for this rate (getChunks)
  const GOOGLE_NATIVE_END_TIMEOUT = 16*1000
  const chunkRate = options.rate

  //a paragraph gets a '.' at its end so the voice pauses there (line breaks don't make it pause). A selection's lines
  //(splitParagraphs), which may be read together (CharBreaker), get it whenever they don't end in punctuation
  //whatever the language; other readings only after latin letters, digits or ')'.
  //replayed by alignSegmentsToSource() in js/page-ui-host.js for the selection highlight, keep them in sync
  var needsPeriod = options.splitParagraphs ? /[^\s.!?,;:…。！？、，；：]$/ : /[\w)]$/;
  for (var i=0; i<texts.length; i++) if (needsPeriod.test(texts[i])) texts[i] += '.';
  if (texts.length) texts = getChunks(texts.join("\n\n"));

  var self = this;
  const engine = pickEngine()
  let piperState
  const events$ = new rxjs.Subject()

  this.options = options;
  this.events$ = events$.asObservable()
  //engines playing each segment's audio file through playAudio(): they report its position ("time" events)
  this.reportsAudioTime = [
    premiumTtsEngine, googleTranslateTtsEngine, amazonPollyTtsEngine, googleWavenetTtsEngine,
    ibmWatsonTtsEngine, openaiTtsEngine, naverClovaTtsEngine, azureTtsEngine
  ].includes(engine)
  //audio played through playAudio() can be muted without stopping playback;
  //Piper does that only when it can't apply the rate itself (externalPlayback in PiperTtsEngine)
  this.canMute = engine == piperTtsEngine ? !!(options.rate && options.rate != 1) : this.reportsAudioTime
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
      premiumTtsEngine, googleTranslateTtsEngine, amazonPollyTtsEngine, ibmWatsonTtsEngine, openaiTtsEngine, azureTtsEngine
    ].includes(engine)
    && !(engine == googleWavenetTtsEngine && /^GoogleChirp/.test(options.voice.voiceName))
  //Piper takes rate/pitch/volume only when it starts speaking: changes apply from the next reading
  this.appliesParamsLive = engine != piperTtsEngine

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

  function pickEngine() {
    if (isPiperVoice(options.voice)) return piperTtsEngine;
    if (isNaverClova(options.voice)) return naverClovaTtsEngine;
    if (isAzure(options.voice)) return azureTtsEngine;
    if (isOpenai(options.voice)) return openaiTtsEngine;
    if (isUseMyPhone(options.voice)) return phoneTtsEngine;
    if (isGoogleTranslate(options.voice) && !/\s(Hebrew|Telugu)$/.test(options.voice.voiceName)) {
      return googleTranslateTtsEngine
    }
    if (isAmazonPolly(options.voice)) return amazonPollyTtsEngine;
    if (isGoogleWavenet(options.voice)) return googleWavenetTtsEngine;
    if (isIbmWatson(options.voice)) return ibmWatsonTtsEngine;
    if (isPremiumVoice(options.voice) || isReadAloudCloud(options.voice)) {
      premiumTtsEngine.prepare(options)
      return premiumTtsEngine;
    }
    if (isGoogleNative(options.voice)) return new TimeoutTtsEngine(browserTtsEngine, 3*1000, GOOGLE_NATIVE_END_TIMEOUT);
    return browserTtsEngine;
  }

  //what the voice is given for a segment (js/spoken-text.js), while the page shows the segment as it is.
  //Piper is given the text as it is: it tells where each sentence starts in what it reads (piperState)
  function spokenOf(text) {
    if (engine == piperTtsEngine) return {text, sourceIndex: i => i}
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
        return fitSpoken(new CharBreaker(200, punctuator, null, options.splitParagraphs).breakText(text),
          text => text.length, 200, limit => new CharBreaker(limit, punctuator, null, options.splitParagraphs));
      }
      else if (isPiperVoice(options.voice)) return [text];
      else return new CharBreaker(750, punctuator, 200, options.splitParagraphs).breakText(text);
    }
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
      texts: piperState ? piperState.texts : texts,
      position: {
        index: piperState ? piperState.index : playlist.getIndex()
      },
      isRTL: /^(ar|az|dv|he|iw|ku|fa|ur)\b/.test(options.lang),
      isPiper: engine == piperTtsEngine,
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
            const playback$ = playlist.seek(cmd.index, cmd.fromChar)
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
        case "start":
          if (event.sentenceStartIndicies) {
            piperState = {
              texts: event.sentenceStartIndicies.map((startIndex, i, arr) => texts[0].slice(startIndex, arr[i+1])),
              sentenceStartIndicies: event.sentenceStartIndicies,
              index: 0
            }
          } else {
            const nextText = texts[playlist.getIndex() + 1]
            if (nextText && engine.prefetch != null) engine.prefetch(spokenOf(nextText).text, options)
          }
          break
        case "sentence":
          if (piperState) {
            piperState.index = piperState.sentenceStartIndicies.indexOf(event.startIndex)
          }
          break
        case "end":
          if (piperState) {
            cmd$.complete()
          } else if (!movePending) {
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
          return makePlayback(texts[index])
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
          return makePlayback(texts[index])
        }
      },
      rewind() {
        if (index > 0) {
          index--
          return makePlayback(texts[index])
        }
      },
      seek(toIndex, fromChar) {
        if (toIndex >= 0 && toIndex < texts.length) {
          index = toIndex
          return makePlayback(texts[index], fromChar)
        }
      },
      gotoEnd() {
        const toIndex = texts.length - 1
        if (toIndex >= 0) {
          index = toIndex
          return makePlayback(texts[index])
        }
      }
    }
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
    //keepParagraphsApart (reading a selection) reads every line on its own, except that lines this short
    //(spaces not counted) go with the next: they're over before the next segment's audio is made, leaving a gap.
    //Counted in UTF-8 bytes: 20 Korean characters (3 bytes each), or 60 English ones
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
            ? group.spokenBytes > SHORT_LINE_BYTES || group.charCount + charCount > charLimit
            : group.charCount + charCount > (combineThreshold || charLimit);
          if (full) flush();
          group.parts.push(part);
          group.charCount += charCount;
          //a line's closing '.' isn't counted: Speech() adds one to lines without punctuation
          if (keepApart) group.spokenBytes += utf8.encode(part.replace(/\s+/g, "").replace(/\.$/, "")).length;
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
