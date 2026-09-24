# Read Aloud HRG: A Text to Speech Voice Reader

이 프로젝트는 Read Aloud 확장 프로그램을 기반으로 네이버 클로바 TTS API를 지원하도록 수정한 버전입니다.

## 개발자 모드에서 확장 프로그램 로드하기

이 확장 프로그램을 Chrome에서 개발자 모드로 테스트하려면:

1. Chrome 브라우저를 엽니다.
2. 주소창에 `chrome://extensions/`를 입력하고 엔터를 누릅니다.
3. 오른쪽 상단에 "개발자 모드" 토글 스위치를 활성화합니다.
4. "압축해제된 확장 프로그램을 로드합니다" 버튼을 클릭합니다.
5. 파일 선택 대화 상자에서 이 프로젝트의 디렉토리를 선택합니다.
6. 확인 버튼을 클릭하면 확장 프로그램이 Chrome에 로드됩니다.

## 네이버 클로바 TTS API 설정하기

1. 확장 프로그램 아이콘을 클릭하고 설정 버튼을 누릅니다.
2. "커스텀 목소리 활성화" 링크를 클릭합니다.
3. "네이버 클로바" 섹션에서 Client ID와 Client Secret을 입력합니다.
4. "저장" 버튼을 클릭합니다.

## 클로바 API 인증 정보 획득하기

네이버 클로바 API 인증 정보를 얻으려면:

1. 네이버 클라우드 플랫폼(https://www.ncloud.com/)에 가입합니다.
2. CLOVA Voice 서비스를 활성화합니다.
3. API 게이트웨이를 설정하고 Client ID와 Client Secret을 발급받습니다.

## 지원되는 네이버 클로바 음성

이 확장 프로그램은 다음과 같은 네이버 클로바 음성을 지원합니다:

- Clova 미진 (여성, 한국어)
- Clova 지민 (여성, 한국어)
- Clova 준영 (남성, 한국어)
- Clova 민상 (남성, 한국어)
- Clova 벨라 (여성, 영어)
- Clova 매트 (남성, 영어)
- Clova 유진 (여성, 일본어)
- Clova 신지 (남성, 일본어)
- Clova 메이메이 (여성, 중국어)
- Clova 시엔시엔 (남성, 중국어)

## 단축키

```
ALT + P           : 재생/일시정지
ALT + O           : 정지
ALT + 쉼표(,)      : 되감기
ALT + 마침표(.)     : 앞으로 감기
```

<div align="center">
	<img src="img/icon.png" width="128" height="128">
	<br>
	<img src="docs/images/logo-text-trans.png" width="391" height="66">
	<br>
	A <b>Text to Speech Voice Reader</b> extension for your browser!
</div>

<div align="center">
	<a href="https://chrome.google.com/webstore/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp">Chrome Web Store</a> | <a href="https://addons.mozilla.org/en-US/firefox/addon/read-aloud/">Firefox Addon</a> | <a href="https://blog.readaloud.app/">Blog</a> | <a href="https://readaloud.app/">Website</a>
</div>

<br>

<div align="center">
    <br> github stats:
    <img src="https://badgen.net/github/stars/ken107/read-aloud" >
    <img src="https://badgen.net/github/open-issues/ken107/read-aloud" >
    <img src="https://badgen.net/github/open-prs/ken107/read-aloud" >
    <img src="https://badgen.net/github/tag/ken107/read-aloud" >
    <img src="https://badgen.net/github/license/ken107/read-aloud/" >
    <br> chrome web store stats:
    <img src="https://badgen.net/chrome-web-store/users/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/rating/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/rating-count/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <img src="https://badgen.net/chrome-web-store/v/hdhinadidafjejdhmfkjgnolgimiaplp" >
    <br> firefox addon stats:
    <img src="https://badgen.net/amo/users/read-aloud" >
    <img src="https://badgen.net/amo/rating/read-aloud" >
    <img src="https://badgen.net/amo/reviews/read-aloud" >
    <img src="https://badgen.net/amo/v/read-aloud" >
</div>

<br>

<div align="center">
	<sub>A little browser extension built with ❤︎ by <a href="https://github.com/ken107">Hai Phan</a> and <a href="https://github.com/ken107/read-aloud/graphs/contributors">contributors</a> </sub>
</div>

<hr />

## 원본 프로젝트

이 프로젝트는 [Read Aloud](https://github.com/ken107/read-aloud) 확장 프로그램을 기반으로 만들어졌습니다.

## 기본 사용법

### 확장 프로그램 버튼
<img src="docs/images/demo-extension-button.gif">

### 오른쪽 클릭 메뉴
<img src="docs/images/demo-right-click.gif">


## Advanced Usage

### Shortcuts

```yaml
ALT/Option + P           : Play/Pause
ALT/Option + O           : Stop
ALT/Option + Comma       : Rewind
ALT/Option + Period      : Forward
```

### Customization

You can change the voice, reading speed, pitch, or enable text highlighting:

1. Click the Read Aloud icon on the [Extensions menu](https://i.imgur.com/KTqFZ3Q.png).
2. Stop any text that may be playing.
3. Click on the Gear icon in the Read Aloud context menu. (It may take a second or two for settings to appear)


### Using Premium Voices
[Using Premium Voices (Google Wavenet & Amazon Polly)](docs/usage/premium-voices.md)


## Installation

### Chrome and Chromium-based browsers
You can get the latest available Read Aloud Extension version from the [Chrome Web Store](https://chrome.google.com/webstore/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp).

### Firefox
You can get the latest version of Read Aloud Extension from the [Mozilla Add-ons website](https://addons.mozilla.org/en-US/firefox/addon/read-aloud/).

#### Firefox install from source

1. Create a build directory with `mkdir build`
2. Run `npm run-script package`
3. Extract the resulting zip file. You should see a `manifest.json` which will be used later.
4. In Firefox, first make sure there isn't an existing read-aloud add-on already installed
5. type `about:debugging` in the Address bar and enter.
6. Click on "This Firefox" then click "Load Unpackaged Extension"
7. Select the `manifest.json` file produced earlier.

## Contribute

- Star this GitHub repo :star:
- Post about it on your social media (Twitter / Blogs / Facebook / Instagram etc).
- Leave a positive review on the [Chrome Web Store](https://chrome.google.com/webstore/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp) or [Firefox Addon](https://addons.mozilla.org/en-US/firefox/addon/read-aloud/) pages.
- Create pull requests, submit bugs, suggest new features or documentation updates 🛠
	- To do so, go to [this page](https://github.com/ken107/read-aloud/issues) and click the *New issue* button.


## Credits

### Images

 - [Streamline Labs](https://lab.streamlineicons.com/)
 - [Freepik](https://www.freepik.com/free-vector/colorful-memphis-design-background-vector_3893585.htm)
