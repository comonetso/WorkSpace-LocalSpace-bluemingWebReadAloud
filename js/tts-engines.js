var browserTtsEngine = brapi.tts ? new BrowserTtsEngine() : (typeof speechSynthesis != 'undefined' ? new WebSpeechEngine() : new DummyTtsEngine());
var googleTranslateTtsEngine = new GoogleTranslateTtsEngine();
var amazonPollyTtsEngine = new AmazonPollyTtsEngine();
var googleWavenetTtsEngine = new GoogleWavenetTtsEngine();
var ibmWatsonTtsEngine = new IbmWatsonTtsEngine();
var openaiTtsEngine = new OpenaiTtsEngine();
var naverClovaTtsEngine = new NaverClovaTtsEngine(); // 네이버 클로바 TTS 엔진 추가
var azureTtsEngine = new AzureTtsEngine();


/*
interface Options {
  voice: {
    voiceName: string
  }
  lang: string
  rate?: number
  pitch?: number
  volume?: number
}

interface Event {
  type: string
}

interface Voice {
  voiceName: string
  lang: string
}

interface TtsEngine {
  speak: function(text: string, opts: Options, playbackState$: Observable<"paused"|"resumed">): Observable<TtsEvent>
  getVoices: function(): Voice[]
}
*/

function BrowserTtsEngine() {
  brapi.tts.stop()    //workaround: chrome.tts.speak doesn't work first time on cold start for some reason
  this.speak = function(text, options, onEvent) {
    brapi.tts.speak(text, {
      voiceName: options.voice.voiceId || options.voice.voiceName,
      lang: options.lang,
      rate: options.rate,
      pitch: options.pitch,
      volume: options.volume,
      requiredEventTypes: ["start", "end"],
      desiredEventTypes: ["start", "end", "error", "word"],
      onEvent: onEvent
    })
  }
  this.stop = brapi.tts.stop;
  this.pause = brapi.tts.pause;
  this.resume = brapi.tts.resume;
  this.isSpeaking = brapi.tts.isSpeaking;
  this.getVoices = async function() {
    const voices = await new Promise(f => brapi.tts.getVoices(f)) || []
    const platform = await brapi.runtime.getPlatformInfo()
    if (platform.os == "mac") {
      for (const voice of voices) {
          if (voice.remote == false && !voice.voiceName.includes(" ")) {
            voice.voiceId = voice.voiceName
            voice.voiceName = "MacOS " + (languageTable.getNameFromCode(voice.lang) || voice.lang) + " [" + voice.voiceId + "]"
          }
      }
    }
    return voices
  }
}


function WebSpeechEngine() {
  var utter;
  this.speak = function(text, options, onEvent) {
    utter = new SpeechSynthesisUtterance();
    utter.text = text;
    utter.voice = options.voice;
    if (options.lang) utter.lang = options.lang;
    if (options.pitch) utter.pitch = options.pitch;
    if (options.rate) utter.rate = options.rate;
    if (options.volume) utter.volume = options.volume;
    utter.onstart = onEvent.bind(null, {type: 'start', charIndex: 0});
    utter.onend = onEvent.bind(null, {type: 'end', charIndex: text.length});
    utter.onboundary = function(event) {
      if (event.name == "word") onEvent({type: 'word', charIndex: event.charIndex, length: event.charLength});
    };
    utter.onerror = function(event) {
      if (event.error == "canceled" || event.error == "interrupted") return;
      onEvent({type: 'error', error: new Error(event.error)});
    };
    speechSynthesis.cancel()
    speechSynthesis.speak(utter);
  }
  this.stop = function() {
    if (utter) utter.onend = null;
    speechSynthesis.cancel();
  }
  this.pause = function() {
    speechSynthesis.pause();
  }
  this.resume = function() {
    speechSynthesis.resume();
  }
  this.isSpeaking = function(callback) {
    callback(speechSynthesis.speaking);
  }
  this.getVoices = function() {
    return promiseTimeout(1500, "Timeout WebSpeech getVoices", new Promise(function(fulfill) {
      var voices = speechSynthesis.getVoices() || [];
      if (voices.length) fulfill(voices);
      else speechSynthesis.onvoiceschanged = function() {
        fulfill(speechSynthesis.getVoices() || []);
      }
    }))
    .then(function(voices) {
      for (var i=0; i<voices.length; i++) voices[i].voiceName = voices[i].name;
      return voices;
    })
    .catch(function(err) {
      console.error(err);
      return [];
    })
  }
}


function DummyTtsEngine() {
  this.getVoices = function() {
    return Promise.resolve([]);
  }
}


