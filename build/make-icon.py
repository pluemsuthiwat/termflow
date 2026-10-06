"""Draws the app icon. Run: python3 build/make-icon.py
  build/icon.png                       1024x1024 macOS app icon (icon grid + drop shadow)
  src/renderer/src/assets/logo.png     256x256 tight crop, no shadow, for the in-app logo
"""
from PIL import Image, ImageDraw, ImageFilter

S = 1024
SS = 4  # supersample for smooth edges
W = S * SS
img = Image.new('RGBA', (W, W), (0, 0, 0, 0))

# macOS icon grid: 824px rounded square centred, with a soft drop shadow.
pad = (S - 824) // 2 * SS
box = (pad, pad, W - pad, W - pad)
radius = 185 * SS


# Vertical gradient body in the app's dark palette.
body = Image.new('RGBA', (W, W), (0, 0, 0, 0))
top, bottom = (43, 48, 60), (20, 22, 26)
grad = Image.new('RGBA', (1, W))
for y in range(W):
    t = min(max((y - box[1]) / (box[3] - box[1]), 0), 1)
    grad.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)) + (255,))
body.paste(grad.resize((W, W)))
mask = Image.new('L', (W, W), 0)
ImageDraw.Draw(mask).rounded_rectangle(box, radius, fill=255)
img.paste(body, (0, 0), mask)

# Thin inner border.
ImageDraw.Draw(img).rounded_rectangle(box, radius, outline=(255, 255, 255, 28), width=3 * SS)

# Prompt ">_" in the accent blue.
d = ImageDraw.Draw(img)
accent = (122, 162, 247, 255)
w = 64 * SS
cx, cy = 400 * SS, 512 * SS
d.line([(cx - 120 * SS, cy - 150 * SS), (cx + 40 * SS, cy), (cx - 120 * SS, cy + 150 * SS)], fill=accent, width=w, joint='curve')
for x, y in [(cx - 120 * SS, cy - 150 * SS), (cx + 40 * SS, cy), (cx - 120 * SS, cy + 150 * SS)]:
    d.ellipse((x - w // 2, y - w // 2, x + w // 2, y + w // 2), fill=accent)
u = (cx + 110 * SS, cy + 118 * SS, cx + 330 * SS, cy + 118 * SS + w)
d.rounded_rectangle(u, w // 2, fill=(215, 218, 224, 255))

# In-app logo: the artwork alone, cropped to the rounded square.
img.crop(box).resize((256, 256), Image.LANCZOS).save('src/renderer/src/assets/logo.png')

shadow = Image.new('RGBA', (W, W), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((box[0], box[1] + 12 * SS, box[2], box[3] + 12 * SS), radius, fill=(0, 0, 0, 110))
icon = shadow.filter(ImageFilter.GaussianBlur(18 * SS))
icon.alpha_composite(img)
icon.resize((S, S), Image.LANCZOS).save('build/icon.png')
print('wrote build/icon.png and src/renderer/src/assets/logo.png')
