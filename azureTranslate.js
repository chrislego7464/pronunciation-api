'use strict';
/**
 * Azure Translator 연동.
 * 일본어로 입력한 문장을 한국어로 번역해서, 발음 쉐도잉 파이프라인에 넣을 수
 * 있게 해준다. 번역 품질을 사용자가 직접 검증하기 어려우므로(한국어를 잘
 * 모르니까), 호출하는 쪽에서 역번역(한국어→일본어)도 같이 요청해서
 * "원래 뜻이랑 비슷한지" 대략 확인할 수 있게 하는 걸 권장한다.
 */

const ENDPOINT = 'https://api.cognitive.microsofttranslator.com/translate?api-version=3.0';

async function translateText(text, from, to) {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  const region = process.env.AZURE_TRANSLATOR_REGION;
  if (!key || !region) {
    throw new Error('AZURE_TRANSLATOR_KEY / AZURE_TRANSLATOR_REGION 환경변수가 필요합니다.');
  }

  const url = `${ENDPOINT}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Ocp-Apim-Subscription-Region': region,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify([{ Text: text }]),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`번역 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  return (data[0] && data[0].translations && data[0].translations[0] && data[0].translations[0].text) || '';
}

module.exports = { translateText };