function TimeoutTtsEngine(baseEngine, startTimeout, endTimeout) {
  let speakSub
  //the end timeout suits the chunk size, which was cut for the rate at the time; see Speech.setParams()
  this.setEndTimeout = millis => endTimeout = millis
  this.speak = function(text, options, onEvent) {
    speakSub = new rxjs.Observable(observer => {
      baseEngine.speak(text, options, event => observer.next(event))
    }).pipe(
      rxjs.timeout({
        first: startTimeout,
        with() {
          console.debug(`No 'start' event after ${startTimeout}, will call stop() and retry once`)
          baseEngine.stop()
          //shown on the options page's voice test (and the popup): in the browser's language
          return rxjs.throwError(() => new Error(brapi.i18n.getMessage("error_tts_not_started")))
        }
      }),
      rxjs.retry(1),
      rxjs.mergeMap(event =>
        rxjs.iif(
          () => event.type == "start",
          rxjs.timer(endTimeout).pipe(
            rxjs.map(() => {
              console.debug(`No 'end' event after ${endTimeout}, will call stop() and generate 'end'`)
              baseEngine.stop()
              return {type: "end", charIndex: text.length}
            }),
            rxjs.startWith(event)
          ),
          rxjs.of(event)
        )
      ),
      rxjs.catchError(error => rxjs.of({type: "error", error})),
      rxjs.takeWhile(event => event.type != "end" && event.type != "error", true)
    ).subscribe(onEvent)
  }
  this.stop = function() {
    if (speakSub) speakSub.unsubscribe()
    baseEngine.stop();
  }
  this.isSpeaking = baseEngine.isSpeaking;
}


function GoogleTranslateTtsEngine() {
  var prefetchAudio;
  this.ready = function() {
    return googleTranslateReady();
  };
  this.speak = function(utterance, options, playbackState$) {
    options.rateAdjust = 1.1
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.voice.lang);
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.voice.lang)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.getVoices = function() {
    return voices;
  }
  function getAudioUrl(text, lang) {
    assert(text && lang);
    return googleTranslateSynthesizeSpeech(text, lang);
  }
  var voices = [
      {"voice_name": "GoogleTranslate Afrikaans", "lang": "af", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Albanian", "lang": "sq", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Arabic", "lang": "ar", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Armenian", "lang": "hy", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bengali", "lang": "bn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bosnian", "lang": "bs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Bulgarian", "lang": "bg", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Catalan", "lang": "ca", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Chinese", "lang": "zh-CN", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Croatian", "lang": "hr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Czech", "lang": "cs", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Danish", "lang": "da", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Dutch", "lang": "nl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate English", "lang": "en", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Esperanto", "lang": "eo", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Estonian", "lang": "et", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Filipino", "lang": "fil", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Finnish", "lang": "fi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate French", "lang": "fr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate German", "lang": "de", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Greek", "lang": "el", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Gujarati", "lang": "gu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hebrew", "lang": "he", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hindi", "lang": "hi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Hungarian", "lang": "hu", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Icelandic", "lang": "is", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Indonesian", "lang": "id", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Italian", "lang": "it", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Japanese", "lang": "ja", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Javanese", "lang": "jw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Kannada", "lang": "kn", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Khmer", "lang": "km", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Korean", "lang": "ko", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latin", "lang": "la", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Latvian", "lang": "lv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Macedonian", "lang": "mk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malay", "lang": "ms", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Malayalam", "lang": "ml", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Marathi", "lang": "mr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Myanmar (Burmese)", "lang": "my", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Nepali", "lang": "ne", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Norwegian", "lang": "no", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Polish", "lang": "pl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Portuguese", "lang": "pt", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Romanian", "lang": "ro", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Russian", "lang": "ru", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Serbian", "lang": "sr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sinhala", "lang": "si", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Slovak", "lang": "sk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Spanish", "lang": "es", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Sundanese", "lang": "su", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swahili", "lang": "sw", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Swedish", "lang": "sv", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tagalog", "lang": "tl", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Tamil", "lang": "ta", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Telugu", "lang": "te", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Thai", "lang": "th", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Turkish", "lang": "tr", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Ukrainian", "lang": "uk", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Urdu", "lang": "ur", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Vietnamese", "lang": "vi", "event_types": ["start", "end", "error"]},
      {"voice_name": "GoogleTranslate Welsh", "lang": "cy", "event_types": ["start", "end", "error"]}
    ]
    .map(function(item) {
      return {voiceName: item.voice_name, lang: item.lang};
    })
}


