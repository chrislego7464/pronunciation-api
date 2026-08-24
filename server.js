'use strict';
require('dotenv').config();

const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { assessPronunciationFromFile, assessPronunciationUnscripted, annotateWithPhonology } = require('./azurePronunciationAssessment');
const { assessPronunciationETRI } = require('./etriPronunciationAssessment');
const { synthesizeSpeech } = require('./azureTextToSpeech');
const { translateText } = require('./azureTranslate');
const { saveHistoryRecord, fetchHistoryForUser } = require('./historyStore');
const { applyRules } = require('./koreanPhonology');
const { checkAnswerValidity, generateOpeningLine, continueConversation } = require('./geminiValidity');

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
 * POST /api/translate
 * body: { text: "...", from: "ja", to: "ko" }
 * -> Azure Translator로 번역한 텍스트를 반환한다. 일본어 입력을 한국어로
 *    바꿔서 발음 쉐도잉 파이프라인에 넣기 위한 용도. from/to를 바꿔서
 *    역번역(검증용)에도 그대로 재사용한다.
 */
app.post('/api/translate', async (req, res) => {
  const { text, from, to } = req.body || {};
  if (!text) return res.status(400).json({ error: 'text가 필요합니다.' });
  try {
    const translated = await translateText(text, from || 'ja', to || 'ko');
    res.json({ translated });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  }
});

/**
 * POST /api/history  (multipart/form-data)
 * fields: audio(선택), userId, mode, sentence, category(선택), lang,
 *         overall(JSON 문자열), ruleHits(JSON 문자열)
 * -> 진단 메타데이터 + 녹음 파일을 Supabase에 중앙 저장한다.
 *    (참가자 동의를 받은 뒤에만 프론트에서 호출해야 한다 — 화면 쪽에 이미
 *    동의 게이트를 넣어뒀다.)
 */
app.post('/api/history', upload.single('audio'), async (req, res) => {
  const { userId, mode, sentence, category, lang, overall, ruleHits, responseLatencyMs } = req.body || {};
  if (!userId || !mode || !sentence) {
    return res.status(400).json({ error: 'userId, mode, sentence가 필요합니다.' });
  }
  try {
    let audioBuffer = null;
    if (req.file) audioBuffer = fs.readFileSync(req.file.path);

    const result = await saveHistoryRecord({
      userId, mode, sentence,
      category: category || null,
      lang: lang || null,
      overall: overall ? JSON.parse(overall) : {},
      ruleHits: ruleHits ? JSON.parse(ruleHits) : [],
      audioBuffer,
      responseLatencyMs: responseLatencyMs ? parseInt(responseLatencyMs, 10) : null,
    });
    res.json({ ok: true, audioPath: result.audioPath });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  } finally {
    if (req.file) fs.unlink(req.file.path, () => {});
  }
});

/**
 * GET /api/history?userId=xxx
 * -> 해당 계정의 학습 기록 전체(시간순)를 반환한다. 로그인된 계정 기준으로
 *    기기와 무관하게 항상 같은 기록을 볼 수 있게 하기 위한 용도.
 */
app.get('/api/history', async (req, res) => {
  const { userId } = req.query;
  if (!userId) return res.status(400).json({ error: 'userId가 필요합니다.' });
  try {
    const records = await fetchHistoryForUser(userId);
    res.json({ records });
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
 * POST /api/pronunciation/assess-free  (multipart/form-data)
 * fields: audio (파일), question (맥락, history 없을 때만 사용), lang ('ko'|'ja'),
 *         history (선택, JSON 문자열 [{speaker:'ai'|'user', text}, ...])
 * -> 목표 문장을 모르는 자유 발화를 인식(unscripted)하고, 인식된 텍스트에
 *    우리 규칙 엔진을 적용해 발음 규칙 태그를 붙인다.
 *    history가 있으면(진짜 대화 모드) Gemini가 타당성 판단과 함께 다음 대사도
 *    생성해서 nextLine으로 돌려준다. history가 없으면 타당성 판단만 한다.
 */
app.post('/api/pronunciation/assess-free', upload.single('audio'), async (req, res) => {
  const { question, lang, history } = req.body || {};
  if (!req.file || (!question && !history)) {
    return res.status(400).json({ error: 'audio 파일과 question 또는 history가 필요합니다.' });
  }
  try {
    const raw = await assessPronunciationUnscripted({ audioFilePath: req.file.path });
    const recognizedText = raw.DisplayText || (raw.NBest && raw.NBest[0] && raw.NBest[0].Display) || '';
    if (!recognizedText) {
      return res.json({
        recognizedText: '', overall: null, words: [], valid: false, nextLine: null,
        feedback: lang === 'ja' ? '音声を認識できませんでした。もう一度お試しください。' : '음성을 인식하지 못했어요. 다시 시도해주세요.',
      });
    }
    const annotated = annotateWithPhonology(raw, recognizedText);

    let validity = { valid: null, feedback: '', nextLine: null };
    try {
      if (history) {
        const parsedHistory = JSON.parse(history);
        validity = await continueConversation({ history: parsedHistory, recognizedText, lang: lang || 'ko' });
      } else {
        validity = await checkAnswerValidity(question, recognizedText, lang || 'ko');
      }
    } catch (geminiErr) {
      console.error('Gemini 처리 실패(발음 점수는 계속 반환):', geminiErr);
    }

    res.json({
      recognizedText, overall: annotated.overall, words: annotated.words,
      valid: validity.valid, feedback: validity.feedback, nextLine: validity.nextLine || null,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

/**
 * POST /api/conversation/opening
 * body: { topic, lang }
 * -> 대화 세션을 시작할 때, 주제만 가지고 AI 쪽 첫 대사를 생성한다.
 */
app.post('/api/conversation/opening', async (req, res) => {
  const { topic, lang } = req.body || {};
  if (!topic) return res.status(400).json({ error: 'topic이 필요합니다.' });
  try {
    const nextLine = await generateOpeningLine(topic, lang || 'ko');
    res.json({ nextLine });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String((err && err.message) || err) });
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
