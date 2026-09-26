# Blueming Web Read Aloud

웹페이지나 선택한 글을 소리 내어 읽어 주는 Chrome 확장 프로그램(Manifest V3)입니다.
한국어 읽기에 맞춰 다듬었고, 네이버 클로바 음성을 쓸 수 있습니다.

> 원본 [ken107/read-aloud](https://github.com/ken107/read-aloud)(MIT)을 포크해 시작했습니다.

## 하는 일

- **페이지 읽기** — 확장 아이콘을 누르면 지금 페이지를 읽습니다. 읽고 있는 탭에서 다시 누르면 일시정지·이어 읽기, 다른 탭에서 누르면 그 탭을 새로 읽습니다. 옵션에서 아이콘을 누를 때 팝업이 뜨게 바꿀 수 있습니다.
- **본문만 골라 읽기** — 페이지 전체를 읽을 때 [Mozilla Readability](https://github.com/mozilla/readability)로 본문만 골라 읽습니다(댓글·관련 기사 등 제외). 본문을 찾지 못하면 페이지 글을 기존 방식으로 읽습니다.
- **드래그 선택 읽기** — 글을 드래그해 선택하면 옆에 작은 빨간 점이 뜨고, 누르면 선택한 글을 읽습니다. 오른쪽 클릭 메뉴로도 읽을 수 있습니다. 빨간 점은 옵션에서 끌 수 있습니다.
- **페이지 재생 바** — 읽는 동안 페이지 아래쪽에 재생 바가 뜹니다. 지난 시간·총 시간(추정), 이전·다음 단락, 일시정지·이어 읽기, 음소거, 닫기(정지)가 있고, 설정 버튼에서 속도·피치·볼륨을 바꾸면 읽는 중에 바로 적용됩니다.
- **원문 형광펜** — 지금 읽는 부분을 원문 위에 형광펜으로 표시하고, 읽는 곳이 보이게 따라 스크롤합니다. 단어 위치를 알려 주는 음성(브라우저 내장 음성 등)은 단어 단위, 나머지는 지금 읽는 조각(줄) 단위로 칠합니다.
- **줄 단위 읽기** — 줄마다 따로 합성해 줄 사이에서 쉬어 읽습니다. 아주 짧은 줄은 아래 줄과 합쳐 읽습니다.
- **영어 대문자 단어·파일명을 사람처럼 읽기** (한국어·영어 음성)
  - 전부 대문자인 영어 단어를 철자로 읽지 않고 단어로 읽습니다. 예: `README` → read me, `CHANGELOG` → change log
  - 파일명·경로·코드 이름은 조각별로 읽고 사이 기호를 말합니다. 예: `page-ui-host.js` → page 대시 UI 대시 host 쩜 JS
  - 한국어 음성에서는 숫자의 천 단위 쉼표를 빼고 읽습니다. 예: `2,200` → 2200
- **재생 탭 없이 읽기** — 읽기를 맡는 재생기가 읽는 페이지 안에 보이지 않게 들어가, 따로 재생 탭이 생기지 않습니다. 옵션에서 탭 방식으로 바꿀 수 있고, 페이지에 넣을 수 없는 곳(브라우저 내부 페이지 등)에서는 탭으로 엽니다.

## 음성

| 음성 | 필요한 것 |
|---|---|
| 네이버 클로바 | 네이버 클라우드 플랫폼 CLOVA Voice 의 Client ID·Client Secret |
| 구글 Wavenet·Chirp 등 (Google Cloud Text-to-Speech) | Google Cloud API 키 |
| 구글 번역 음성 | 없음 |
| 브라우저 내장 음성 | 없음 |
| Amazon Polly | AWS 액세스 키 |
| Microsoft Azure | Azure Speech 지역·키 |
| OpenAI (또는 OpenAI 호환 Speech 엔드포인트) | API 키 |
| IBM Watson | API 키·URL |

키가 필요한 음성은 모두 사용자 본인의 계정 키로 각 서비스를 직접 호출합니다.

## 설치

빌드 과정 없이 폴더를 그대로 불러옵니다.

1. 이 저장소를 내려받습니다.
   ```bash
   git clone https://github.com/comonetso/WorkSpace-LocalSpace-bluemingWebReadAloud.git
   ```
2. Chrome 주소창에 `chrome://extensions` 를 엽니다.
3. 오른쪽 위 **개발자 모드**를 켭니다.
4. **압축해제된 확장 프로그램을 로드합니다**를 눌러 내려받은 폴더를 고릅니다.

## 네이버 클로바 키 넣기

1. 확장 아이콘을 오른쪽 클릭해 **옵션**을 엽니다.
2. 음성 목록에서 **Enable Custom Voices** 항목을 고르면 음성 설정(custom-voices) 화면이 열립니다.
3. **Naver Clova** 칸에 Client ID·Client Secret 을 넣고 저장합니다. API URL 은 기본값(`https://naveropenapi.apigw.ntruss.com/tts-premium/v1`)을 그대로 두면 됩니다.
4. 옵션 화면의 음성 목록에서 `Clova` 로 시작하는 음성을 고릅니다.

클로바 키는 [네이버 클라우드 플랫폼](https://www.ncloud.com/)에서 CLOVA Voice 서비스를 신청하고 애플리케이션을 등록하면 받을 수 있습니다.
다른 음성(구글 Cloud·AWS·Azure·OpenAI·IBM)의 키도 같은 음성 설정 화면에서 넣습니다.

## 단축키

| 키 | 동작 |
|---|---|
| `Alt+P` | 읽기·일시정지 |
| `Alt+O` | 정지 |
| `Alt+,` | 되감기 |
| `Alt+.` | 앞으로 감기 |

단축키는 `chrome://extensions/shortcuts` 에서 바꿀 수 있습니다.

## 라이선스

[MIT](LICENSE)

함께 들어 있는 외부 라이브러리(Mozilla Readability, jQuery, RxJS 등)와 영어 단어 목록(SCOWL)은 각자의 라이선스를 따릅니다.
