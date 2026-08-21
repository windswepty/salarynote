"""
파비콘과 로고 마크를 생성한다.  python tools/make-favicon.py

만드는 것
  web/favicon.svg          브라우저 탭·상단바 로고 (벡터, 항상 선명하다)
  web/favicon.ico          구형 브라우저와 즐겨찾기용 (16·32·48 세 장을 담는다)
  web/apple-touch-icon.png 아이폰 홈 화면 추가용 (180px)

디자인 — 두 번 덜어냈다
  1차: '샐러리노트' 라서 노트 제본 띠와 고리까지 넣었다. 그런데 이 마크가 실제로
  놓이는 자리는 브라우저 탭(16px)과 상단바 로고(22px)다. 그 크기에서 띠·고리·W·
  가로줄 다섯 요소가 뭉쳐 파란 사각형 위의 흰 얼룩이 됐다. 노트 요소를 버렸다.

  2차: ₩ 만 남겼는데도 22px 에서 뭉갰다. 원인은 가로줄 두 개였다. 64px 기준
  8 단위 간격은 22px 로 줄이면 2.7px 가 되고, 획 굵기를 빼면 줄 사이 틈이 1px 도
  안 남아 한 덩어리로 보인다. 간격을 11까지 벌리고 획을 3.2 까지 얇혀 봤지만
  22px 에서는 끝내 살아나지 않았다. 두 줄짜리 ₩ 는 28px 아래에서 성립하지 않는다.

  그래서 ★가로줄을 하나로 고정했다.★ 크기별로 다른 그림을 쓰면 탭과 로고와 홈
  화면 아이콘이 서로 다른 마크가 되므로, 작은 쪽에서 성립하는 형태 하나로 통일한
  것이다. 한 줄짜리 ₩ 는 128px 에서도 어색하지 않고 16px 에서도 형태가 버틴다.

  ★가운데 봉우리는 바깥 획 높이 가까이 올린다.★ 낮게 두면 가로줄에 파묻히고
  바깥 획만 위로 솟아 더듬이처럼 보인다. 실제로 그렇게 만들었다가 32px 에서
  글자가 아니라 벌레로 읽혔다.

  좌표를 이 파일 한 곳에만 두고 SVG 와 PNG 를 같은 숫자로 그린다.
  따로 관리하면 한쪽만 고쳐져 아이콘 두 종류가 생긴다.
"""
import io
import os

from PIL import Image, ImageDraw

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "web")

# ── 좌표 (64×64 기준) ────────────────────────────────────────────
BOX = 64
RADIUS = 15

BLUE = (26, 86, 219)   # style.css 의 --accent 와 같은 값
WHITE = (255, 255, 255)

# ₩ 의 W. 가운데 봉우리(32, 25)가 바깥 끝(20)에 가깝다.
W_PTS = [(15, 20), (23, 45), (32, 25), (41, 45), (49, 20)]
W_STROKE = 5.5

# ₩ 의 가로줄. 하나뿐인 이유는 파일 상단 주석 참조.
# W 보다 좌우로 조금 더 빼야 장식이 아니라 글자로 읽힌다.
BAR_X0, BAR_X1 = 11, 53
BAR_Y = 33.5
BAR_STROKE = 4.6


def svg() -> str:
    """벡터 원본. 탭 아이콘과 상단바 로고가 모두 이 파일을 쓴다."""
    pts = " ".join(f"{x},{y}" for x, y in W_PTS)
    fill = "#%02x%02x%02x" % BLUE
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOX} {BOX}" role="img" aria-label="샐러리노트">
  <title>샐러리노트</title>
  <rect width="{BOX}" height="{BOX}" rx="{RADIUS}" fill="{fill}"/>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="{pts}" stroke-width="{W_STROKE}"/>
    <line x1="{BAR_X0}" y1="{BAR_Y}" x2="{BAR_X1}" y2="{BAR_Y}" stroke-width="{BAR_STROKE}"/>
  </g>
</svg>
"""


def raster(size: int) -> Image.Image:
    """PNG 를 그린다. 8배로 그린 뒤 줄여서 계단을 없앤다."""
    s = 8
    n = size * s
    k = n / BOX  # 64 기준 좌표를 실제 픽셀로 옮기는 배율

    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=RADIUS * k, fill=BLUE + (255,))

    def stroke(points, width):
        """PIL 은 선 끝을 둥글게 못 깎아서 꼭짓점마다 원을 얹어 흉내낸다."""
        d.line([(x * k, y * k) for x, y in points],
               fill=WHITE + (255,), width=round(width * k), joint="curve")
        r = width * k / 2
        for x, y in points:
            d.ellipse([x * k - r, y * k - r, x * k + r, y * k + r], fill=WHITE + (255,))

    stroke(W_PTS, W_STROKE)
    stroke([(BAR_X0, BAR_Y), (BAR_X1, BAR_Y)], BAR_STROKE)

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    io.open(os.path.join(WEB, "favicon.svg"), "w",
            encoding="utf-8", newline="\n").write(svg())
    print("favicon.svg")

    # .ico 는 여러 크기를 한 파일에 담는다. 브라우저가 상황에 맞는 걸 고른다.
    sizes = [16, 32, 48]
    imgs = [raster(s) for s in sizes]
    imgs[0].save(os.path.join(WEB, "favicon.ico"), format="ICO",
                 sizes=[(s, s) for s in sizes], append_images=imgs[1:])
    print("favicon.ico (%s)" % ", ".join(f"{s}px" for s in sizes))

    raster(180).save(os.path.join(WEB, "apple-touch-icon.png"), format="PNG")
    print("apple-touch-icon.png (180px)")

    # 눈으로 확인할 미리보기. 배포에는 넣지 않는다.
    prev = os.environ.get("FAVICON_PREVIEW")
    if prev:
        shown = (16, 22, 32, 64, 128)
        pad = 12
        w = sum(shown) + pad * (len(shown) + 1)
        strip = Image.new("RGBA", (w, 128 + pad * 2), (255, 255, 255, 255))
        x = pad
        for sz in shown:
            strip.alpha_composite(raster(sz), (x, pad + 128 - sz))
            x += sz + pad
        strip.save(prev)
        print("미리보기:", prev)


if __name__ == "__main__":
    main()