function AmazonPollyTtsEngine() {
  var getPolly = lazy(createPolly)
  var prefetchAudio;
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(function() {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2];
        else return getAudioUrl(utterance, options.lang, options.voice, options.pitch);
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = function(utterance, options) {
    getAudioUrl(utterance, options.lang, options.voice, options.pitch)
      .then(function(url) {
        prefetchAudio = [utterance, options, url];
      })
      .catch(console.error)
  };
  this.getVoices = async function() {
    try {
      const {awsCreds, pollyVoices} = await getSettings(["awsCreds", "pollyVoices"])
      if (!awsCreds) return []
      if (pollyVoices && pollyVoices.expire > Date.now()) return pollyVoices.list
      const list = await fetchVoices()
      await updateSettings({pollyVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  async function fetchVoices() {
    const polly = await getPolly()
    const data = await polly.describeVoices().promise()
    const voices = []
    for (const voice of data.Voices) {
      assert(voice.SupportedEngines && voice.Id)
      if (voice.SupportedEngines.includes("standard")) voices.push(voice);
      if (voice.SupportedEngines.includes("neural")) voices.push({...voice, Style: "neural"})
      if (polly.newscasterVoices.includes(voice.Id)) voices.push({...voice, Style: "newscaster"})
      if (polly.conversationalVoices.includes(voice.Id)) voices.push({...voice, Style: "conversational"})
    }
    return voices.map(voice => {
      assert(voice.Gender)
      let voiceName = `AmazonPolly ${voice.LanguageName} (${voice.Id})`;
      if (voice.Style) voiceName += ` +${voice.Style}`;
      return {
        voiceName,
        lang: voice.LanguageCode,
        gender: voice.Gender.toLowerCase(),
      }
    })
  }
  async function getAudioUrl(text, lang, voice, pitch) {
    assert(text && lang && voice);
    var matches = voice.voiceName.match(/^AmazonPolly .* \((\w+)\)( \+\w+)?$/);
    var voiceId = matches[1];
    var style = matches[2] && matches[2].substr(2);
    const polly = await getPolly()
    const blob = await polly.synthesizeSpeech(getOpts(text, voiceId, style)).promise()
    return URL.createObjectURL(blob);
  }
  function createPolly() {
    return getSettings(["awsCreds"])
      .then(function(items) {
        if (!items.awsCreds) throw new Error("Missing AWS credentials");
        return new AWS.Polly({
          region: "us-east-1",
          accessKeyId: items.awsCreds.accessKeyId,
          secretAccessKey: items.awsCreds.secretAccessKey
        })
      })
  }
  function getOpts(text, voiceId, style) {
    switch (style) {
      case "newscaster":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="news">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "conversational":
        return {
          OutputFormat: "mp3",
          Text: '<speak><amazon:domain name="conversational">' + escapeXml(text) + '</amazon:domain></speak>',
          TextType: "ssml",
          VoiceId: voiceId,
          Engine: "neural"
        }
      case "neural":
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId,
          Engine: "neural"
        }
      default:
        return {
          OutputFormat: "mp3",
          Text: text,
          VoiceId: voiceId
        }
    }
  }
}


function GoogleWavenetTtsEngine() {
  //audio made ahead, newest first: the next segment, and the current one when a new pitch makes it again
  //(Speech.prepareSegment) — two, so neither pushes the other out
  var prefetched = [];
  var prefetchSeq = 0;
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(function() {
        const hit = prefetched.find(e => e.utterance == utterance && e.options == options)
        return hit ? hit.url : getAudioUrl(utterance, options.voice, options.pitch);
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  //resolves true once speak() can use the audio, false if it couldn't be made
  this.prefetch = function(utterance, options) {
    if (prefetched.some(e => e.utterance == utterance && e.options == options)) return Promise.resolve(true)
    const seq = ++prefetchSeq
    return getAudioUrl(utterance, options.voice, options.pitch)
      .then(function(url) {
        //an earlier request for the same text finishing late doesn't replace a newer one
        const same = prefetched.find(e => e.utterance == utterance)
        if (same && same.seq > seq) return false
        prefetched = [{utterance, options, url, seq}].concat(prefetched.filter(e => e.utterance != utterance)).slice(0, 2)
        return true
      })
      .catch(function(err) {
        console.error(err)
        return false
      })
  };
  this.getVoices = function() {
    return getSettings(["wavenetVoices", "gcpCreds"])
      .then(function(items) {
        var creds = items.gcpCreds;
        //the list comes from Google with the API key; without one, the stored list (or the one below) is used
        if (creds && creds.apiKey && (!items.wavenetVoices || Date.now()-items.wavenetVoices[0].ts > 24*3600*1000)) updateVoices(creds.apiKey);
        var listvoices = items.wavenetVoices || voices;
        return listvoices.filter(
          function(voice) {
            // include all voices or exclude only studio voices.
            return ((creds && creds.enableStudio) || !isGoogleStudio(voice));
          });
      })
  }
  this.getFreeVoices = function() {
    return this.getVoices()
      .then(function(items) {
        return items.filter(function(item) {
          return item.voiceName.match(/^GoogleStandard /);
        })
      })
  }
  //Google's voice list (voices.list, with the API key synthesis uses), under the names these voices have always had here:
  //saved settings (voiceName, preferredVoices) hold them, so they must come out the same.
  //"ko-KR-Chirp3-HD-Zephyr" -> "GoogleChirp3-HD Korean (Zephyr)", "ko-KR-Standard-A" (female) -> "GoogleStandard Korean (Anna)"
  function updateVoices(apiKey) {
    ajaxGet({url: "https://texttospeech.googleapis.com/v1/voices?key=" + encodeURIComponent(apiKey), responseType: "json"})
      .then(function(data) {
        var list = makeVoiceList(data.voices || []);
        if (!list.length) throw new Error("No voices in Google's voice list");
        list[0].ts = Date.now();
        return updateSettings({wavenetVoices: list});
      })
      .catch(console.error)
  }
  //by language, each in Google's order: where two languages give the same voice name (es-ES/es-US, nl-BE/nl-NL),
  //the first one is the voice found by that name (findVoiceByName)
  function makeVoiceList(items) {
    return items
      .map(function(item) {
        var matches = /^([a-z]{2,3}-[A-Z]{2})-(\S+)-(\w+)$/.exec(item.name);
        if (!matches) return null;
        var lang = matches[1], voiceType = matches[2], speakerId = matches[3];
        //getAudioUrl() takes the speaker back from the name: all of it for Chirp 3 HD, the first letter for the others
        if (voiceType != "Chirp3-HD" && speakerId.length != 1) return null;
        var gender = String(item.ssmlGender || "").toLowerCase();
        var speaker = voiceType == "Chirp3-HD" ? speakerId : (speakerNames[speakerId] || {})[gender] || speakerId;
        var langName = langNames[lang] || langNames[lang.split("-")[0]] || lang;
        var voice = {voiceName: "Google" + voiceType + " " + langName + " (" + speaker + ")", lang: lang, gender: gender};
        return isGoogleWavenet(voice) ? voice : null;
      })
      .filter(Boolean)
      .sort(function(a, b) {return a.lang < b.lang ? -1 : a.lang > b.lang ? 1 : 0})
  }
  //the names voice names have used for Google's one-letter speakers, by letter and gender
  var speakerNames = {
    A: {female: "Anna", male: "Adam"},
    B: {female: "Bianca", male: "Benjamin"},
    C: {female: "Carol", male: "Christopher"},
    D: {female: "Diane", male: "Daniel"},
    E: {female: "Elise", male: "Ethan"},
    F: {female: "Francesca", male: "Fernando"},
    G: {female: "Grace", male: "George"},
    H: {female: "Helena", male: "Harvey"},
    I: {female: "Isabel", male: "Ian"},
    J: {male: "James"},
    K: {female: "Kim", male: "Kyle"},
    L: {female: "Liz", male: "Louis"},
    M: {male: "Mark"},
    N: {female: "Natalie", male: "Nick"},
    O: {female: "Olivia", male: "Oliver"},
    Q: {male: "Quinn"},
  }
  //the language names voice names have used, by language (or language-region where it differs); others show the code
  var langNames = {
    "af": "Afrikaans", "am": "Amharic", "ar": "Arabic", "bg": "Bulgarian", "bn": "Bengali", "ca": "Catalan; Valencian",
    "cmn-CN": "Mandarin", "cs": "Czech", "da": "Danish", "de": "German", "el": "Greek, Modern",
    "en-AU": "Australian English", "en-GB": "British English", "en-IN": "Indian English", "en-US": "US English",
    "es": "Spanish; Castilian", "et": "Estonian", "eu": "Basque", "fi": "Finnish", "fil": "Filipino",
    "fr": "French", "fr-CA": "Canadian French", "gl": "Galician", "gu": "Gujarati", "he": "Hebrew (modern)", "hi": "Hindi",
    "hr": "Croatian", "hu": "Hungarian", "id": "Indonesian", "is": "Icelandic", "it": "Italian", "ja": "Japanese",
    "kn": "Kannada", "ko": "Korean", "lt": "Lithuanian", "lv": "Latvian", "ml": "Malayalam", "mr": "Marathi (Marāṭhī)",
    "ms": "Malay", "nb": "Norwegian Bokmål", "nl": "Dutch", "pa": "Panjabi, Punjabi", "pl": "Polish",
    "pt": "Portuguese", "pt-BR": "Brazilian Portuguese", "ro": "Romanian, Moldavian, Moldovan", "ru": "Russian",
    "sk": "Slovak", "sl": "Slovene", "sr": "Serbian", "sv": "Swedish", "sw": "Swahili", "ta": "Tamil", "te": "Telugu",
    "th": "Thai", "tr": "Turkish", "uk": "Ukrainian", "ur": "Urdu", "vi": "Vietnamese",
  }
  function getAudioUrl(text, voice, pitch) {
    assert(text && voice);
    var matches = voice.voiceName.match(/^Google(\S+) .* \((\w+)\)$/);
    const voiceType = matches[1];
    const speakerId = voiceType == "Chirp3-HD" ? matches[2] : matches[2][0];
    var endpoint = matches[1] == "Neural2" ? "us-central1-texttospeech.googleapis.com" : "texttospeech.googleapis.com";
    return getSettings(["gcpCreds", "gcpToken"])
      .then(function(settings) {
        function synthesize(input) {
          var postData = {
            input: input,
            voice: {
              languageCode: voice.lang,
              name: voice.lang + "-" + voiceType + "-" + speakerId
            },
            audioConfig: {
              audioEncoding: "OGG_OPUS",
            }
          }
          if (!voiceType.startsWith("Chirp")) postData.audioConfig.pitch = ((pitch || 1) -1) *20;
          if (settings.gcpCreds) return ajaxPost("https://" + endpoint + "/v1/text:synthesize?key=" + settings.gcpCreds.apiKey, postData, "json");
          if (!settings.gcpToken) throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
          return ajaxPost("https://cxl-services.appspot.com/proxy?url=https://texttospeech.googleapis.com/v1beta1/text:synthesize&token=" + settings.gcpToken, postData, "json")
            .catch(function(err) {
              console.error(err);
              throw new Error(JSON.stringify({code: "error_wavenet_auth_required"}));
            })
        }
        const markup = pausesMarkup(text, voice, voiceType)
        //if the pauses are refused, it's read without them rather than not at all
        return markup ? synthesize({markup: markup}).catch(function(err) {
          console.error(err);
          return synthesize({text: text});
        }) : synthesize({text: text});
      })
      .then(function(responseText) {
        var data = JSON.parse(responseText);
        return "data:audio/ogg;codecs=opus;base64," + data.audioContent;
      })
  }
  //Korean Chirp 3 HD voices hardly pause at a comma (0.29s: less than between two clauses without one), so a short
  //pause is asked for after each comma of a sentence ("[pause short]" in markup: 0.41s, chosen by ear 2026-09-26).
  //Nor much at an arrow, made a full stop and an em space by js/spoken-text.js (0.25-0.5s after short words, like
  //the comma's): a pause is asked for there ("[pause]": 0.75-0.9s, chosen by ear 2026-09-27).
  //The text's own brackets become parentheses, so that none is taken for a tag. Null where it doesn't apply
  function pausesMarkup(text, voice, voiceType) {
    if (voiceType != "Chirp3-HD" || !/^ko/i.test(voice.lang) || !/,\s| /.test(text)) return null;
    return text.replace(/\[/g, "(").replace(/\]/g, ")").replace(/,(?=\s)/g, ", [pause short]").replace(/ /g, " [pause] ");
  }
  var voices = [
    {"voiceName":"GoogleStandard Spanish; Castilian (Anna)","lang":"es-ES","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Anna)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard Arabic (Benjamin)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Christopher)","lang":"ar-XA","gender":"male"},
    {"voiceName":"GoogleStandard Arabic (Diane)","lang":"ar-XA","gender":"female"},
    {"voiceName":"GoogleStandard French (Elizabeth)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Anna)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Elizabeth)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Anna)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Benjamin)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Russian (Caroline)","lang":"ru-RU","gender":"female"},
    {"voiceName":"GoogleStandard Russian (Daniel)","lang":"ru-RU","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Diane)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Anna)","lang":"cmn-CN","gender":"female"},
    {"voiceName":"GoogleStandard Mandarin (Benjamin)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Mandarin (Christopher)","lang":"cmn-CN","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Anna)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Bianca)","lang":"ko-KR","gender":"female"},
    {"voiceName":"GoogleStandard Korean (Christopher)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Korean (Daniel)","lang":"ko-KR","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Anna)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Bianca)","lang":"ja-JP","gender":"female"},
    {"voiceName":"GoogleStandard Japanese (Christopher)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Japanese (Daniel)","lang":"ja-JP","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Anna)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Benjamin)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Vietnamese (Caroline)","lang":"vi-VN","gender":"female"},
    {"voiceName":"GoogleStandard Vietnamese (Daniel)","lang":"vi-VN","gender":"male"},
    {"voiceName":"GoogleStandard Filipino (Anna)","lang":"fil-PH","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Anna)","lang":"id-ID","gender":"female"},
    {"voiceName":"GoogleStandard Indonesian (Benjamin)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Indonesian (Christopher)","lang":"id-ID","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Anna)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Benjamin)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Christopher)","lang":"nl-NL","gender":"male"},
    {"voiceName":"GoogleStandard Dutch (Diane)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Dutch (Elizabeth)","lang":"nl-NL","gender":"female"},
    {"voiceName":"GoogleStandard Czech (Anna)","lang":"cs-CZ","gender":"female"},
    {"voiceName":"GoogleStandard Greek, Modern (Anna)","lang":"el-GR","gender":"female"},
    {"voiceName":"GoogleStandard Brazilian Portuguese (Anna)","lang":"pt-BR","gender":"female"},
    {"voiceName":"GoogleStandard Hungarian (Anna)","lang":"hu-HU","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Elizabeth)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Anna)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Polish (Benjamin)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Christopher)","lang":"pl-PL","gender":"male"},
    {"voiceName":"GoogleStandard Polish (Diane)","lang":"pl-PL","gender":"female"},
    {"voiceName":"GoogleStandard Slovak (Anna)","lang":"sk-SK","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Anna)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Benjamin)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Turkish (Caroline)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Diane)","lang":"tr-TR","gender":"female"},
    {"voiceName":"GoogleStandard Turkish (Ethan)","lang":"tr-TR","gender":"male"},
    {"voiceName":"GoogleStandard Ukrainian (Anna)","lang":"uk-UA","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Anna)","lang":"en-IN","gender":"female"},
    {"voiceName":"GoogleStandard Indian English (Benjamin)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Indian English (Christopher)","lang":"en-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Anna)","lang":"hi-IN","gender":"female"},
    {"voiceName":"GoogleStandard Hindi (Benjamin)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Hindi (Christopher)","lang":"hi-IN","gender":"male"},
    {"voiceName":"GoogleStandard Danish (Anna)","lang":"da-DK","gender":"female"},
    {"voiceName":"GoogleStandard Finnish (Anna)","lang":"fi-FI","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Anna)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Portuguese (Benjamin)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Christopher)","lang":"pt-PT","gender":"male"},
    {"voiceName":"GoogleStandard Portuguese (Diane)","lang":"pt-PT","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Elizabeth)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Anna)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Benjamin)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Caroline)","lang":"nb-NO","gender":"female"},
    {"voiceName":"GoogleStandard Norwegian Bokmål (Daniel)","lang":"nb-NO","gender":"male"},
    {"voiceName":"GoogleStandard Swedish (Anna)","lang":"sv-SE","gender":"female"},
    {"voiceName":"GoogleStandard British English (Anna)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Benjamin)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard British English (Caroline)","lang":"en-GB","gender":"female"},
    {"voiceName":"GoogleStandard British English (Daniel)","lang":"en-GB","gender":"male"},
    {"voiceName":"GoogleStandard US English (Benjamin)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Caroline)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard US English (Daniel)","lang":"en-US","gender":"male"},
    {"voiceName":"GoogleStandard US English (Elizabeth)","lang":"en-US","gender":"female"},
    {"voiceName":"GoogleStandard German (Anna)","lang":"de-DE","gender":"female"},
    {"voiceName":"GoogleStandard German (Benjamin)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard German (Ethan)","lang":"de-DE","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Anna)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Benjamin)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Australian English (Caroline)","lang":"en-AU","gender":"female"},
    {"voiceName":"GoogleStandard Australian English (Daniel)","lang":"en-AU","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Anna)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Benjamin)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard Canadian French (Caroline)","lang":"fr-CA","gender":"female"},
    {"voiceName":"GoogleStandard Canadian French (Daniel)","lang":"fr-CA","gender":"male"},
    {"voiceName":"GoogleStandard French (Anna)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Benjamin)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard French (Caroline)","lang":"fr-FR","gender":"female"},
    {"voiceName":"GoogleStandard French (Daniel)","lang":"fr-FR","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Bianca)","lang":"it-IT","gender":"female"},
    {"voiceName":"GoogleStandard Italian (Christopher)","lang":"it-IT","gender":"male"},
    {"voiceName":"GoogleStandard Italian (Daniel)","lang":"it-IT","gender":"male"},
  ]
}


function IbmWatsonTtsEngine() {
  var prefetchAudio;
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.voice)
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.voice)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  };
  this.getVoices = function() {
    return getSettings(["watsonVoices", "ibmCreds"])
      .then(function(items) {
        if (!items.ibmCreds) return [];
        if (items.watsonVoices && Date.now()-items.watsonVoices[0].ts < 24*3600*1000) return items.watsonVoices;
        return fetchVoices(items.ibmCreds.apiKey, items.ibmCreds.url)
          .then(function(list) {
            list[0].ts = Date.now();
            updateSettings({watsonVoices: list}).catch(console.error);
            return list;
          })
          .catch(function(err) {
            console.error(err);
            return [];
          })
      })
  }
  this.fetchVoices = fetchVoices;

  function getAudioUrl(text, voice) {
    assert(text && voice);
    var matches = voice.voiceName.match(/^IBM-Watson .* \((\w+)\)$/);
    var voiceName = voice.lang + "_" + matches[1] + "Voice";
    return getSettings(["ibmCreds"])
      .then(function(settings) {
        return ajaxGet({
          url: settings.ibmCreds.url + "/v1/synthesize?text=" + encodeURIComponent(escapeHtml(text)) + "&voice=" + encodeURIComponent(voiceName) + "&accept=" + encodeURIComponent("audio/ogg;codecs=opus"),
          headers: {
            Authorization: "Basic " + btoa("apikey:" + settings.ibmCreds.apiKey)
          },
          responseType: "blob"
        })
      })
      .then(function(blob) {
        return URL.createObjectURL(blob);
      })
  }
  function fetchVoices(apiKey, url) {
    return ajaxGet({
        url: url + "/v1/voices",
        headers: {
          Authorization: "Basic " + btoa("apikey:" + apiKey)
        }
      })
      .then(JSON.parse)
      .then(function(data) {
        return data.voices.map(item => {
          item.description = item.description.replace(/Chinese \((Mandarin|Cantonese)\)/, "Chinese, $1");
          return {
            voiceName: "IBM-Watson " + item.description.split(/: | male| female| \(/)[1] + " (" + item.name.slice(item.language.length+1, -5) + ")",
            lang: item.language,
            gender: item.gender,
          }
        })
      })
  }
}


function OpenaiTtsEngine() {
  this.defaultEndpointUrl = "https://api.openai.com/v1"
  this.defaultVoiceList = [
    {voice: "alloy", lang: "en-US", model: "tts-1"},
    {voice: "echo", lang: "en-US", model: "tts-1"},
    {voice: "fable", lang: "en-US", model: "tts-1"},
    {voice: "onyx", lang: "en-US", model: "tts-1"},
    {voice: "nova", lang: "en-US", model: "tts-1"},
    {voice: "shimmer", lang: "en-US", model: "tts-1"},
  ]
  var prefetchAudio
  this.test = async function({apiKey, url, voiceList}) {
    const res = await fetch(url + "/models", {
      headers: {"Authorization": "Bearer " + apiKey}
    })
    if (!res.ok) {
      const {error} = await res.json()
      throw error
    }
  }
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.voice, options.pitch)
      })
    return playAudio(urlPromise, options, playbackState$)
  }
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.voice, options.pitch)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  }
  this.getVoices = async function() {
    const openaiCreds = await getSetting("openaiCreds")
    const voiceList = openaiCreds ? (openaiCreds.voiceList || this.defaultVoiceList) : []
    return voiceList.map(({voice, lang}) => ({
      voiceName: "OpenAI " + voice,
      lang
    }))
  }
  async function getAudioUrl(text, voice, pitch) {
    assert(text && voice)
    const {openaiCreds} = await getSettings(["openaiCreds"])
    const voiceId = voice.voiceName.slice(7)
    const voiceInfo = openaiCreds.voiceList.find(x => x.voice == voiceId)
    assert(voiceInfo, "Voice not found " + voiceId)
    const res = await fetch(openaiCreds.url + "/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(
          openaiCreds.apiKey ? {
            "Authorization": "Bearer " + openaiCreds.apiKey
          } : null
        )
      },
      body: JSON.stringify({
        model: voiceInfo.model,
        input: text,
        voice: voiceInfo.voice,
        response_format: "mp3",
      })
    })
    if (!res.ok) throw await res.json().then(x => x.error)
    return URL.createObjectURL(await res.blob())
  }
}


