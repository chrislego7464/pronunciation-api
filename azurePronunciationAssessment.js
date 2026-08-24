'use strict';
/**
 * Azure Speech Pronunciation Assessment 연동.
 *
 * 중요한 전제: Azure는 한국어(ko-KR) pronunciation assessment를 공식 지원하지만,
 * 실제 사용자 보고에 따르면 명백히 틀리게 읽은 한국어 문장에도 점수가 100점 가까이
 * 나오는 경우가 있었다는 후기가 있다 (Microsoft Q&A, 2024). 즉 Azure의 총점(AccuracyScore)
 * 하나만으로 "발음이 맞았는지"를 판단하면 0-A에서 우려한 "이미 시도했다가 정확도
 * 문제로 접은 사례"를 반복할 수 있다.
 *
 * 그래서 이 모듈은 총점을 그대로 신뢰하지 않고:
 *   1) 우리 규칙 엔진(koreanPhonology)으로 "이 문장의 이 자리는 어떤 발음 규칙이
 *      적용되는 지점인가"를 먼저 계산하고,
 *   2) Azure가 반환하는 단어/음소 단위 정확도 점수를 그 위에 겹쳐서,
 *   3) "규칙이 적용되는 자리에서 점수가 낮다" → 해당 규칙 이름으로 추정 라벨을 붙인다.
 *
 * 이 추정 라벨은 확정된 오류 분류가 아니라 휴리스틱이다. 기획서 0-B 파일럿에서
 * 전문가 라벨링과 비교해 이 추정이 실제로 쓸만한지 검증해야 한다.
 */

const fs = require('fs');
const sdk = require('microsoft-cognitiveservices-speech-sdk');
const { applyRules } = require('./koreanPhonology');

const LOW_SCORE_THRESHOLD = 85; // 0~100. 최초 잠정치는 60이었으나, 실제 테스트에서
// 일부러 틀리게 읽은 단어가 66점/82점으로 나왔는데도 60 기준으로는 안 잡혀서 85로 올림.
// 0-B 파일럿에서 더 많은 샘플로 다시 조정할 것

/**
 * WAV 오디오 파일(16kHz mono 권장)과 기준 문장(표준 표기)을 받아
 * Azure의 원본 JSON 결과를 반환한다.
 */
function assessPronunciationFromFile({ audioFilePath, referenceText, language = 'ko-KR' }) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) {
      reject(new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 환경변수가 필요합니다.'));
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = fs.readFileSync(audioFilePath);
    } catch (err) {
      reject(err);
      return;
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = language;

    // fromWavFileInput reads the WAV header itself (sample rate, bit depth, channels)
    // instead of assuming a fixed raw PCM format — this is the correct way to hand
    // a full .wav file (header + data) to the SDK.
    const audioConfig = sdk.AudioConfig.fromWavFileInput(audioBuffer);

    // scripted assessment: 문장을 이미 알고 있으므로 표준 표기를 referenceText로 넘긴다.
    // (Azure 공식 가이드: 정확한 인식 기반 평가가 필요하면 먼저 STT로 기준 텍스트를
    //  얻은 뒤 scripted assessment를 하라고 권장 — 여기서는 우리가 이미 목표 문장을
    //  알고 있으니 바로 scripted로 진행)
    const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
      referenceText,
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true // enableMiscue: 단어 누락/삽입도 감지
    );

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronunciationConfig.applyTo(recognizer);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
          reject(new Error('음성 인식 실패: ' + result.reason));
          return;
        }
        const raw = JSON.parse(
          result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
        );
        resolve(raw);
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

/**
 * 자유 발화(자유 대화) 전용: 목표 문장을 미리 모르는 상태에서 음성을 인식하고,
 * Azure가 스스로 인식한 텍스트를 기준으로 발음 점수를 매긴다 (unscripted assessment).
 * referenceText를 비워두면 Azure가 이 모드로 동작한다.
 */
