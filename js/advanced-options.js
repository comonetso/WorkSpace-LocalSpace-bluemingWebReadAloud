Promise.all([getSettings(), domReady()]).then(([settings]) => {
  $("button.close")
    .show()
    .click(() => history.back())

  $("#fix-bt-silence-gap")
    .prop("checked", settings.fixBtSilenceGap)
    .change(function() {
      updateSettings({fixBtSilenceGap: this.checked})
        .catch(console.error)
    })

  // 네이버 클로바 API 설정
  if (settings.clovaCreds) {
    $("#clova-client-id").val(settings.clovaCreds.clientId);
    $("#clova-client-secret").val(settings.clovaCreds.clientSecret);
    $("#clova-api-url").val(settings.clovaCreds.apiUrl);
  }

  $("#save-clova-settings").click(function() {
    const clientId = $("#clova-client-id").val();
    const clientSecret = $("#clova-client-secret").val();
    const apiUrl = $("#clova-api-url").val();

    if (!clientId || !clientSecret) {
      alert("클로바 Client ID와 Client Secret은 필수 입력 항목입니다.");
      return;
    }

    updateSettings({
      clovaCreds: {
        clientId: clientId,
        clientSecret: clientSecret,
        apiUrl: apiUrl || "https://naveropenapi.apigw.ntruss.com/tts-premium/v1"
      }
    })
    .then(() => alert("네이버 클로바 API 설정이 저장되었습니다."))
    .catch(err => {
      console.error(err);
      alert("네이버 클로바 API 설정 저장 중 오류가 발생했습니다.");
    });
  });
})
