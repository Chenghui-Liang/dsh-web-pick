from PIL import Image, ImageDraw

S = 180
img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# blue rounded tile
d.rounded_rectangle([6, 6, S - 6, S - 6], radius=32, fill=(47, 111, 235, 255))

# four white corner brackets (viewfinder)
w = 6
arm = 16
pad = 28
for x, y, dx, dy in [(pad, pad, 1, 1), (S - pad, pad, -1, 1), (pad, S - pad, 1, -1), (S - pad, S - pad, -1, -1)]:
    d.line([(x, y), (x + dx * arm, y)], fill=(255, 255, 255, 255), width=w)
    d.line([(x, y), (x, y + dy * arm)], fill=(255, 255, 255, 255), width=w)

# the picked element + its dot
d.rounded_rectangle([64, 60, 116, 120], radius=10, fill=(255, 255, 255, 235))
d.ellipse([84, 84, 96, 96], fill=(47, 111, 235, 255))

out = r'D:\日常\dsh-web-pick\assets\icon-180.png'
img.save(out)
print('saved', out, img.size)
