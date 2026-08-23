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

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

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

module.exports = { checkAnswerValidity };