function NaverClovaTtsEngine() {
  //audio made ahead, newest first: the next segment, and the current one when a new pitch makes it again
  //(Speech.prepareSegment) — two, so neither pushes the other out
  var prefetched = [];
  var prefetchSeq = 0;
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(() => {
        const hit = prefetched.find(e => e.utterance == utterance && e.options == options)
        return hit ? hit.url : getAudioUrl(utterance, options.lang, options.voice, options)
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  //resolves true once speak() can use the audio, false if it couldn't be made
  this.prefetch = async function(utterance, options) {
    if (prefetched.some(e => e.utterance == utterance && e.options == options)) return true
    const seq = ++prefetchSeq
    try {
      const url = await getAudioUrl(utterance, options.lang, options.voice, options)
      //an earlier request for the same text finishing late doesn't replace a newer one
      const same = prefetched.find(e => e.utterance == utterance)
      if (same && same.seq > seq) return false
      prefetched = [{utterance, options, url, seq}].concat(prefetched.filter(e => e.utterance != utterance)).slice(0, 2)
      return true
    }
    catch (err) {
      console.error(err)
      return false
    }
  };
  this.getVoices = async function() {
    try {
      const {clovaCreds, clovaVoices} = await getSettings(["clovaCreds", "clovaVoices"]);
      if (!clovaCreds) return []

      // 캐시된 음성 목록이 있고 유효한지 확인
      if (clovaVoices && clovaVoices.expire > Date.now()) {
        console.log("Clova: 캐시된 음성 목록 사용", clovaVoices.list.length);
        return clovaVoices.list;
      }

      console.log("Clova: 새 음성 목록 가져오기");
      const list = await this.fetchVoices(clovaCreds);
      await updateSettings({clovaVoices: {list, expire: Date.now() + 24*3600*1000}});
      console.log("Clova: 음성 목록 업데이트 완료", list.length);
      return list;
    }
    catch (err) {
      console.error("Clova getVoices error:", err);
      return []
    }
  }
  this.fetchVoices = async function(clovaCreds) {
    // 네이버 클로바 음성 목록
    // 실제로는 API에서 음성 목록을 가져와야 하지만, 고정 목록으로 제공
    return [
      {
        voiceName: "Clova 지윤 (여성, 한국어)",
        lang: "ko-KR",
        gender: "female",
        clova_name: "njiyun"
      },
      {
        voiceName: "Clova 아라 (여성, 한국어)",
        lang: "ko-KR",
        gender: "female",
        clova_name: "nara"
      },
      {
        voiceName: "Clova 아라 - 상담원 (여성, 한국어)",
        lang: "ko-KR",
        gender: "female",
        clova_name: "nara_call"
      },
      {
        voiceName: "Clova 고은 (여성, 한국어)",
        lang: "ko-KR",
        gender: "female",
        clova_name: "ngoeun"
      },
      {
        voiceName: "Clova 나오미(뉴스) (여성, 일본어)",
        lang: "ja-JP",
        gender: "female",
        clova_name: "dnaomi_formal"
      },
      {
        voiceName: "Clova 에리코 (여성, 일본어)",
        lang: "ja-JP",
        gender: "female",
        clova_name: "deriko"
      },
      {
        voiceName: "Clova 안나 (여성, 영어)",
        lang: "en-US",
        gender: "female",
        clova_name: "danna"
      },
      {
        voiceName: "Clova 매트 (남성, 영어)",
        lang: "en-US",
        gender: "male",
        clova_name: "matt"
      },
      {
        voiceName: "Clova 메이메이 (여성, 중국어)",
        lang: "zh-CN",
        gender: "female",
        clova_name: "meimei"
      }
    ];
  }
  async function getAudioUrl(text, lang, voice, options) {
    assert(text && lang && voice);
    const {clovaCreds} = await getSettings(["clovaCreds"]);
    if (!clovaCreds) throw new Error("Missing Naver Clova credentials");

    // 클로바 API 호출을 위한 음성 이름 찾기
    const voiceArray = await naverClovaTtsEngine.fetchVoices(clovaCreds);
    const voiceInfo = voiceArray.find(v => v.voiceName === voice.voiceName);

    if (!voiceInfo) throw new Error(`Voice not found: ${voice.voiceName}`);

    // 속도·볼륨은 틀 때(오디오 재생 배속·볼륨, js/defaults.js playAudioHere) 적용한다.
    // 합성은 보통 속도(speed 0)·최대 음량(volume 5 = 1.5배, 예전 기본 볼륨 1.0 의 값)으로 고정해,
    // 재생 바에서 속도·볼륨을 바꿔도 다시 합성하지 않고 그 자리에서 바뀐다 (2026-09-24 사용자 결정)
    const speed = 0;
    const volume = 5;
    let pitch = 0;

    if (options && options.pitch) {
      // pitch 범위: 0.5 ~ 1.5 => 5 ~ -5로 변환 (API: -5 = 1.2배 높게, 5 = 0.8배 낮게)
      pitch = Math.round((1 - options.pitch) * 10);
      // 범위 제한
      pitch = Math.max(-5, Math.min(5, pitch));
    }

    // API URL 확인 - 기본 URL이 /tts로 끝나지 않으면 추가
    let apiUrl = clovaCreds.apiUrl;
    if (!apiUrl) {
      apiUrl = "https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts";
    } else if (!apiUrl.endsWith('/tts')) {
      apiUrl = apiUrl + '/tts';
    }

    console.log('Clova TTS 요청 정보:', {
      speaker: voiceInfo.clova_name,
      speed, volume, pitch,
      apiUrl: apiUrl
    });

    // 네이버 클로바 API 호출용 폼 데이터 생성
    const formData = new URLSearchParams();
    formData.append('speaker', voiceInfo.clova_name);
    formData.append('text', text);
    formData.append('format', 'mp3');
    formData.append('speed', speed);
    formData.append('volume', volume);
    formData.append('pitch', pitch);

    try {
      // 백그라운드 스크립트를 통해 API 호출
      const response = await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          action: "callClovaApi",
          apiUrl: apiUrl,
          clientId: clovaCreds.clientId,
          clientSecret: clovaCreds.clientSecret,
          formData: formData.toString()
        }, response => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }

          if (!response.success) {
            reject(new Error(response.error || "API call failed"));
            return;
          }

          resolve(response);
        });
      });

      // Base64 데이터를 Blob으로 변환
      const base64Data = response.audioData.split(',')[1];
      const binaryData = atob(base64Data);
      const arrayBuffer = new ArrayBuffer(binaryData.length);
      const uint8Array = new Uint8Array(arrayBuffer);

      for (let i = 0; i < binaryData.length; i++) {
        uint8Array[i] = binaryData.charCodeAt(i);
      }

      const blob = new Blob([arrayBuffer], { type: 'audio/mp3' });
      console.log('Clova TTS 응답 받음: Blob 크기', blob.size);
      return URL.createObjectURL(blob);
    } catch (error) {
      console.error('Clova TTS API 호출 중 예외 발생:', error);
      throw error;
    }
  }
}


