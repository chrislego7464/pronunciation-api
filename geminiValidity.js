'use strict';
/**
 * Google Gemini API 연동 — 자유 대화에서 사용자의 (음성인식된) 답변이
 * 주어진 질문에 타당한 대답인지 판단한다.
 *
 * Gemini를 고른 이유: 무료 등급이 신용카드 없이 발급되고, 저희 규모(파일럿)에서
 * 절대 넘길 일 없는 하루 요청 한도를 제공하며, 무료 옵션 중 한국어 이해력이
 * 상대적으로 좋은 편이다. (2026-08 기준 정보 — 무료 등급 조건은 계속 바뀌므로
 * 나중에 이상 동작하면 https://ai.google.dev/gemini-api/docs/rate-limits 에서
 * 현재 무료 한도/모델명을 다시 확인할 것.)
 */

const GEMINI_MODEL = 'gemini-3.6-flash'; // 2026-08: gemini-2.5-flash가 신규 사용자에게 제공 중단되어 교체함
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

/**
 * 안전장치: Gemini가 프롬프트 지시를 어기고 한글이 아닌 텍스트(일본어 등)를
 * nextLine으로 돌려주는 경우를 감지한다. 텍스트에서 공백을 뺀 글자 수 중
 * 한글 비율이 낮으면 "한국어가 아니다"로 판단한다.
 */
function looksKorean(text) {
  if (!text) return false;
  const stripped = text.replace(/\s/g, '');
  if (stripped.length === 0) return false;
  const hangulCount = (stripped.match(/[가-힣]/g) || []).length;
  return hangulCount / stripped.length >= 0.3;
}

async function checkAnswerValidity(question, userAnswer, lang) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 필요합니다.');

  const langInstruction = lang === 'ja' ? '설명(feedback)은 반드시 일본어로 작성하세요.' : '설명(feedback)은 반드시 한국어로 작성하세요.';
  const prompt = `당신은 한국어 학습 앱의 대화 연습을 평가하는 채점자입니다.

질문: "${question}"
사용자의 답변(음성 인식 결과라 오타나 어색한 띄어쓰기가 있을 수 있음): "${userAnswer}"

이 답변이 질문에 대한 자연스럽고 타당한 대답인지 판단하세요. 문법이 완벽하지 않아도 의미가 통하면 타당하다고 판단하세요. 질문과 전혀 무관하거나 대답이 되지 않으면 타당하지 않다고 판단하세요.
${langInstruction} 학습자를 격려하는 짧고 다정한 어조로 한두 문장만 쓰세요.

반드시 아래 JSON 형식으로만 답하세요 (다른 텍스트, 코드블록 표시 없이 JSON만):
{"valid": true 또는 false, "feedback": "한두 문장 설명"}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini 요청 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  const cleaned = text.replace(/```json|```/g, '').trim();

  try {
    const parsed = JSON.parse(cleaned);
    return { valid: !!parsed.valid, feedback: parsed.feedback || '' };
  } catch (e) {
    throw new Error('Gemini 응답을 JSON으로 해석하지 못했습니다: ' + text);
  }
}

/**
 * 대화 시작 시, 주제만 가지고 AI 쪽 첫 대사를 생성한다.
 */
async function generateOpeningLine(topic, lang) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 필요합니다.');

  const prompt = `[중요한 규칙] nextLine은 반드시 한글(한국어)로만 작성하세요. 일본어, 영어, 그 외 어떤 언어도 절대 섞지 마세요.

당신은 한국어를 배우는 일본인 초급 학습자와 대화하는 친절한 한국인 대화 상대입니다.
대화 주제: "${topic}"
쉬운 한국어(TOPIK 1~2급 수준)로, 대화를 시작하는 첫 대사를 한 문장만 만드세요. 짧은 인사와 함께 질문 하나로 시작하면 좋습니다.
다시 한번 강조합니다: nextLine의 내용은 100% 한글이어야 합니다.

반드시 아래 JSON 형식으로만 답하세요 (다른 텍스트 없이 JSON만):
{"nextLine": "첫 대사(반드시 한글로만)"}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini 요청 실패 (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  const nextLine = parsed.nextLine || '';
  if (!looksKorean(nextLine)) {
    console.warn('Gemini가 한글이 아닌 opening line을 반환함(대체 문장 사용):', nextLine);
    return '안녕하세요! 오늘 기분이 어때요?';
  }
  return nextLine;
}

/**
 * 대화 중 매 턴: 지금까지의 대화 기록 + 학습자의 최신 답변을 주고,
 * (1) 답변이 타당한지 판단 + (2) 자연스러운 다음 대사를 함께 생성한다.
 * history: [{ speaker: 'ai'|'user', text: string }, ...]
 */
async function continueConversation({ history, recognizedText, lang }) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY 환경변수가 필요합니다.');

  const langInstruction = lang === 'ja'
    ? 'feedback은 일본어로 쓰세요.'
    : 'feedback은 한국어로 쓰세요.';
  const historyText = (history || []).map(h => `${h.speaker === 'ai' ? 'AI' : '학습자'}: ${h.text}`).join('\n');

  const prompt = `[중요한 규칙] nextLine은 반드시 한글(한국어)로만 작성하세요. 대화 상대(학습자)가 어느 나라 사람이든, 어떤 언어로 대화 기록이 섞여 있든 상관없이, nextLine은 예외 없이 100% 한글이어야 합니다. 일본어, 영어, 그 외 어떤 언어도 절대 섞지 마세요.

당신은 한국어를 배우는 일본인 초급 학습자와 대화하는 친절한 한국인 대화 상대입니다.
쉬운 한국어(TOPIK 1~2급 수준)로, 짧고 자연스럽게 대화하세요. 질문도 하고 리액션도 하면서, 실제 친구처럼 대화를 이어가세요.

지금까지의 대화:
${historyText || '(대화 시작 전)'}

학습자의 최신 답변(음성 인식 결과라 오타나 어색한 부분이 있을 수 있음): "${recognizedText}"

1. 이 답변이 앞선 맥락에 자연스럽고 타당한 대답인지 판단하세요. 문법이 완벽하지 않아도 의미가 통하면 타당합니다.
2. 대화를 자연스럽게 이어갈 다음 대사를 한 문장만 만드세요 (질문이어도 되고 리액션이어도 됩니다). 다시 한번 강조합니다: 이 문장은 100% 한글이어야 합니다.
${langInstruction} 학습자를 격려하는 다정한 어조로, feedback은 한두 문장만 쓰세요.

반드시 아래 JSON 형식으로만 답하세요 (다른 텍스트 없이 JSON만):
{"valid": true 또는 false, "feedback": "한두 문장 설명", "nextLine": "다음 대사(반드시 한글로만)"}`;

  const res = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
  });
  if (!res.ok) throw new Error(`Gemini 요청 실패 (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const text = (data.candidates && data.candidates[0] && data.candidates[0].content &&
    data.candidates[0].content.parts && data.candidates[0].content.parts[0] &&
    data.candidates[0].content.parts[0].text) || '';
  const cleaned = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(cleaned);
  let nextLine = parsed.nextLine || '';
  if (!looksKorean(nextLine)) {
    console.warn('Gemini가 한글이 아닌 nextLine을 반환함(대체 문장 사용):', nextLine);
    nextLine = '그렇군요! 조금 더 이야기해 줄래요?';
  }
  return { valid: !!parsed.valid, feedback: parsed.feedback || '', nextLine };
}

module.exports = { checkAnswerValidity, generateOpeningLine, continueConversation };
