$(function() {
  setI18nText();
  getSettings(["awsCreds", "gcpCreds", "ibmCreds", "azureCreds", "clovaCreds"])
    .then(function(items) {
      if (items.awsCreds) {
        $("#aws-access-key-id").val(obfuscate(items.awsCreds.accessKeyId));
        $("#aws-secret-access-key").val(obfuscate(items.awsCreds.secretAccessKey));
      }
      if (items.gcpCreds) {
        $("#gcp-api-key").val(obfuscate(items.gcpCreds.apiKey));
        $("#gcp-enable-studio").prop('checked', items.gcpCreds.enableStudio);
      }
      if (items.ibmCreds) {
        $("#ibm-api-key").val(obfuscate(items.ibmCreds.apiKey));
        $("#ibm-url").val(obfuscate(items.ibmCreds.url));
      }
      if (items.azureCreds) {
        $("#azure-region").val(items.azureCreds.region)
        $("#azure-key").val(obfuscate(items.azureCreds.key))
      }
      if (items.clovaCreds) {
        $("#clova-client-id").val(obfuscate(items.clovaCreds.clientId))
        $("#clova-client-secret").val(obfuscate(items.clovaCreds.clientSecret))
        $("#clova-api-url").val(items.clovaCreds.apiUrl)
      }
    })
  $(".status").hide();
  $("#aws-save-button").click(awsSave);
  $("#gcp-save-button").click(gcpSave);
  $("#ibm-save-button").click(ibmSave);
  $("#azure-save-button").click(azureSave);
  $("#clova-save-button").click(clovaSave)
})

function obfuscate(key) {
  return key.replace(/./g, function(m, i) {
    return i < key.length-5 ? "*" : m;
  })
}

//status lines — engine names are brand names and stay as they are
function enabledText(engine) {
  return getMessage("customvoices_enabled", [engine]);
}

function disabledText(engine) {
  return getMessage("customvoices_disabled", [engine]);
}

//the error from the test (often the service's own message) goes after the translated prefix
function testFailedText(err) {
  return getMessage("customvoices_test_failed", [String(err.message)]);
}

function missingFieldsText() {
  return getMessage("customvoices_missing_fields");
}


function awsSave() {
  $(".status").hide();
  var accessKeyId = $("#aws-access-key-id").val().trim();
  var secretAccessKey = $("#aws-secret-access-key").val().trim();
  if (accessKeyId && secretAccessKey) {
    $("#aws-progress").show();
    testAws(accessKeyId, secretAccessKey)
      .then(function() {
        $("#aws-progress").hide();
        updateSettings({awsCreds: {accessKeyId: accessKeyId, secretAccessKey: secretAccessKey}});
        $("#aws-success").text(enabledText("Amazon Polly")).show();
        $("#aws-access-key-id").val(obfuscate(accessKeyId));
        $("#aws-secret-access-key").val(obfuscate(secretAccessKey));
      },
      function(err) {
        $("#aws-progress").hide();
        $("#aws-error").text(testFailedText(err)).show();
      })
  }
  else if (!accessKeyId && !secretAccessKey) {
    clearSettings(["awsCreds"])
      .then(function() {
        $("#aws-success").text(disabledText("Amazon Polly")).show();
      })
  }
  else {
    $("#aws-error").text(missingFieldsText()).show();
  }
}

function testAws(accessKeyId, secretAccessKey) {
      var polly = new AWS.Polly({
        region: "us-east-1",
        accessKeyId: accessKeyId,
        secretAccessKey: secretAccessKey
      })
      return polly.describeVoices().promise();
}


function gcpSave() {
  $(".status").hide();
  var apiKey = $("#gcp-api-key").val().trim();
  var enableStudio = $("#gcp-enable-studio").is(':checked');
  if (apiKey) {
    $("#gcp-progress").show();
    testGcp(apiKey)
      .then(function() {
        $("#gcp-progress").hide();
        updateSettings({gcpCreds: {apiKey: apiKey, enableStudio: enableStudio}});
        if (enableStudio) {
          $("#gcp-success").text(enabledText("Google Wavenet & Studio")).show();
        } else {
          $("#gcp-success").text(enabledText("Google Wavenet")).show();
        }
        $("#gcp-api-key").val(obfuscate(apiKey));
      },
      function(err) {
        $("#gcp-progress").hide();
        $("#gcp-error").text(testFailedText(err)).show();
      })
  }
  else {
    clearSettings(["gcpCreds"])
      .then(function() {
        $("#gcp-success").text(disabledText("Google Wavenet")).show();
      })
  }
}