function AzureTtsEngine() {
  var prefetchAudio;
  this.speak = function(utterance, options, playbackState$) {
    const urlPromise = Promise.resolve()
      .then(() => {
        if (prefetchAudio && prefetchAudio[0] == utterance && prefetchAudio[1] == options) return prefetchAudio[2]
        else return getAudioUrl(utterance, options.lang, options.voice)
      })
    return playAudio(urlPromise, options, playbackState$)
  };
  this.prefetch = async function(utterance, options) {
    try {
      const url = await getAudioUrl(utterance, options.lang, options.voice)
      prefetchAudio = [utterance, options, url]
    }
    catch (err) {
      console.error(err)
    }
  };
  this.getVoices = async function() {
    try {
      const {azureCreds, azureVoices} = await getSettings(["azureCreds", "azureVoices"])
      if (!azureCreds) return []
      if (azureVoices && azureVoices.expire > Date.now()) return azureVoices.list
      const list = await this.fetchVoices(azureCreds.region, azureCreds.key)
      await updateSettings({azureVoices: {list, expire: Date.now() + 24*3600*1000}})
      return list
    }
    catch (err) {
      console.error(err)
      return []
    }
  }
  this.fetchVoices = async function(region, key) {
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {
      method: "GET",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
      }
    })
    //shown on the custom voices page's key check
    if (!res.ok) throw new Error(brapi.i18n.getMessage("error_server_status", [String(res.status)]))
    const voices = await res.json()
    return voices.map(item => {
      const name = item.ShortName.split("-")[2]
      return {
        voiceName: "Azure " + item.LocaleName + " - " + name,
        lang: item.Locale,
        gender: item.Gender == "Male" ? "male" : "female",
      }
    })
  }
  async function getAudioUrl(text, lang, voice) {
    const matches = voice.voiceName.match(/^Azure .* - (\w+)$/)
    const voiceName = voice.lang + "-" + matches[1]
    const {azureCreds} = await getSettings(["azureCreds"])
    const {region, key} = azureCreds
    const res = await fetch(`https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
      method: "POST",
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/ssml+xml",
        "X-Microsoft-OutputFormat": "ogg-48khz-16bit-mono-opus",
      },
      body: `<speak version='1.0' xml:lang='${lang}'><voice name='${voiceName}'>${escapeXml(text)}</voice></speak>`
    })
    if (!res.ok) throw new Error(brapi.i18n.getMessage("error_server_status", [String(res.status)]))
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }
}
