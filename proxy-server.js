// 네이버 클로바 API 프록시 서버
// 이 파일을 저장하고 node proxy-server.js로 실행하세요

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 8001;

// CORS 활성화
app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// 정적 파일 제공
app.use(express.static(path.join(__dirname)));

// 클로바 TTS API 프록시 엔드포인트
app.post('/proxy/clova-tts', async (req, res) => {
  const {
    text,
    speaker = 'mijin',
    format = 'mp3',
    speed = 0,
    volume = 0,
    pitch = 0,
    clientId,
    clientSecret
  } = req.body;

  console.log('프록시 요청 받음:', {
    text: text.substring(0, 30) + (text.length > 30 ? '...' : ''),
    speaker, format, speed, volume, pitch
  });

  if (!text) {
    return res.status(400).json({ error: '텍스트가 필요합니다' });
  }

  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: '인증 정보가 필요합니다' });
  }

  try {
    // FormData 생성
    const params = new URLSearchParams();
    params.append('speaker', speaker);
    params.append('text', text);
    params.append('format', format);
    params.append('speed', speed);
    params.append('volume', volume);
    params.append('pitch', pitch);

    console.log('네이버 API 요청 준비:', params.toString());

    // 네이버 API 호출
    const response = await axios({
      method: 'post',
      url: 'https://naveropenapi.apigw.ntruss.com/tts-premium/v1/tts',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-NCP-APIGW-API-KEY-ID': clientId,
        'X-NCP-APIGW-API-KEY': clientSecret
      },
      data: params,
      responseType: 'arraybuffer'
    });

    console.log('네이버 API 응답 성공:', response.status, response.headers);

    // 헤더 설정 및 응답 전송
    res.set('Content-Type', 'audio/mpeg');
    res.send(Buffer.from(response.data));

  } catch (error) {
    console.error('프록시 오류:', error.message);

    // 오류 응답 확인
    if (error.response) {
      console.error('API 응답 오류:', {
        status: error.response.status,
        headers: error.response.headers,
        data: error.response.data.toString()
      });

      res.status(error.response.status).json({
        error: '네이버 API 오류',
        details: error.response.data.toString()
      });
    } else if (error.request) {
      console.error('응답 수신 실패:', error.request);
      res.status(500).json({ error: '네이버 API 응답 없음' });
    } else {
      console.error('요청 설정 오류:', error.message);
      res.status(500).json({ error: error.message });
    }
  }
});

// 프록시 테스트용 HTML 페이지
app.get('/proxy-test', (req, res) => {
  res.sendFile(path.join(__dirname, 'clova-proxy-test.html'));
});

// 서버 시작
app.listen(PORT, () => {
  console.log(`프록시 서버가 http://localhost:${PORT}에서 실행 중입니다`);
  console.log(`테스트 페이지: http://localhost:${PORT}/proxy-test`);
  console.log(`프록시 엔드포인트: http://localhost:${PORT}/proxy/clova-tts`);
});