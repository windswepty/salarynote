/**
 * JSON 텍스트 국소 수정기.
 *
 * ★왜 JSON.stringify 로 통째로 다시 쓰지 않는가★
 * data/rates-*.json 은 사람이 손으로 서식을 맞춘 파일이다. 짧은 배열은 한 줄로 두고,
 * 미해결 이슈를 긴 주석으로 달아 뒀다. JSON.parse → JSON.stringify 왕복은
 *   - `[12, 13]` 을 세 줄로 펼치고
 *   - `1.0` 을 `1` 로 바꾸고
 *   - 모든 줄의 서식을 뒤엎는다.
 * 값 하나를 고쳤을 뿐인데 diff 가 파일 전체가 되면 사람이 검토를 포기한다.
 * 검토를 포기하게 만드는 것은 이 프로젝트에서 실제 위험이다 — 사람 검토 1회가
 * 틀린 요율의 무인 배포를 막는 마지막 장치이기 때문이다.
 *
 * 그래서 바뀐 값의 텍스트 범위만 정확히 찾아 그 자리만 갈아 끼운다.
 * 나머지 바이트는 그대로 남는다.
 *
 * 의존성 0. 순수 CommonJS.
 */

/**
 * JSON 텍스트를 훑어 '경로 -> 값 토큰의 [start, end)' 지도를 만든다.
 * 컨테이너(객체·배열)도 자기 전체 범위를 등록하므로 배열 통째 교체도 가능하다.
 *
 * @param {string} text
 * @returns {Map<string,{start:number,end:number}>}
 */
function locate(text) {
  const map = new Map();
  let i = 0;
  const n = text.length;

  const ws = () => {
    while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++;
  };

  function readString() {
    // text[i] === '"'
    const start = i;
    i++;
    while (i < n) {
      const c = text[i];
      if (c === "\\") {
        i += 2;
        continue;
      }
      if (c === '"') {
        i++;
        return text.slice(start, i);
      }
      i++;
    }
    throw new Error(`JSON 문자열이 닫히지 않았습니다 (offset ${start})`);
  }

  function readValue(pathStr) {
    ws();
    const start = i;
    const c = text[i];
    if (c === "{") {
      i++;
      for (;;) {
        ws();
        if (text[i] === "}") {
          i++;
          break;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        if (text[i] !== '"') throw new Error(`객체 키를 기대했으나 '${text[i]}' (offset ${i})`);
        const rawKey = readString();
        const key = JSON.parse(rawKey);
        ws();
        if (text[i] !== ":") throw new Error(`':' 를 기대했으나 '${text[i]}' (offset ${i})`);
        i++;
        readValue(pathStr ? `${pathStr}.${key}` : key);
      }
    } else if (c === "[") {
      i++;
      let idx = 0;
      for (;;) {
        ws();
        if (text[i] === "]") {
          i++;
          break;
        }
        if (text[i] === ",") {
          i++;
          continue;
        }
        readValue(pathStr ? `${pathStr}.${idx}` : String(idx));
        idx++;
      }
    } else if (c === '"') {
      readString();
    } else {
      // number / true / false / null
      const m = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i));
      if (!m) throw new Error(`값을 해석할 수 없습니다 (offset ${i}): ${JSON.stringify(text.slice(i, i + 20))}`);
      i += m[0].length;
    }
    if (pathStr !== null) map.set(pathStr, { start, end: i });
  }

  readValue(null);
  ws();
  if (i !== n) throw new Error(`JSON 뒤에 잉여 문자가 있습니다 (offset ${i})`);
  return map;
}

/**
 * 지정한 경로의 값만 갈아 끼운다. 나머지 바이트는 그대로 유지된다.
 *
 * @param {string} text
 * @param {Array<{path:string, text:string}>} edits  text 는 이미 JSON 으로 직렬화된 조각
 * @returns {string}
 */
function patch(text, edits) {
  if (!edits.length) return text;
  const map = locate(text);
  const spans = edits.map((e) => {
    const span = map.get(e.path);
    if (!span) {
      throw new Error(
        `경로를 텍스트에서 찾지 못했습니다: '${e.path}'. ` +
          `새 키 추가는 이 경로로 처리하지 않습니다(사람이 직접 넣어야 합니다).`
      );
    }
    return { ...span, text: e.text };
  });
  // 겹침 검사 — 겹치면 조용히 깨지는 대신 멈춘다.
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].start < sorted[k - 1].end) {
      throw new Error(`수정 범위가 겹칩니다 (${sorted[k - 1].start}-${sorted[k - 1].end} vs ${sorted[k].start}-${sorted[k].end}).`);
    }
  }
  // 뒤에서부터 갈아 끼워야 앞쪽 오프셋이 흔들리지 않는다.
  let out = text;
  for (let k = sorted.length - 1; k >= 0; k--) {
    out = out.slice(0, sorted[k].start) + sorted[k].text + out.slice(sorted[k].end);
  }
  return out;
}

/** 원장 서식(짧은 객체는 한 줄)에 맞춘 기준소득월액 구간 직렬화. */
function formatBracket(b) {
  return `{ "from": ${JSON.stringify(b.from)}, "to": ${JSON.stringify(b.to)}, "min": ${b.min}, "max": ${b.max} }`;
}

module.exports = { locate, patch, formatBracket };