function testGcp(apiKey) {
      return ajaxGet("https://texttospeech.googleapis.com/v1beta1/voices?key=" + apiKey);
}


function ibmSave() {
  $(".status").hide();
  var apiKey = $("#ibm-api-key").val().trim();
  var url = $("#ibm-url").val().trim();
  if (apiKey && url) {
    $("#ibm-progress").show();
    testIbm(apiKey, url)
      .then(function() {
        $("#ibm-progress").hide();
        updateSettings({ibmCreds: {apiKey: apiKey, url: url}});
        $("#ibm-success").text(enabledText("IBM Watson")).show();
        $("#ibm-api-key").val(obfuscate(apiKey));
        $("#ibm-url").val(obfuscate(url));
      },
      function(err) {
        $("#ibm-progress").hide();
        $("#ibm-error").text(testFailedText(err)).show();
      })
  }
  else if (!apiKey && !url) {
    clearSettings(["ibmCreds"])
      .then(function() {
        $("#ibm-success").text(disabledText("IBM Watson")).show();
      })
  }
  else {
    $("#ibm-error").text(missingFieldsText()).show();
  }
}

function testIbm(apiKey, url) {
  return brapi.permissions.request({origins: [url + "/*"]})
    .then(function(granted) {
      if (!granted) throw new Error(getMessage("customvoices_error_permission"));
    })
    .then(function() {
      return ibmWatsonTtsEngine.fetchVoices(apiKey, url);
    })
}


async function azureSave() {
  $(".status").hide()
  const region = $("#azure-region").val().trim()
  const key = $("#azure-key").val().trim()
  if (region && key) {
    $("#azure-progress").show()
    try {
      await testAzure(region, key)
      await updateSettings({azureCreds: {region, key}})
      $("#azure-success").text(enabledText("Azure")).show()
      $("#azure-key").val(obfuscate(key))
    }
    catch (err) {
      $("#azure-error").text(testFailedText(err)).show()
    }
    finally {
      $("#azure-progress").hide()
    }
  }
  else if (!region && !key) {
    await clearSettings(["azureCreds"])
    $("#azure-success").text(disabledText("Azure")).show()
  }
  else {
    $("#azure-error").text(missingFieldsText()).show()
  }
}

async function testAzure(region, key) {
  await azureTtsEngine.fetchVoices(region, key)
}


async function clovaSave() {
  $(".status").hide()
  const clientId = $("#clova-client-id").val().trim()
  const clientSecret = $("#clova-client-secret").val().trim()
  const apiUrl = $("#clova-api-url").val().trim()

  if (clientId && clientSecret) {
    $("#clova-progress").show()
    try {
      await testClova(clientId, clientSecret, apiUrl)
      await updateSettings({clovaCreds: {clientId, clientSecret, apiUrl}})
      $("#clova-success").text(enabledText("Naver Clova")).show()
      $("#clova-client-id").val(obfuscate(clientId))
      $("#clova-client-secret").val(obfuscate(clientSecret))
    }
    catch (err) {
      $("#clova-error").text(testFailedText(err)).show()
    }
    finally {
      $("#clova-progress").hide()
    }
  }
  else if (!clientId && !clientSecret) {
    await clearSettings(["clovaCreds"])
    $("#clova-success").text(disabledText("Naver Clova")).show()
  }
  else {
    $("#clova-error").text(missingFieldsText()).show()
  }
}

