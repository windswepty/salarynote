"""
파비콘을 생성한다.  python tools/make-favicon.py

만드는 것
  web/favicon.svg          최신 브라우저용 (벡터, 항상 선명하다)
  web/favicon.ico          구형 브라우저와 즐겨찾기용 (16·32·48 세 장을 담는다)
  web/apple-touch-icon.png 아이폰 홈 화면 추가용 (180px)

디자인
  '샐러리노트' 라서 노트와 돈을 같이 담는다. 다만 파비콘은 실제로 16px 로
  보이는 물건이라 요소가 둘을 넘어가면 뭉개진다. 그래서
    - 왼쪽 세로 띠  = 노트 제본. 폭이 좁아 작게 줄여도 형태가 남는다.
    - 흰색 ₩       = 돈. 남는 폭을 최대한 차지하게 크게 그린다.
  둘뿐이고 서로 겹치지 않아 16px 에서도 실루엣이 구분된다.

  ★16px 만 가로줄을 하나로 줄인다.★
  ₩ 의 가로줄 둘은 64px 기준 8.5 단위 떨어져 있는데, 16px 로 줄이면 간격이
  2px 가 안 돼 두 줄이 한 덩어리로 뭉친다. 그러면 ₩ 가 아니라 얼룩으로 보인다.
  글꼴이 크기별로 굵기를 달리 파는 것과 같은 이유다. 32px 이상은 원안 그대로다.

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
RADIUS = 14

BLUE = (26, 86, 219)          # style.css 의 --accent 와 같은 값
SPINE = (255, 255, 255, 56)   # 파랑 위에 흰색을 옅게 얹어 제본을 만든다
WHITE = (255, 255, 255)

SPINE_W = 9

# 제본 고리. 32px 이상에서 노트로 읽히게 하는 요소다.
# 16px 에서는 띠에 녹아 밝기만 살짝 올라가고 형태는 사라진다. 손해가 없어서
# '큰 화면에서만 보이는 디테일' 로 넣는다.
RING_X0, RING_X1 = 2.0, 7.0
RING_Y = (15.0, 32.0, 49.0)
RING_STROKE = 3.5

# ₩ 의 W. 바깥에서 시작해 가운데를 찍고 다시 올라간다.
W_PTS = [(18, 19), (27, 46), (37, 27), (47, 46), (56, 19)]
W_STROKE = 6

# ₩ 의 가로줄. 위아래 두 줄이 W 를 가로지른다.
BAR_X0, BAR_X1 = 14, 60
BAR_Y = (30.0, 38.5)
BAR_STROKE = 5

# 16px 전용. 줄 하나만 남기고 조금 굵힌다.
BAR_Y_SMALL = (34.0,)
BAR_STROKE_SMALL = 6


def svg() -> str:
    """벡터 원본. 큰 화면에서는 이쪽이 쓰인다."""
    pts = " ".join(f"{x},{y}" for x, y in W_PTS)
    rings = "\n".join(
        f'    <line x1="{RING_X0}" y1="{y}" x2="{RING_X1}" y2="{y}" stroke="#fff"'
        f' stroke-width="{RING_STROKE}" stroke-linecap="round" opacity="0.75"/>'
        for y in RING_Y
    )
    bars = "\n".join(
        f'    <line x1="{BAR_X0}" y1="{y}" x2="{BAR_X1}" y2="{y}"/>'
        for y in BAR_Y
    )
    return f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {BOX} {BOX}" role="img" aria-label="샐러리노트">
  <title>샐러리노트</title>
  <defs>
    <clipPath id="r">
      <rect width="{BOX}" height="{BOX}" rx="{RADIUS}"/>
    </clipPath>
  </defs>
  <g clip-path="url(#r)">
    <rect width="{BOX}" height="{BOX}" fill="#{BLUE[0]:02x}{BLUE[1]:02x}{BLUE[2]:02x}"/>
    <!-- 노트 제본 -->
    <rect width="{SPINE_W}" height="{BOX}" fill="#fff" opacity="{SPINE[3] / 255:.3f}"/>
{rings}
  </g>
  <g fill="none" stroke="#fff" stroke-linecap="round" stroke-linejoin="round">
    <polyline points="{pts}" stroke-width="{W_STROKE}"/>
{bars}
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

    # 제본 띠. 둥근 모서리 밖으로 삐져나가지 않게 배경 알파로 잘라낸다.
    band = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    ImageDraw.Draw(band).rectangle([0, 0, SPINE_W * k, n], fill=SPINE)
    band.putalpha(Image.composite(
        band.getchannel("A"), Image.new("L", (n, n), 0), img.getchannel("A")))
    img.alpha_composite(band)

    rr = RING_STROKE * k / 2
    for y in RING_Y:
        d.line([(RING_X0 * k, y * k), (RING_X1 * k, y * k)],
               fill=WHITE + (191,), width=round(RING_STROKE * k))
        for x in (RING_X0, RING_X1):
            d.ellipse([x * k - rr, y * k - rr, x * k + rr, y * k + rr], fill=WHITE + (191,))

    # 작은 크기에서는 가로줄을 하나로 줄인다. 이유는 파일 상단 주석 참조.
    bars = BAR_Y_SMALL if size <= 16 else BAR_Y
    bar_w = BAR_STROKE_SMALL if size <= 16 else BAR_STROKE

    d.line([(x * k, y * k) for x, y in W_PTS],
           fill=WHITE + (255,), width=round(W_STROKE * k), joint="curve")
    # PIL 은 선 끝을 둥글게 못 깎아서 꼭짓점에 원을 직접 얹는다.
    r = W_STROKE * k / 2
    for x, y in W_PTS:
        d.ellipse([x * k - r, y * k - r, x * k + r, y * k + r], fill=WHITE + (255,))

    r = bar_w * k / 2
    for y in bars:
        d.line([(BAR_X0 * k, y * k), (BAR_X1 * k, y * k)],
               fill=WHITE + (255,), width=round(bar_w * k))
        for x in (BAR_X0, BAR_X1):
            d.ellipse([x * k - r, y * k - r, x * k + r, y * k + r], fill=WHITE + (255,))

    return img.resize((size, size), Image.LANCZOS)


def main() -> None:
    p = os.path.join(WEB, "favicon.svg")
    io.open(p, "w", encoding="utf-8", newline="\n").write(svg())
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
        strip = Image.new("RGBA", (16 + 32 + 64 + 128 + 40, 128), (255, 255, 255, 255))
        x = 0
        for s in (16, 32, 64, 128):
            strip.alpha_composite(raster(s), (x, 128 - s))
            x += s + 10
        strip.save(prev)
        print("미리보기:", prev)


if __name__ == "__main__":
    main()
