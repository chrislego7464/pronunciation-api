'use strict';
/**
 * ETRI 발음평가 API (WiseASR_PronunciationKor) 연동.
 *
 * ETRI가 반환하는 건 두 가지뿐이다: recognized(인식된 텍스트)와 score(1~5점).
 * Azure처럼 단어/음소별 세부 점수는 안 준다. 그래서 세부 오류 유형 분류는
 * 우리가 직접 한다 — recognized 텍스트를, 우리 규칙 엔진이 계산한 목표
 * 발음(targetPronunciation)과 자모 단위로 비교해서 어느 자리가 어떤 유형으로
 * 다른지 뽑아낸다. (프로토타입 HTML의 "② 진단 데모"와 완전히 같은 로직 —
 * 다만 이번엔 사람이 손으로 입력하는 대신 실제 인식 결과를 넣는다.)
 *
 * 참고: recognized가 "표준 표기로 보정된 텍스트"인지 "실제 들린 대로에 가까운
 * 텍스트"인지는 ETRI 쪽에 문서화돼 있지 않다. 이건 실제로 여러 번 호출해보면서
 * 확인해야 할 부분 — 0-B 기술 스파이크의 핵심 확인 항목 중 하나다.
 */

const fs = require('fs');
const { applyRules, classifySyllable } = require('./koreanPhonology');

const ETRI_ENDPOINT_KOR = 'http://epretx.etri.re.kr:8000/api/WiseASR_PronunciationKor';

/**
 * WAV 오디오 파일과 기준 문장(표준 표기)을 받아 ETRI 발음평가 결과를
 * 우리 규칙 엔진과 결합해 반환한다.
 */
async function assessPronunciationETRI({ audioFilePath, referenceText }) {
  const accessKey = process.env.ETRI_ACCESS_KEY;
  if (!accessKey) {
    throw new Error('ETRI_ACCESS_KEY 환경변수가 필요합니다.');
  }

  const audioBuffer = fs.readFileSync(audioFilePath);
  const audioBase64 = audioBuffer.toString('base64');

  const requestBody = {
    request_id: 'pronunciation-api',
    argument: {
      language_code: 'korean',
      script: referenceText,
      audio: audioBase64,
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000); // 20초 넘으면 포기

  let res;
  try {
    res = await fetch(ETRI_ENDPOINT_KOR, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: accessKey,
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('ETRI 서버 응답이 20초 넘게 없어서 요청을 취소했습니다. 잠시 후 다시 시도해보세요.');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  const raw = await res.json();
  if (raw.result !== 0) {
    throw new Error('ETRI 발음평가 실패: ' + JSON.stringify(raw));
  }

  const { recognized, score } = raw.return_object || {};

  // ETRI가 result:0(성공)이라고 해놓고 score 자리에 XML 에러 응답 조각을
  // 끼워 넣는 경우가 있다 (서버 쪽 일시적 문제로 추정). 이럴 땐 recognizedText도
  // 신뢰할 수 없으므로, 그럴듯한 진단 결과를 만들지 말고 명확히 실패 처리한다.
  if (typeof score === 'string' && score.trim().startsWith('<')) {
    throw new Error(
      'ETRI가 정상적인 점수 대신 오류 응답을 반환했습니다 (서버 쪽 일시적 문제로 보입니다). ' +
      '잠시 후 다시 시도해보세요. 원본 일부: ' + score.slice(0, 80)
    );
  }

  const diagnosis = buildDiagnosis({ recognized, score, referenceText });
  // 디버깅용 — ETRI가 실제로 뭘 돌려주는지 그대로 노출 (score 필드명/타입 확인 후 나중에 제거해도 됨)
  diagnosis._rawReturnObject = raw.return_object;
  return diagnosis;
}

/** ETRI의 recognized 텍스트를 우리 규칙 엔진의 목표 발음과 자모 단위로 비교한다. */
function buildDiagnosis({ recognized, score, referenceText }) {
  const { result: targetPronunciation, notes } = applyRules(referenceText);
  const ruleByCharIndex = new Map();
  notes.forEach((n) => {
    ruleByCharIndex.set(n.pos, n.rule);
    ruleByCharIndex.set(n.pos + 1, n.rule);
  });

  const recognizedText = (recognized || '').trim();
  const len = Math.max(targetPronunciation.length, recognizedText.length);
  const diffs = [];
  for (let i = 0; i < len; i++) {
    const t = targetPronunciation[i] || '';
    const g = recognizedText[i] || '';
    if (!t || !g) {
      if (t !== g) diffs.push({ pos: i, target: t, recognized: g, category: '길이 불일치' });
      continue;
    }
    const category = classifySyllable(t, g);
    if (category) {
      diffs.push({
        pos: i,
        target: t,
        recognized: g,
        category,
        relatedRule: ruleByCharIndex.get(i) || null,
      });
    }
  }

  const scoreNum = typeof score === 'number' ? score : parseFloat(score);
  return {
    etriScore: Number.isFinite(scoreNum) ? scoreNum : null, // 실측: 소수점 있는 연속값 (문서상 1~5 척도)
    recognizedText,
    targetPronunciation,
    diffs,
  };
}

module.exports = { assessPronunciationETRI };