async function testClova(clientId, clientSecret, apiUrl) {
  // 파라미터 확인
  if (!apiUrl) throw new Error(getMessage("customvoices_error_invalid_url"))
  if (!clientId || !clientSecret) throw new Error(missingFieldsText())

  // API URL이 /tts로 끝나지 않으면 추가
  let testUrl = apiUrl;
  if (!testUrl.endsWith('/tts')) {
    testUrl = testUrl + '/tts';
  }

  // 실제 API 호출로 테스트
  try {
    const formData = new URLSearchParams();
    formData.append('speaker', 'njiyun');
    formData.append('text', '안녕하세요');
    formData.append('format', 'mp3');
    formData.append('speed', 0);
    formData.append('volume', 0);
    formData.append('pitch', 0);

    console.log('테스트 URL:', testUrl);

    const res = await fetch(testUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-NCP-APIGW-API-KEY-ID": clientId,
        "X-NCP-APIGW-API-KEY": clientSecret
      },
      body: formData
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      throw new Error(getMessage("customvoices_error_api", [String(res.status), errorText]));
    }

    // 응답 확인 (blob 타입이어야 함)
    await res.blob();

    // 인증 정보와 함께 음성 목록 반환
    return naverClovaTtsEngine.fetchVoices({clientId, clientSecret, apiUrl});
  } catch (err) {
    console.error('Clova API 테스트 오류:', err);
    throw err;
  }
}



//OpenAI
$(function() {
  const creds$ = observeSetting("openaiCreds")
  const editMode$ = new rxjs.BehaviorSubject(false)
  const status$ = new rxjs.BehaviorSubject({type: "IDLE"})

  rxjs.combineLatest(creds$, editMode$).subscribe(([creds, editMode]) => {
    $(".openai .view-new").toggle(creds == null && !editMode)
    $(".openai .view-exist").toggle(creds != null && !editMode)
    $(".openai .view-edit").toggle(editMode)
  })

  creds$.subscribe(creds => {
    const endpointUrl = creds && creds.url || openaiTtsEngine.defaultEndpointUrl
    const apiKey = creds && creds.apiKey || ""
    const voiceList = creds && creds.voiceList || openaiTtsEngine.defaultVoiceList
    $(".openai .endpoint-url").text(endpointUrl)
    $(".openai .api-key").text(apiKey && (apiKey.slice(0,13) + "*****" + apiKey.slice(-5)))
    $(".openai .voice-list").text(voiceList.map(x => x.voice).join(", "))
    $(".openai .txt-endpoint-url").val(endpointUrl)
    $(".openai .txt-api-key").val(apiKey)
    $(".openai .txt-voice-list").val(JSON.stringify(voiceList, null, 2))
  })

  status$.subscribe(status => {
    $(".openai .status.progress").toggle(status.type == "PROGRESS")
    $(".openai .status.success").toggle(status.type == "SUCCESS")
      .text(status.type == "SUCCESS" ? enabledText("OpenAI") : "")
    $(".openai .status.error").toggle(status.type == "ERROR")
      .text(status.type == "ERROR" ? status.error.message : "")
  })

  //actions
  $(".openai .btn-add").click(() => {
    status$.next({type: "IDLE"})
    editMode$.next(true)
  })
  $(".openai .btn-edit").click(() => {
    status$.next({type: "IDLE"})
    editMode$.next(true)
  })
  $(".openai .btn-delete").click(() => {
    clearSettings(["openaiCreds"])
    status$.next({type: "IDLE"})
    editMode$.next(false)
  })
  $(".openai .btn-save").click(async () => {
    try {
      const openaiCreds = {
        url: $(".openai .txt-endpoint-url").val(),
        apiKey: $(".openai .txt-api-key").val(),
        voiceList: JSON.parse($(".openai .txt-voice-list").val())
      }
      status$.next({type: "PROGRESS"})
      await openaiTtsEngine.test(openaiCreds)
      await updateSettings({openaiCreds})
      editMode$.next(false)
      //the success line sits in the saved view, like the other engines' "voices are enabled"
      status$.next({type: "SUCCESS"})
    } catch (err) {
      status$.next({type: "ERROR", error: err})
    }
  })
  $(".openai .btn-cancel").click(() => {
    editMode$.next(false)
  })
})
