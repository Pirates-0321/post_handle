#!/usr/bin/env python3
"""生成扩展图标（纯标准库，无需 Pillow）。

绘制：红色圆角方块底 + 黄色五角星，输出 16/48/128 三种尺寸到 icons/。
用法：python tools/generate_icons.py
"""

import math
import os
import struct
import zlib

BG_COLOR = (192, 57, 43, 255)    # #c0392b
STAR_COLOR = (241, 196, 15, 255) # #f1c40f
TRANSPARENT = (0, 0, 0, 0)


def star_polygon(cx, cy, outer_r, inner_r, points=5, rotation=-90):
    """五角星顶点坐标（外圈与内圈交替）。"""
    vertices = []
    for i in range(points * 2):
        r = outer_r if i % 2 == 0 else inner_r
        angle = math.radians(rotation + i * 180 / points)
        vertices.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    return vertices


def point_in_polygon(x, y, polygon):
    """射线法判断点是否在多边形内。"""
    inside = False
    n = len(polygon)
    j = n - 1
    for i in range(n):
        xi, yi = polygon[i]
        xj, yj = polygon[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def rounded_rect_contains(x, y, size, radius):
    """判断点是否在圆角方块内。"""
    if radius <= 0:
        return 0 <= x < size and 0 <= y < size
    # 四个角分别判断到圆心距离
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2


def render_icon(size):
    radius = size * 0.18
    star = star_polygon(size / 2, size / 2, size * 0.36, size * 0.36 * 0.42)

    pixels = bytearray()
    for y in range(size):
        pixels.append(0)  # 每行开头的 filter 字节
        for x in range(size):
            # 简单超采样抗锯齿：2x2 子像素
            samples = []
            for dx, dy in ((0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)):
                px, py = x + dx, y + dy
                if not rounded_rect_contains(px, py, size, radius):
                    samples.append(TRANSPARENT)
                elif point_in_polygon(px, py, star):
                    samples.append(STAR_COLOR)
                else:
                    samples.append(BG_COLOR)
            # 混合 alpha 实现边缘平滑
            r = sum(s[0] for s in samples) // 4
            g = sum(s[1] for s in samples) // 4
            b = sum(s[2] for s in samples) // 4
            a = sum(s[3] for s in samples) // 4
            pixels.extend((r, g, b, a))
    return bytes(pixels)


def write_png(path, size, raw_pixels):
    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data
                + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)  # 8bit RGBA
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', ihdr)
           + chunk(b'IDAT', zlib.compress(raw_pixels, 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def main():
    out_dir = os.path.join(os.path.dirname(__file__), '..', 'icons')
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 48, 128):
        path = os.path.join(out_dir, f'icon{size}.png')
        write_png(path, size, render_icon(size))
        print(f'生成 {path}')


if __name__ == '__main__':
    main()
