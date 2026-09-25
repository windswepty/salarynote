/**
 * 시스템 시각을 미래로 속인다.  node -r test/fixtures/fake-future-date.js <스크립트>
 *
 * 연도 전환은 1년에 한 번뿐이라 실제로 겪어 보고 고칠 수 없다. 그날이 오면
 * 이미 늦다. 그래서 날짜를 속여 미리 겪는다.
 *
 * SN_FAKE_TODAY 환경변수로 날짜를 정한다(기본 2027-01-01). 시각은 KST 정오라
 * UTC 로 읽어도 KST 로 읽어도 같은 날짜가 된다.
 * SN_FAKE_NOW 에 시각까지 적으면 그 순간으로 고정한다. 날짜가 UTC 와 KST 에서
 * 갈리는 시간대(KST 자정~오전 9시)를 재현할 때 쓴다.
 */
const RealDate = Date;
const FIXED = new RealDate(process.env.SN_FAKE_NOW || (process.env.SN_FAKE_TODAY || "2027-01-01") + "T03:00:00Z");

function FakeDate(...a) {
  if (!(this instanceof FakeDate)) return FIXED.toString();
  return a.length ? new RealDate(...a) : new RealDate(FIXED);
}
FakeDate.prototype = RealDate.prototype;
FakeDate.now = () => FIXED.getTime();
FakeDate.parse = RealDate.parse;
FakeDate.UTC = RealDate.UTC;

global.Date = FakeDate;
