'use strict';
/**
 * Azure Speech Text-to-Speech (신경망 음성) 연동.
 *
 * 표준 표기(예: "학교에 가요")를 그대로 TTS에 넘긴다 — Azure의 한국어 음성은
 * 이미 자체적으로 경음화·비음화 등 표준 발음 규칙을 적용해서 소리를 낸다.
 * 우리가 만든 "학꾜에 가요" 같은 재표기 문자열을 TTS에 넣을 필요는 없다
 * (오히려 실제 단어가 아니라서 이상하게 읽힐 수 있다).
 */

const sdk = require('microsoft-cognitiveservices-speech-sdk');

const DEFAULT_VOICE = 'ko-KR-SunHiNeural';

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/**
 * 의문문("?")이면 문장 마지막 어절의 피치를 올려서 한국어 의문문 억양(끝을
 * 올리는 것)을 근사한다. Azure 일반 TTS가 이 부분을 충분히 살리지 못하는
 * 경우가 있어서 수동으로 보정하는 것 — 완벽한 자연스러움은 아니고 근사치다.
 */
function buildSsml(text, voice) {
  const trimmed = text.trim();
  const isQuestion = /[?？]\s*$/.test(trimmed);
  let bodyXml;
  if (isQuestion) {
    const tokens = trimmed.split(/(\s+)/); // 공백도 보존
    let lastWordIdx = -1;
    for (let i = tokens.length - 1; i >= 0; i--) {
      if (tokens[i].trim()) { lastWordIdx = i; break; }
    }
    bodyXml = tokens
      .map((tok, i) => (i === lastWordIdx ? `<prosody pitch="+20%">${escapeXml(tok)}</prosody>` : escapeXml(tok)))
      .join('');
  } else {
    bodyXml = escapeXml(trimmed);
  }
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="ko-KR"><voice name="${voice}">${bodyXml}</voice></speak>`;
}

function synthesizeSpeech(text, voice = DEFAULT_VOICE) {
  return new Promise((resolve, reject) => {
    const speechKey = process.env.AZURE_SPEECH_KEY;
    const speechRegion = process.env.AZURE_SPEECH_REGION;
    if (!speechKey || !speechRegion) {
      reject(new Error('AZURE_SPEECH_KEY / AZURE_SPEECH_REGION 환경변수가 필요합니다.'));
      return;
    }

    const speechConfig = sdk.SpeechConfig.fromSubscription(speechKey, speechRegion);
    speechConfig.speechSynthesisOutputFormat = sdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm;

    const synthesizer = new sdk.SpeechSynthesizer(speechConfig, null);
    const ssml = buildSsml(text, voice);

    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(Buffer.from(result.audioData));
        } else {
          reject(new Error('TTS 합성 실패: ' + result.reason + (result.errorDetails ? ' - ' + result.errorDetails : '')));
        }
      },
      (err) => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

module.exports = { synthesizeSpeech, DEFAULT_VOICE };
