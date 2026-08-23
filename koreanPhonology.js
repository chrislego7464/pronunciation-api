'use strict';
/**
 * 목표 발음 생성 엔진 (G2P + 음운 규칙)
 * 프로토타입 아티팩트(pronunciation_engine_prototype.html)에서 이미 검증한
 * 로직을 그대로 Node 모듈로 포팅한 것입니다. 국물→궁물, 좋아→조아,
 * 학교→학꾜, 신라→실라, 값이→갑시, 옷 위에→옫 위에 등으로 확인함.
 */

const BASE = 0xAC00;
const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const JUNG = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const JONG = ['', 'ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

function isHangul(ch) {
  const c = ch.codePointAt(0);
  return c >= 0xAC00 && c <= 0xD7A3;
}
function decompose(ch) {
  const code = ch.codePointAt(0) - BASE;
  return {
    cho: CHO[Math.floor(code / 28 / 21)],
    jung: JUNG[Math.floor(code / 28) % 21],
    jong: JONG[code % 28],
  };
}
function compose(cho, jung, jong) {
  return String.fromCodePoint(
    BASE + (CHO.indexOf(cho) * 21 + JUNG.indexOf(jung)) * 28 + JONG.indexOf(jong || '')
  );
}

const NEUTRALIZE = { '': '', 'ㄱ':'ㄱ','ㄲ':'ㄱ','ㄳ':'ㄱ','ㄴ':'ㄴ','ㄵ':'ㄴ','ㄶ':'ㄴ','ㄷ':'ㄷ','ㄹ':'ㄹ','ㄺ':'ㄱ','ㄻ':'ㅁ','ㄼ':'ㄹ','ㄽ':'ㄹ','ㄾ':'ㄹ','ㄿ':'ㅂ','ㅀ':'ㄹ','ㅁ':'ㅁ','ㅂ':'ㅂ','ㅄ':'ㅂ','ㅅ':'ㄷ','ㅆ':'ㄷ','ㅇ':'ㅇ','ㅈ':'ㄷ','ㅊ':'ㄷ','ㅋ':'ㄱ','ㅌ':'ㄷ','ㅍ':'ㅂ','ㅎ':'ㄷ' };
const COMPOUND_SPLIT = { 'ㄳ':['ㄱ','ㅅ'],'ㄵ':['ㄴ','ㅈ'],'ㄶ':['ㄴ','ㅎ'],'ㄺ':['ㄹ','ㄱ'],'ㄻ':['ㄹ','ㅁ'],'ㄼ':['ㄹ','ㅂ'],'ㄽ':['ㄹ','ㅅ'],'ㄾ':['ㄹ','ㅌ'],'ㄿ':['ㄹ','ㅍ'],'ㅀ':['ㄹ','ㅎ'],'ㅄ':['ㅂ','ㅅ'] };
const TENSE = { 'ㄱ':'ㄲ','ㄷ':'ㄸ','ㅂ':'ㅃ','ㅅ':'ㅆ','ㅈ':'ㅉ' };
const NASAL = { 'ㄱ':'ㅇ','ㄷ':'ㄴ','ㅂ':'ㅁ' };
const ASPIRATE = { 'ㄱ':'ㅋ','ㄷ':'ㅌ','ㅂ':'ㅍ','ㅈ':'ㅊ' };
const GROUPS = [['ㄱ','ㄲ','ㅋ'], ['ㄷ','ㄸ','ㅌ'], ['ㅂ','ㅃ','ㅍ'], ['ㅅ','ㅆ'], ['ㅈ','ㅉ','ㅊ']];
const groupOf = (j) => GROUPS.find((g) => g.includes(j));

/**
 * 문장(표준 표기)을 받아 실제 발음(규칙 적용 결과)과, 어느 자리에
 * 어떤 규칙이 적용됐는지(notes)를 반환한다.
 */
function applyRules(text) {
  const syll = [...text].map((ch) => (isHangul(ch) ? decompose(ch) : ch));
  const notes = [];
  for (let i = 0; i < syll.length - 1; i++) {
    const cur = syll[i], next = syll[i + 1];
    if (typeof cur === 'string' || typeof next === 'string') continue;
    if (cur.jong === '') continue;

    if (next.cho === 'ㅇ') {
      if (cur.jong === 'ㅇ') continue;
      if (cur.jong === 'ㅎ') { cur.jong = ''; notes.push({ pos: i, rule: 'ㅎ탈락' }); continue; }
      // ㄶ/ㅀ은 다른 겹받침과 달리 ㅎ이 사라지고 남은 자음(ㄴ/ㄹ)이 그대로 다음 음절
      // 초성으로 이동한다 (많아요→마나요, 싫어요→시러요 — "만하요/실허요"가 아님).
      if (cur.jong === 'ㄶ') { next.cho = 'ㄴ'; cur.jong = ''; notes.push({ pos: i, rule: 'ㅎ탈락' }); continue; }
      if (cur.jong === 'ㅀ') { next.cho = 'ㄹ'; cur.jong = ''; notes.push({ pos: i, rule: 'ㅎ탈락' }); continue; }
      if (COMPOUND_SPLIT[cur.jong]) {
        const [stay, moved] = COMPOUND_SPLIT[cur.jong];
        cur.jong = stay; next.cho = moved;
        notes.push({ pos: i, rule: '연음(겹받침)' });
      } else {
        next.cho = cur.jong; cur.jong = '';
        notes.push({ pos: i, rule: '연음' });
      }
      continue;
    }
    if (cur.jong === 'ㅎ' && ASPIRATE[next.cho]) {
      next.cho = ASPIRATE[next.cho]; cur.jong = '';
      notes.push({ pos: i, rule: '격음화' });
      continue;
    }
    {
      const neu0 = NEUTRALIZE[cur.jong];
      if (next.cho === 'ㅎ' && ASPIRATE[neu0]) {
        next.cho = ASPIRATE[neu0]; cur.jong = '';
        notes.push({ pos: i, rule: '격음화' });
        continue;
      }
    }
    const neu = NEUTRALIZE[cur.jong];
    if (neu === 'ㄴ' && next.cho === 'ㄹ') { cur.jong = 'ㄹ'; notes.push({ pos: i, rule: '유음화' }); continue; }
    if (neu === 'ㄹ' && next.cho === 'ㄴ') { next.cho = 'ㄹ'; notes.push({ pos: i, rule: '유음화' }); continue; }
    if (NASAL[neu] && (next.cho === 'ㄴ' || next.cho === 'ㅁ')) { cur.jong = NASAL[neu]; notes.push({ pos: i, rule: '비음화' }); continue; }
    if (TENSE[next.cho] && ['ㄱ','ㄷ','ㅂ'].includes(neu)) { cur.jong = neu; next.cho = TENSE[next.cho]; notes.push({ pos: i, rule: '경음화' }); continue; }
    if (neu !== cur.jong) { notes.push({ pos: i, rule: '받침규칙' }); cur.jong = neu; }
  }
  for (let i = 0; i < syll.length; i++) {
    const s = syll[i];
    if (typeof s !== 'object') continue;
    const next = syll[i + 1];
    if (i === syll.length - 1 || typeof next !== 'object') {
      const neu2 = NEUTRALIZE[s.jong];
      if (neu2 !== s.jong) notes.push({ pos: i, rule: '받침규칙' });
      s.jong = neu2;
    }
  }
  const result = syll.map((s) => (typeof s === 'string' ? s : compose(s.cho, s.jung, s.jong))).join('');
  return { result, notes };
}

/** 두 음절을 자모 단위로 비교해 오류 유형을 추정한다 (텍스트 대 텍스트 비교용). */
function classifySyllable(targetCh, guessCh) {
  if (!isHangul(targetCh) || !isHangul(guessCh)) return targetCh === guessCh ? null : '표기 오류';
  const t = decompose(targetCh), g = decompose(guessCh);
  if (t.cho === g.cho && t.jung === g.jung && t.jong === g.jong) return null;
  if (t.cho === g.cho && t.jung === g.jung) {
    if (t.jong !== '' && g.jong === '') return '받침 탈락';
    if (t.jong === '' && g.jong !== '') return '받침 첨가';
    return `받침 오류(${t.jong || '없음'}→${g.jong || '없음'})`;
  }
  if (t.jung === g.jung && t.jong === g.jong) {
    const gt = groupOf(t.cho), gg = groupOf(g.cho);
    if (gt && gg && gt === gg) return '평음/경음/격음 혼동';
    return '초성 오류';
  }
  if (t.cho === g.cho && t.jong === g.jong) return '모음 오류';
  return '복합 오류';
}

module.exports = { isHangul, decompose, compose, applyRules, classifySyllable };
