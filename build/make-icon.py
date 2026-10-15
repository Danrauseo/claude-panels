# Draws the app icon: a deep blue tile holding three terminal panels (two above, one wide below).
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SCALE = 4  # draw large, then shrink, for smooth edges
W = S * SCALE

def box(x0, y0, x1, y1):
    return [v * SCALE for v in (x0, y0, x1, y1)]

img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

# Soft shadow under the tile
shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle(box(100, 116, 924, 940), radius=185 * SCALE, fill=(0, 0, 0, 110))
shadow = shadow.filter(ImageFilter.GaussianBlur(18 * SCALE))
img.alpha_composite(shadow)

# Tile with a top to bottom gradient
tile = Image.new('RGBA', (W, W), (0, 0, 0, 0))
grad = Image.new('RGBA', (W, W))
gd = ImageDraw.Draw(grad)
top, bottom = (31, 56, 110), (11, 22, 48)
for y in range(W):
    t = y / W
    gd.line([(0, y), (W, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(box(100, 100, 924, 924), radius=185 * SCALE, fill=255)
tile.paste(grad, (0, 0), mask)
img.alpha_composite(tile)

d = ImageDraw.Draw(img)
panel_fill = (13, 19, 33, 255)
panel_line = (84, 120, 196, 255)
lw = 10 * SCALE

panels = [box(196, 236, 500, 520), box(524, 236, 828, 520), box(196, 544, 828, 788)]
for p in panels:
    d.rounded_rectangle(p, radius=34 * SCALE, fill=panel_fill, outline=panel_line, width=lw)

# A prompt mark and a cursor in each panel
prompt = (197, 213, 242, 255)
def prompt_mark(x, y, size):
    s = size
    d.line([box(x, y, x + s * 0.55, y + s * 0.5)[0:2], box(x + s * 0.55, y + s * 0.5, 0, 0)[0:2]], fill=prompt, width=lw + 2 * SCALE)
    d.line([box(x + s * 0.55, y + s * 0.5, 0, 0)[0:2], box(x, y + s, 0, 0)[0:2]], fill=prompt, width=lw + 2 * SCALE)
    d.rounded_rectangle(box(x + s * 0.85, y + s * 0.82, x + s * 1.75, y + s * 1.0), radius=4 * SCALE, fill=prompt)

prompt_mark(236, 290, 64)
prompt_mark(564, 290, 64)
prompt_mark(236, 598, 64)

img = img.resize((S, S), Image.LANCZOS)
img.save('build/icon.png')
print('saved build/icon.png')