function assessPronunciationUnscripted({ audioFilePath, language = 'ko-KR' }) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) {
      reject(new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 환경변수가 필요합니다.'));
      return;
    }

    let audioBuffer;
    try {
      audioBuffer = fs.readFileSync(audioFilePath);
    } catch (err) {
      reject(err);
      return;
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechRecognitionLanguage = language;
    // 억양만으로 "물음표일 것 같다"고 추론해서 잘못 붙이는 걸 막는다.
    // 사용자가 실제로 문장부호를 말한 경우에만 반영되도록 한다.
    speechConfig.setServiceProperty('punctuation', 'explicit', sdk.ServicePropertyChannel.UriQueryParameter);
    const audioConfig = sdk.AudioConfig.fromWavFileInput(audioBuffer);

    const pronunciationConfig = new sdk.PronunciationAssessmentConfig(
      '', // referenceText를 비우면 unscripted(자유 발화) 모드로 동작한다.
      sdk.PronunciationAssessmentGradingSystem.HundredMark,
      sdk.PronunciationAssessmentGranularity.Phoneme,
      true
    );

    const recognizer = new sdk.SpeechRecognizer(speechConfig, audioConfig);
    pronunciationConfig.applyTo(recognizer);

    recognizer.recognizeOnceAsync(
      (result) => {
        recognizer.close();
        if (result.reason !== sdk.ResultReason.RecognizedSpeech) {
          reject(new Error('음성 인식 실패: ' + result.reason));
          return;
        }
        const raw = JSON.parse(
          result.properties.getProperty(sdk.PropertyId.SpeechServiceResponse_JsonResult)
        );
        resolve(raw);
      },
      (err) => {
        recognizer.close();
        reject(err);
      }
    );
  });
}

/** Azure 결과 + 우리 규칙 엔진을 합쳐 한국어 특화 오류 추정 라벨을 붙인다. */
function annotateWithPhonology(azureRaw, referenceSentence) {
  const { notes } = applyRules(referenceSentence);
  const ruleByCharIndex = new Map();
  notes.forEach((n) => {
    ruleByCharIndex.set(n.pos, n.rule);
    ruleByCharIndex.set(n.pos + 1, n.rule);
  });

  const nbest = (azureRaw.NBest && azureRaw.NBest[0]) || {};
  const words = nbest.Words || [];

  let charCursor = 0;
  const wordResults = words.map((w) => {
    const wordText = w.Word || '';
    const startIndex = referenceSentence.indexOf(wordText, charCursor);
    if (startIndex >= 0) charCursor = startIndex + wordText.length;

    const pa = w.PronunciationAssessment || {};
    const accuracy = typeof pa.AccuracyScore === 'number' ? pa.AccuracyScore : null;
    const errorType = pa.ErrorType || 'None';

    const relatedRules = new Set();
    if (startIndex >= 0) {
      for (let i = startIndex; i < startIndex + wordText.length; i++) {
        if (ruleByCharIndex.has(i)) relatedRules.add(ruleByCharIndex.get(i));
      }
    }

    let estimatedCategory = null;
    if (errorType !== 'None' || (accuracy !== null && accuracy < LOW_SCORE_THRESHOLD)) {
      estimatedCategory = relatedRules.size
        ? [...relatedRules].join(', ') + ' 관련 발음 흔들림(추정)'
        : '규칙 외 발음 오차 — 초성/모음/받침 확인 필요';
    }

    return {
      word: wordText,
      accuracyScore: accuracy,
      azureErrorType: errorType,
      relatedRules: [...relatedRules],
      estimatedCategory,
      phonemes: (w.Phonemes || []).map((p) => ({
        phoneme: p.Phoneme,
        accuracyScore: p.PronunciationAssessment ? p.PronunciationAssessment.AccuracyScore : null,
      })),
    };
  });

  return {
    overall: nbest.PronunciationAssessment || null,
    words: wordResults,
  };
}

module.exports = { assessPronunciationFromFile, assessPronunciationUnscripted, annotateWithPhonology, LOW_SCORE_THRESHOLD };
