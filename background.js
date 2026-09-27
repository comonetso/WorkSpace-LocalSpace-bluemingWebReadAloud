try {
  importScripts(
    "js/rxjs.umd.min.js",
    "js/defaults.js",
    "js/messaging.js",
    "js/content-handlers.js",
    "js/events.js"
  )
}
catch (err) {
  console.error(err)
}

// 네이버 클로바 API 호출을 위한 프록시 함수
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "callClovaApi") {
    (async () => {
      try {
        console.log('Clova API 호출 요청:', request);

        // URL 확인 및 수정
        let apiUrl = request.apiUrl;
        if (!apiUrl.endsWith('/tts')) {
          console.log(`API URL 수정: ${apiUrl} -> ${apiUrl + '/tts'}`);
          apiUrl = apiUrl + '/tts';
        }

        // API 호출 세부 정보 로깅
        console.log('API URL:', apiUrl);
        console.log('Client ID:', request.clientId?.substring(0, 4) + '...' + request.clientId?.substring(request.clientId.length-4));
        console.log('Client Secret:', request.clientSecret?.substring(0, 4) + '...' + request.clientSecret?.substring(request.clientSecret.length-4));
        console.log('폼 데이터:', request.formData);

        // 요청 헤더
        const headers = {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-NCP-APIGW-API-KEY-ID": request.clientId,
          "X-NCP-APIGW-API-KEY": request.clientSecret
        };
        console.log('요청 헤더:', headers);

        // API 호출
        console.log('API 호출 시작...');
        const startTime = Date.now();

        const res = await fetch(apiUrl, {
          method: "POST",
          headers: headers,
          body: request.formData
        });

        console.log(`API 호출 완료: ${Date.now() - startTime}ms 소요`);
        console.log('응답 상태:', res.status, res.statusText);
        console.log('응답 헤더:', Array.from(res.headers.entries()));

        // 응답 처리
        if (!res.ok) {
          const errorText = await res.text().catch(() => "");
          console.error('Clova API 오류 응답:', res.status, errorText);

          // 오류 응답 확인
          let errorDetails = errorText;
          try {
            // JSON 응답인지 확인
            const jsonError = JSON.parse(errorText);
            errorDetails = JSON.stringify(jsonError, null, 2);
          } catch (e) {
            // JSON이 아닌 경우 원래 텍스트 사용
          }

          // 옵션 페이지 음성 테스트(와 팝업)에 뜨는 문구라 브라우저 언어로
          sendResponse({ success: false, error: chrome.i18n.getMessage("error_clova_api", [String(res.status), errorDetails]) });
          return;
        }

        // Blob을 Base64로 변환
        const blob = await res.blob();
        console.log('응답 Blob 타입:', blob.type);
        console.log('응답 Blob 크기:', blob.size, 'bytes');

        const reader = new FileReader();
        reader.readAsDataURL(blob);
        reader.onloadend = function() {
          const base64data = reader.result;
          console.log('Base64 데이터 변환 완료 (길이):', base64data?.length);
          sendResponse({ success: true, audioData: base64data });
        };
      } catch (err) {
        console.error('Clova API 호출 예외:', err);
        console.error('오류 스택:', err.stack);
        sendResponse({ success: false, error: err.message });
      }
    })();

    // 비동기 응답을 위해 true 반환
    return true;
  }
});
