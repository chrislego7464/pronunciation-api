'use strict';
require('dotenv').config();

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { assessPronunciationFromFile, annotateWithPhonology } = require('./azurePronunciationAssessment');
const { assessPronunciationETRI } = require('./etriPronunciationAssessment');
const { synthesizeSpeech } = require('./azureTextToSpeech');
const { applyRules } = require('./koreanPhonology');

const app = express();
app.use(express.json());

// 브라우저(앱 프로토타입)에서 이 로컬 서버로 직접 요청할 수 있게 허용.
// 개발/테스트용이라 전부 허용(*)하지만, 실제 배포에서는 출처를 좁혀야 한다.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  // 최신 크롬은 https 페이지가 localhost(사설망)로 요청을 보낼 때 이 헤더가 없으면
  // preflight에서 막아버린다 (Private Network Access).
  res.header('Access-Control-Allow-Private-Network', 'true');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// Render 같은 곳에 새로 배포하면 이 폴더가 없는 상태로 시작될 수 있어서 미리 만들어둔다
// (git은 빈 폴더를 저장하지 않기 때문).
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads', { recursive: true });
const upload = multer({ dest: 'uploads/' });

/**
 * POST /api/pronunciation/target
 * body: { sentence: "저는 학교에 가요." }
 * -> 표준 표기에 규칙을 적용한 목표 발음과, 어느 자리에 무슨 규칙이
 *    적용됐는지를 반환한다. (녹음 없이 바로 확인 가능 — ①단계 엔진)
 */
app.post('/api/pronunciation/target', (req, res) => {
  const { sentence } = req.body || {};
  if (!sentence) return res.status(400).json({ error: 'sentence가 필요합니다.' });
  const { result, notes } = applyRules(sentence);
  res.json({ sentence, targetPronunciation: result, appliedRules: notes });
});

/**
 * POST /api/pronunciation/tts
 * body: { sentence: "저는 학교에 가요." }
 * -> Azure 신경망 음성으로 표준 표기 문장을 읽어주는 wav 오디오를 그대로 반환한다.
 *    (표기를 그대로 넘긴다 — Azure TTS가 이미 표준 발음 규칙을 적용해서 읽는다)
 */
app.post('/api/pronunciation/tts', async (req, res) => {
  const { sentence } = req.body || {};
  if (!sentence) return res.status(400).json({ error: 'sentence가 필요합니다.' });
  try {
    const audioBuffer = await synthesizeSpeech(sentence);
    res.set('Content-Type', 'audio/wav');
    res.send(audioBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

/**
 * POST /api/pronunciation/assess  (multipart/form-data)
 * fields: audio (파일, 16kHz mono wav 권장), sentence (표준 표기)
 * -> Azure Pronunciation Assessment 결과 + 우리 규칙 엔진으로 보강한
 *    단어별 추정 오류 유형을 반환한다.
 */
app.post('/api/pronunciation/assess', upload.single('audio'), async (req, res) => {
  const { sentence } = req.body || {};
  if (!req.file || !sentence) {
    return res.status(400).json({ error: 'audio 파일과 sentence(표준 표기)가 모두 필요합니다.' });
  }
  try {
    const raw = await assessPronunciationFromFile({
      audioFilePath: req.file.path,
      referenceText: sentence,
    });
    const annotated = annotateWithPhonology(raw, sentence);
    res.json(annotated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/**
 * POST /api/pronunciation/assess-etri  (multipart/form-data)
 * fields: audio (파일, wav 권장), sentence (표준 표기)
 * -> ETRI 발음평가 API의 recognized/score + 우리 규칙 엔진으로 계산한
 *    자리별 오류 유형(diffs)을 반환한다.
 */
app.post('/api/pronunciation/assess-etri', upload.single('audio'), async (req, res) => {
  const { sentence } = req.body || {};
  if (!req.file || !sentence) {
    return res.status(400).json({ error: 'audio 파일과 sentence(표준 표기)가 모두 필요합니다.' });
  }
  try {
    const result = await assessPronunciationETRI({
      audioFilePath: req.file.path,
      referenceText: sentence,
    });
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`pronunciation API listening on :${PORT}`));

module.exports = app;
