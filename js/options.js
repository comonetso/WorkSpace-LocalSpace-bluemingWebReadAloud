(function () {
  const queryString = getQueryString()
  const domReadyPromise = domReady()


  //i18n
  domReadyPromise
    .then(setI18nText)

  //the browser's options dialog takes this page's height in whole pixels, so a page a fraction of a pixel taller
  //(fonts and em sizes: 565.26px) got a scroll bar: its height is rounded up, again whenever it changes
  domReadyPromise
    .then(() => {
      const content = document.querySelector(".container-fluid")
      new ResizeObserver(() => {
        document.body.style.minHeight = Math.ceil(content.getBoundingClientRect().height) + "px"
      }).observe(content)
    })



  //close button
  domReadyPromise
    .then(() => {
      if (queryString.referer) {
        $("button.close").show()
          .click(function () {
            history.back();
          })
      }
    })



  //voice
  domReadyPromise
    .then(() => {
      $("#voices")
        .change(function () {
          var voiceName = $(this).val();
          if (voiceName == "@custom") brapi.tabs.create({ url: "custom-voices.html" });
          else if (voiceName == "@languages") brapi.tabs.create({ url: "languages.html" });
          else updateSettings({ voiceName })
        });
      $("#languages-edit-button")
        .click(function () {
          brapi.tabs.create({ url: "languages.html" });
        })
    })

  const voicesPopulatedObservable = rxjs.combineLatest([
    voices$,
    observeSetting("languages"),
    brapi.i18n.getAcceptLanguages().catch(err => { console.error(err); return [] }),
    //the words of the language chosen in the options are loaded first (js/defaults.js getMessage)
    domReadyPromise.then(() => uiLanguageReady)
  ]).pipe(
    rxjs.tap(([voices, languages, acceptLangs]) => populateVoices(voices, { languages }, acceptLangs)),
    rxjs.share()
  )

  rxjs.combineLatest([observeSetting("voiceName"), voicesPopulatedObservable])
    .subscribe(([voiceName]) => {
      $("#voices").val(voiceName || "")
    })

  rxjs.combineLatest(
    observeSetting("voiceName"),
    observeSetting("gcpCreds"),
    domReadyPromise
  ).subscribe(([voiceName, gcpCreds]) => {
    $("#voice-info").toggle(!!voiceName && isGoogleWavenet({ voiceName }) && !gcpCreds)
  })



  //rate: picked on the page bar from a list (js/page-ui.js); only the list's step is picked here (2026-10-24,
  //the slider and the typed value removed). A new step moves the speed onto the new steps right away
  //(1.25 every 0.25 is 1.3 every 0.1); a reading going on takes the new list and speed now (js/page-ui-host.js
  //onSpeedStep)
  domReadyPromise
    .then(() => {
      $("#rate-step")
        .append(Object.keys(speedLists).map(step => $("<option>").val(step).text(step)))
        .change(async function () {
          await updateSettings({ speedStep: Number($(this).val()) })
          const { voiceName } = await getSettings(["voiceName"])
          await getListedRate(voiceName)
        })
    })

  rxjs.combineLatest([observeSetting("speedStep"), domReadyPromise])
    .subscribe(([step]) => $("#rate-step").val(String(speedStepOf(step))))

  //the reading keys (2026-10-28, js/defaults.js readingKeyList): under a button, so the page keeps its height (the
  //browser's options dialog is barely tall enough). A key box waits for the keys pressed and saves them; Esc leaves
  //it as it was, and a key another reading key uses isn't saved
  const readingKeyNames = {
    "read-pause": "options_reading_key_pause", "read-prev": "options_reading_key_prev", "read-next": "options_reading_key_next",
    "read-slower": "options_reading_key_slower", "read-faster": "options_reading_key_faster",
  }
  let readingKeysSaved, waitingKey = null, keySavedAt = 0
  const readingKeysListed = domReadyPromise.then(() => uiLanguageReady).then(() => {
    $("#reading-keys-button").click(() => $("#reading-keys").toggleClass("open"))
    const list = $("#reading-keys-list")
    for (const {id} of readingKeyList) {
      list.append($("<span>").text(getMessage(readingKeyNames[id])),
        $("<div>").append($("<button type='button' class='btn btn-sm btn-light key-button'>").attr("data-key", id)))
    }
    list.on("click", ".key-button", function() {
      //the Space or Enter just taken as a key also clicks the box: not waiting again
      if (Date.now() - keySavedAt < 500) return
      waitingKey = $(this).attr("data-key")
      $("#reading-keys-status").text("")
      showReadingKeys()
    })
    list.on("keydown", ".key-button", function(event) {
      if (waitingKey != $(this).attr("data-key")) return
      const e = event.originalEvent
      event.preventDefault()
      event.stopPropagation()
      if (e.isComposing) return
      if (e.key == "Escape" && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) return stopWaiting()
      const combo = comboOfKey(e)
      if (!combo) return
      const combos = {...readingKeyCombos(readingKeysSaved), [waitingKey]: combo}
      const conflict = readingKeyConflict(combos)
      keySavedAt = Date.now()
      if (conflict) {
        //said in the key box itself, for a while: the line under the boxes may be out of view in the options dialog
        const other = conflict[0] == waitingKey ? conflict[1] : conflict[0]
        const said = getMessage("options_reading_key_conflict", [getMessage(readingKeyNames[other])])
        const box = $(this)
        $("#reading-keys-status").text(said)
        waitingKey = null
        box.removeClass("waiting").addClass("refused").text(said)
        setTimeout(() => { box.removeClass("refused"); showReadingKeys() }, 2500)
        return
      }
      waitingKey = null
      updateSettings({ readingKeys: combos }).then(showConfirmation)
    })
    list.on("blur", ".key-button", () => stopWaiting())
  })

  rxjs.combineLatest([observeSetting("readingKeys"), readingKeysListed])
    .subscribe(([saved]) => {
      readingKeysSaved = saved
      showReadingKeys()
    })

  function showReadingKeys() {
    const combos = readingKeyCombos(readingKeysSaved)
    $("#reading-keys-list .key-button").each(function() {
      const id = $(this).attr("data-key")
      $(this).toggleClass("waiting", id == waitingKey)
        .text(id == waitingKey ? getMessage("options_reading_key_waiting") : formatCombo(combos[id]))
    })
  }

  function stopWaiting() {
    if (waitingKey == null) return
    waitingKey = null
    showReadingKeys()
  }

  //one speed for all voices (js/defaults.js getListedRate)
  rxjs.combineLatest([observeSetting("voiceName"), observeSetting("rate"), domReadyPromise])
    .subscribe(([voiceName, rate]) => {
      $("#rate-warning").toggle((!voiceName || isNativeVoice({ voiceName })) && rate > 2)
    })



  //pitch
  const pitchSliderPromise = domReadyPromise
    .then(() => {
      return createSlider($("#pitch").get(0), {
        onChange(value) {
          updateSettings({ pitch: value })
        }
      })
    })

  rxjs.combineLatest([observeSetting("pitch"), pitchSliderPromise])
    .subscribe(([pitch, slider]) => slider.setValue(pitch || defaults.pitch))



  //volume
  const volumeSliderPromise = domReadyPromise
    .then(() => {
      return createSlider($("#volume").get(0), {
        onChange(value) {
          updateSettings({ volume: value })
        }
      })
    })

  rxjs.combineLatest([observeSetting("volume"), volumeSliderPromise])
    .subscribe(([volume, slider]) => slider.setValue(volume || defaults.volume))



  //showHighlighting
  domReadyPromise
    .then(() => {
      $("#show-highlighting")
        .change(function () {
          updateSettings({ showHighlighting: $(this).val() })
        })
    })

  rxjs.combineLatest([observeSetting("showHighlighting"), domReadyPromise])
    .subscribe(([showHighlighting]) => $("#show-highlighting").val(showHighlighting || defaults.showHighlighting))



  //audioPlayback: inside the page unless the tab was chosen (useEmbeddedPlayer false). Shown to those playing
  //inside the page, so they can go back to the tab; the tab offers the way back itself ("hide this tab")
  Promise.all([brapi.storage.local.get(["useEmbeddedPlayer"]), domReadyPromise])
    .then(([settings]) => {
      $("#audio-playback")
        .change(function () {
          updateSettings({ useEmbeddedPlayer: JSON.parse($(this).val()) })
          brapi.runtime.sendMessage({ dest: "player", method: "close" })
            .catch(err => "OK")
        })
      $(".audio-playback-visible").toggle(settings.useEmbeddedPlayer !== false)
    })

  rxjs.combineLatest([observeSetting("useEmbeddedPlayer"), domReadyPromise])
    .subscribe(([useEmbeddedPlayer]) => {
      $("#audio-playback").val(useEmbeddedPlayer !== false ? "true" : "false")
    })



  //selectionButton: red dot next to selected text (js/selection-button.js), on unless turned off here.
  //It runs on every page: turning it on asks again for access to all sites in case the browser's extension
  //settings limited it. The service worker registers it (syncSelectionButton)
  domReadyPromise
    .then(() => {
      $("#selection-button")
        .change(async function () {
          const on = $(this).val() == "true"
          if (on && !await brapi.permissions.request({ origins: config.selectionButtonOrigins }).catch(() => false)) {
            $(this).val("false")
            return
          }
          updateSettings({ selectionButton: on })
        })
    })

  rxjs.combineLatest([observeSetting("selectionButton"), domReadyPromise])
    .subscribe(([selectionButton]) => {
      $("#selection-button").val(selectionButton !== false ? "true" : "false")
    })



  //iconOpensPopup: the toolbar icon opens the popup instead of reading the page directly.
  //Off by default (2026-09-26 user decision); the service worker applies it (syncIconPopup)
  domReadyPromise
    .then(() => {
      $("#icon-popup")
        .change(function () {
          updateSettings({ iconOpensPopup: $(this).val() == "true" })
        })
    })

  rxjs.combineLatest([observeSetting("iconOpensPopup"), domReadyPromise])
    .subscribe(([iconOpensPopup]) => {
      $("#icon-popup").val(iconOpensPopup === true ? "true" : "false")
    })



  //uiLanguage: the language of the extension's pages, "en" / "ko", none for the browser's (getMessage in
  //js/defaults.js; asked for 2026-09-28). This page is drawn again in it, whichever page or the reset changed it
  domReadyPromise
    .then(() => {
      $("#ui-language")
        .change(function () {
          const lang = $(this).val()
          const saved = lang ? updateSettings({ uiLanguage: lang }) : clearSettings(["uiLanguage"])
          saved.catch(console.error)
        })
    })

  rxjs.combineLatest([observeSetting("uiLanguage"), domReadyPromise])
    .subscribe(([uiLanguage]) => {
      $("#ui-language").val(uiLanguage == "en" || uiLanguage == "ko" ? uiLanguage : "")
    })

  brapi.storage.onChanged.addListener(changes => {
    if (changes.uiLanguage) location.reload()
  })



  //fixBtSilenceGap: plays a silent track so a Bluetooth headset doesn't cut the first words of each
  //paragraph (js/content.js). Moved here from the old advanced options page, same setting
  domReadyPromise
    .then(() => {
      $("#fix-bt-silence-gap")
        .change(function () {
          updateSettings({ fixBtSilenceGap: this.checked })
            .catch(console.error)
        })
    })

  rxjs.combineLatest([observeSetting("fixBtSilenceGap"), domReadyPromise])
    .subscribe(([fixBtSilenceGap]) => {
      $("#fix-bt-silence-gap").prop("checked", !!fixBtSilenceGap)
    })



  //buttons
  //sample sentence for the test button, by language (English for the others)
  const demoSpeechText = {
    ko: "안녕하세요. 선택한 음성으로 읽어 드리는 예시 문장입니다.",
    en: "Hello. This is a sample sentence read with the selected voice.",
    ja: "こんにちは。選択した音声で読み上げる例文です。",
    zh: "你好。这是用所选语音朗读的示例句子。",
    es: "Hola. Esta es una frase de ejemplo leída con la voz seleccionada.",
  }

  domReadyPromise
    .then(() => {
      const statusTracker$ = new rxjs.Subject()
      statusTracker$.pipe(
        rxjs.switchMap(() =>
          rxjs.interval(500).pipe(
            rxjs.exhaustMap(() => bgPageInvoke("getPlaybackState")),
            rxjs.takeWhile(({ state }) => state != "STOPPED", true)
          )
        )
      ).subscribe(({ playbackError }) => {
        if (playbackError) handleError(playbackError)
      })

      $("#test-voice")
        .click(async function () {
          try {
            var voiceName = $("#voices").val();
            var voice = voiceName && findVoiceByName(await rxjs.firstValueFrom(voices$), voiceName);
            var lang = (voice && voice.lang || "en-US").split("-")[0];
            $("#test-voice .spinner").show();
            $("#status").parent().hide();
            await bgPageInvoke("playText", [demoSpeechText[lang] || demoSpeechText.en, { lang: lang }])
            statusTracker$.next()
          }
          catch (err) {
            handleError(err);
          }
          finally {
            $("#test-voice .spinner").hide();
          }
        })
      $("#test-voice .spinner").hide();
      $("#reset")
        .click(function () {
          clearSettings()
        });
    })



  //status
  domReadyPromise
    .then(() => {
      $("#status").parent().hide()
    })

  settingsChange$
    .subscribe(() => {
      showConfirmation()
      bgPageInvoke("stop").catch(err => "OK")
    })





  function populateVoices(allVoices, settings, acceptLangs) {
    $("#voices").empty()
    $("<option>")
      .val("")
      .text(getMessage("options_voice_auto_select"))
      .appendTo("#voices")

    //get voices filtered by selected languages
    var selectedLangs = immediate(() => {
      if (settings.languages) return settings.languages.split(',')
      if (settings.languages == '') return null
      const accept = new Set(acceptLangs.map(x => x.split('-', 1)[0]))
      const langs = Object.keys(groupVoicesByLang(allVoices)).filter(x => accept.has(x))
      return langs.length ? langs : null
    })
    var voices = !selectedLangs ? allVoices : allVoices.filter(
      function (voice) {
        return !voice.lang || selectedLangs.includes(voice.lang.split('-', 1)[0])
          || isOpenai(voice)
      });

    //group by offline/standard
    var groups = Object.assign({
      offline: [],
      standard: [],
    },
      voices.groupBy(function (voice) {
        if (isOfflineVoice(voice)) return "offline"
        return "standard"
      }))
    for (var name in groups) groups[name].sort(voiceSorter);

    //create the offline optgroup
    const offline = $("<optgroup>")
      .attr("label", getMessage("options_voicegroup_offline"))
      .appendTo($("#voices"))
    for (const voice of groups.offline) {
      $("<option>")
        .val(voice.voiceName)
        .text(voice.voiceName)
        .appendTo(offline)
    }

    //create the standard optgroup (every voice that isn't offline: online, free or paid)
    $("<optgroup>").appendTo($("#voices"))
    var standard = $("<optgroup>")
      .attr("label", getMessage("options_voicegroup_standard"))
      .appendTo($("#voices"));
    groups.standard.forEach(function (voice) {
      //the voice's name is its saved value (voiceName), so only the gender mark after it is translated
      var displayName = voice.voiceName
      if (voice.lang === "ko-KR" && voice.gender) {
        displayName = voice.voiceName + " (" + getMessage(voice.gender === "female" ? "options_voice_female" : "options_voice_male") + ")"
      }
      $("<option>")
        .val(voice.voiceName)
        .text(displayName)
        .appendTo(standard);
    });

    //create the additional optgroup
    $("<optgroup>").appendTo($("#voices"));
    var additional = $("<optgroup>")
      .attr("label", getMessage("options_voicegroup_additional"))
      .appendTo($("#voices"));
    $("<option>")
      .val("@languages")
      .text(getMessage("options_add_more_languages"))
      .appendTo(additional)
    $("<option>")
      .val("@custom")
      .text(getMessage("options_enable_custom_voices"))
      .appendTo(additional)
  }

  function voiceSorter(a, b) {
    function getWeight(voice) {
      var weight = 0
      var name = voice.voiceName || ""
      var lang = voice.lang || ""

      // 1. 클로바 한국어 최상단
      if (name.startsWith("Clova") && lang === "ko-KR") {
        weight -= 20000
        if (voice.gender === "female") weight -= 10
      }
      // 2. 클로바 기타 언어
      else if (name.startsWith("Clova")) {
        weight -= 15000
        if (voice.gender === "female") weight -= 10
      }
      // 3. 구글 한국어 (Neural2 > Wavenet > Standard)
      else if (lang === "ko-KR") {
        weight -= 10000
        if (name.includes("Neural2")) weight -= 300
        else if (name.includes("Wavenet")) weight -= 200
        else if (name.includes("Standard")) weight -= 100
        if (voice.gender === "female") weight -= 10
      }

      // 기존 로직 유지
      if (!isNativeVoice(voice)) weight += 5
      return weight
    }
    return getWeight(a) - getWeight(b) || a.voiceName.localeCompare(b.voiceName)
  }



  function showConfirmation() {
    $(".green-check").finish().show().delay(500).fadeOut();
  }

  function handleError(err) {
    if (/^{/.test(err.message)) {
      var errInfo = JSON.parse(err.message);
      $("#status").html(formatError(errInfo)).parent().show();
      $("#status a").click(function () {
        switch ($(this).attr("href")) {
          case "#auth-wavenet":
            brapi.permissions.request(config.wavenetPerms)
              .then(function (granted) {
                if (granted) bgPageInvoke("authWavenet");
              })
            break;
        }
      })
    }
    else {
      $("#status").text(err.message).parent().show();
    }
  }

  function createSlider(elem, { onChange, onSlideChange }) {
    var min = $(elem).data("min") || 0;
    var max = $(elem).data("max") || 1;
    var step = 1 / ($(elem).data("steps") || 20);
    var $bg = $(elem).empty().toggleClass("slider", true);
    var $bar = $("<div class='bar'>").appendTo(elem);
    var $track = $("<div class='track'>").appendTo(elem);
    var $knob = $("<div class='knob'>").appendTo($track);

    $bg.click(function (e) {
      var pos = calcPosition(e);
      setPosition(pos);
      onChange(min + pos * (max - min));
    })
    $knob.click(function () {
      return false;
    })
    $knob.on("mousedown touchstart", function () {
      onSlideStart(function (e) {
        var pos = calcPosition(e);
        setPosition(pos);
        if (onSlideChange) onSlideChange(min + pos * (max - min));
      },
        function (e) {
          var pos = calcPosition(e);
          setPosition(pos);
          onChange(min + pos * (max - min));
        })
      return false;
    })
    return {
      setValue(value) {
        setPosition((Math.min(value, max) - min) / (max - min))
      }
    }

    function setPosition(pos) {
      var percent = (100 * pos) + "%";
      $knob.css("left", percent);
      $bar.css("width", percent);
    }
    function calcPosition(e) {
      var rect = $track.get(0).getBoundingClientRect();
      var position = (e.clientX - rect.left) / rect.width;
      position = Math.min(1, Math.max(position, 0));
      return step * Math.round(position / step);
    }
  }

  function onSlideStart(onSlideMove, onSlideStop) {
    $(document).on("mousemove", onSlideMove);
    $(document).on("mouseup mouseleave", onStop);
    $(document).on("touchmove", onTouchMove);
    $(document).on("touchend touchcancel", onTouchEnd);

    function onTouchMove(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onSlideMove(e);
      return false;
    }
    function onTouchEnd(e) {
      e.clientX = e.originalEvent.changedTouches[0].clientX;
      e.clientY = e.originalEvent.changedTouches[0].clientY;
      onStop(e);
      return false;
    }
    function onStop(e) {
      $(document).off("mousemove", onSlideMove);
      $(document).off("mouseup mouseleave", onStop);
      $(document).off("touchmove", onTouchMove);
      $(document).off("touchend touchcancel", onTouchEnd);
      if (onSlideStop) onSlideStop(e);
      return false;
    }
  }

  //clear Clova voice cache when loading options page
  domReadyPromise
    .then(() => {
      // 클로바 음성 목록 캐시 초기화
      console.log("Options page: Clearing Clova voice cache...");
      brapi.storage.local.remove("clovaVoices");
    });
})();
