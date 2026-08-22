/**
 * 연도 전환 안전장치 검증.
 *
 * ★이 테스트가 왜 있는가★
 * tools/lib/resolve-ledger.js 는 assertCurrent 를 "번들 게이트의 존재 이유"이자
 * "조용히 작년 원장으로 번들을 만드는 것을 막는 유일한 지점"이라고 문서화해
 * 두었다. 그런데 실제로는 ★아무 데서도 호출하지 않는 죽은 코드★ 였다.
 *
 * 즉 2027-01-01 에 빌드를 돌리면 resolve() 가 2026 원장을 조용히 돌려주고,
 * 모든 검사가 초록으로 통과한 채 ★2027년에 2026년 요율로 계산하는 사이트★가
 * 배포된다. 날짜를 속여 실제로 재현해 확인했다.
 *
 * 안전장치를 만들어 놓고 꽂지 않는 것은 없는 것보다 나쁘다. 있다고 믿게 되기
 * 때문이다. 그래서 '게이트가 실제로 연결되어 있는지' 를 테스트로 고정한다.
 *
 * 연도 전환은 1년에 한 번뿐이라 겪어 보고 고칠 수 없다. 날짜를 속여 미리 겪는다.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FAKE = path.join(__dirname, "fixtures", "fake-future-date.js");

let pass = 0, fail = 0;
const t = (n, f) => { try { f(); console.log(`  PASS  ${n}`); pass++; } catch (e) { console.log(`  FAIL  ${n}\n        ${e.message}`); fail++; } };

/** 날짜를 속여 스크립트를 돌린다. { code, err } 를 돌려준다. */
function runAt(day, script, args = []) {
  try {
    execFileSync(process.execPath, ["-r", FAKE, path.join(ROOT, script), ...args], {
      cwd: ROOT, encoding: "utf8", stdio: "pipe",
      env: { ...process.env, SN_FAKE_TODAY: day },
    });
    return { code: 0, err: "" };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, err: (e.stderr || "") + (e.stdout || "") };
  }
}

const { resolve, assertCurrent } = require(path.join(ROOT, "tools", "lib", "resolve-ledger.js"));
const L = resolve();

console.log("\n[연도 전환 안전장치]\n");

t("현재 연도에서는 빌드가 정상이다", () => {
  // 원장의 확인일을 쓴다. 그보다 앞선 날짜를 고르면 '확인일이 미래' 라는
  // 다른 위생 검사에 걸려 이 테스트가 엉뚱한 이유로 실패한다(실제로 겪었다).
  const today = JSON.parse(fs.readFileSync(L.ledgerPath, "utf8")).lastVerified;
  for (const s of ["build/bundle.js", "build/stamp.js"]) {
    const r = runAt(today, s, s.endsWith("stamp.js") ? ["--check"] : []);
    assert.strictEqual(r.code, 0, `${s} 가 현재 연도에서 실패했다:\n${r.err}`);
  }
});

t("★해가 바뀌고 새 원장이 없으면 번들이 멈춘다★", () => {
  // 이 검사가 실패하면 assertCurrent 가 다시 죽은 코드가 된 것이다.
  const r = runAt(`${L.year + 1}-01-01`, "build/bundle.js");
  assert.notStrictEqual(r.code, 0,
    "새해에 작년 원장으로 번들이 만들어졌다. assertCurrent 가 bundle.js 에 연결돼 있지 않다.");
  assert.ok(/현역 원장이 없습니다/.test(r.err), `기대한 오류가 아니다:\n${r.err.slice(0, 400)}`);
});

t("★화면 문구 생성도 함께 멈춘다★", () => {
  // 번들만 막고 stamp 를 놔두면 화면에 작년 요율이 찍힌다.
  const r = runAt(`${L.year + 1}-01-01`, "build/stamp.js");
  assert.notStrictEqual(r.code, 0, "새해에 작년 요율로 화면 문구가 생성됐다.");
  assert.ok(/현역 원장이 없습니다/.test(r.err), `기대한 오류가 아니다:\n${r.err.slice(0, 400)}`);
});

t("오류 메시지가 무엇을 해야 하는지 알려준다", () => {
  const r = runAt(`${L.year + 1}-01-01`, "build/bundle.js");
  // 새해 첫 빌드에서 이 메시지를 보는 사람은 대개 요율과 무관한 작업 중이다.
  assert.ok(/코드 변경과 무관/.test(r.err), "코드 변경 탓이 아니라는 안내가 없다");
  assert.ok(new RegExp(`rates-${L.year + 1}\\.json`).test(r.err), "만들어야 할 파일명이 없다");
  assert.ok(/사이트는 계속 동작/.test(r.err), "사이트가 죽지 않는다는 안내가 없다");
});

t("assertCurrent 가 실제로 build 코드에 연결돼 있다", () => {
  // 위 테스트들은 동작으로 확인한다. 이것은 연결 자체를 직접 확인해
  // '어쩌다 다른 이유로 실패해서 통과한' 경우를 배제한다.
  for (const f of ["build/bundle.js", "build/stamp.js"]) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    assert.ok(/assertCurrent\s*\(/.test(src), `${f} 가 assertCurrent 를 부르지 않는다`);
  }
});

t("원장 연도가 미래여도 멈춘다", () => {
  // 파일명을 잘못 붙이거나 시스템 시각이 어긋난 경우.
  const r = runAt(`${L.year - 1}-06-01`, "build/bundle.js");
  assert.notStrictEqual(r.code, 0, "미래 원장을 그대로 썼다");
  assert.ok(/미래입니다/.test(r.err), `기대한 오류가 아니다:\n${r.err.slice(0, 300)}`);
});

t("assertCurrent 자체의 판정이 정확하다", () => {
  assert.doesNotThrow(() => assertCurrent(L, `${L.year}-12-31`), "같은 해 마지막 날");
  assert.throws(() => assertCurrent(L, `${L.year + 1}-01-01`), /현역 원장이 없습니다/, "다음 해 첫날");
  assert.throws(() => assertCurrent(L, `${L.year - 1}-12-31`), /미래입니다/, "이전 해");
});

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
