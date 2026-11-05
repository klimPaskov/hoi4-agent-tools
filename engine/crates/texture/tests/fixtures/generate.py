"""Generates the synthetic texture fixtures and their reference decodes.

    python generate.py            # writes *.dds, *.tga and the Pillow decode of each as *.ref.png

Every fixture is project-owned: seeded random pixels or random BC blocks, so each BC7 mode, every
partition and odd image sizes are covered. The reference decodes come from Pillow's DDS and TGA
readers (recorded with the Pillow version in references.json) and are what the Rust tests compare
against. Pillow is only needed to regenerate; the tests read the committed files.
"""

import json
import random
import struct
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

DDSD = 0x1 | 0x2 | 0x4 | 0x1000  # caps, height, width, pixel format
DDSD_PITCH = 0x8
DDSD_LINEARSIZE = 0x80000
DDPF_ALPHAPIXELS = 0x1
DDPF_ALPHA = 0x2
DDPF_FOURCC = 0x4
DDPF_RGB = 0x40
DDPF_LUMINANCE = 0x20000


def header(width, height, flags, pf_flags, fourcc=b"\0\0\0\0", bits=0, masks=(0, 0, 0, 0), pitch=0):
    pixel_format = struct.pack("<II4sI4I", 32, pf_flags, fourcc, bits, *masks)
    return (
        b"DDS "
        + struct.pack("<7I", 124, flags, height, width, pitch, 0, 1)
        + b"\0" * 44
        + pixel_format
        + struct.pack("<4I", 0x1000, 0, 0, 0)
        + b"\0" * 4
    )


def dx10(width, height, dxgi, data, linear_size):
    return (
        header(width, height, DDSD | DDSD_LINEARSIZE, DDPF_FOURCC, b"DX10", pitch=linear_size)
        + struct.pack("<5I", dxgi, 3, 0, 1, 0)
        + data
    )


def blocks(width, height):
    return ((width + 3) // 4) * ((height + 3) // 4)


def random_bytes(rng, count):
    return bytes(rng.getrandbits(8) for _ in range(count))


# BC7 mode partition-bit counts, to set the partition explicitly after the mode bits.
BC7_PARTITION_BITS = [4, 6, 6, 6, 0, 0, 0, 6]


def bc7_blocks(rng):
    """Every mode with every partition it has (16 random blocks for the one-subset modes, which
    vary rotation and index selection instead), plus one reserved (mode 8) block."""
    out = []
    for mode in range(8):
        bits = BC7_PARTITION_BITS[mode]
        for index in range(1 << bits if bits else 16):
            value = rng.getrandbits(128)
            value &= ~((1 << (mode + 1)) - 1)
            value |= 1 << mode
            if bits:
                value &= ~(((1 << bits) - 1) << (mode + 1))
                value |= index << (mode + 1)
            out.append(value.to_bytes(16, "little"))
    out.append(bytes(16))
    return out


def write(name, data, written):
    (HERE / name).write_bytes(data)
    written.append(name)


def tga(width, height, depth, pixels, image_type=2, descriptor=0, rle=False):
    head = struct.pack("<BBBHHBHHHHBB", 0, 0, image_type + (8 if rle else 0), 0, 0, 0, 0, 0, width, height, depth, descriptor)
    if not rle:
        return head + pixels
    step = depth // 8
    body = bytearray()
    # TGA 2.0: packets never cross a scan line.
    for row in range(height):
        line = pixels[row * width * step : (row + 1) * width * step]
        units = [line[i : i + step] for i in range(0, len(line), step)]
        index = 0
        while index < len(units):
            run = 1
            while index + run < len(units) and run < 128 and units[index + run] == units[index]:
                run += 1
            if run > 1:
                body.append(0x80 | (run - 1))
                body += units[index]
                index += run
            else:
                raw = 1
                while index + raw < len(units) and raw < 128 and units[index + raw] != units[index + raw - 1]:
                    raw += 1
                body.append(raw - 1)
                for unit in units[index : index + raw]:
                    body += unit
                index += raw
    return head + bytes(body)


def scale(value, bits):
    """A channel of `bits` bits to 0..255, rounded half up (the DDS format definitions)."""
    top = (1 << bits) - 1
    return (value * 255 * 2 + top) // (top * 2)


def spec_reference(dxgi, data, width, height):
    """RGBA for the DX10 formats Pillow does not read, straight from the DXGI definitions."""
    out = bytearray()
    for index in range(width * height):
        if dxgi in (87, 88, 91):
            b, g, r, a = data[index * 4 : index * 4 + 4]
            out += bytes([r, g, b, 255 if dxgi == 88 else a])
        elif dxgi == 24:
            (v,) = struct.unpack_from("<I", data, index * 4)
            out += bytes([scale(v & 0x3FF, 10), scale(v >> 10 & 0x3FF, 10), scale(v >> 20 & 0x3FF, 10), scale(v >> 30, 2)])
        elif dxgi == 85:
            (v,) = struct.unpack_from("<H", data, index * 2)
            out += bytes([scale(v >> 11, 5), scale(v >> 5 & 0x3F, 6), scale(v & 0x1F, 5), 255])
        elif dxgi == 86:
            (v,) = struct.unpack_from("<H", data, index * 2)
            out += bytes([scale(v >> 10 & 0x1F, 5), scale(v >> 5 & 0x1F, 5), scale(v & 0x1F, 5), 255 if v >> 15 else 0])
        elif dxgi == 61:
            out += bytes([data[index], 0, 0, 255])
        elif dxgi == 65:
            out += bytes([0, 0, 0, data[index]])
        else:
            raise ValueError(dxgi)
    return bytes(out)


def main():
    rng = random.Random(76)
    written = []
    # BC7: 8 modes, 64 + 64 + 64 + 64 + 1 + 1 + 1 + 64 partitions, one reserved block.
    bc7 = bc7_blocks(rng)
    columns = 16
    rows = (len(bc7) + columns - 1) // columns
    bc7 += [bytes(16)] * (columns * rows - len(bc7))
    write("bc7_modes.dds", dx10(columns * 4, rows * 4, 98, b"".join(bc7), len(bc7) * 16), written)
    srgb = bc7_blocks(random.Random(99))[:64]
    write("bc7_srgb_odd.dds", dx10(30, 18, 99, b"".join(srgb[: blocks(30, 18)]), blocks(30, 18) * 16), written)

    # Uncompressed DX10 formats at an odd size.
    width, height = 37, 23
    spec = {}
    for dxgi, bpp, name in [
        (28, 4, "r8g8b8a8_unorm"),
        (29, 4, "r8g8b8a8_unorm_srgb"),
        (87, 4, "b8g8r8a8_unorm"),
        (88, 4, "b8g8r8x8_unorm"),
        (91, 4, "b8g8r8a8_unorm_srgb"),
        (24, 4, "r10g10b10a2_unorm"),
        (85, 2, "b5g6r5_unorm"),
        (86, 2, "b5g5r5a1_unorm"),
        (61, 1, "r8_unorm"),
        (65, 1, "a8_unorm"),
    ]:
        data = random_bytes(rng, width * height * bpp)
        write(f"dx10_{name}.dds", dx10(width, height, dxgi, data, width * bpp), written)
        if dxgi not in (28, 29):
            spec[f"dx10_{name}.dds"] = (spec_reference(dxgi, data, width, height), width, height)

    # Block formats under DX10 and legacy FourCC codes.
    width, height = 30, 18
    for dxgi, size, name in [(71, 8, "bc1"), (74, 16, "bc2"), (77, 16, "bc3"), (80, 8, "bc4"), (83, 16, "bc5")]:
        data = random_bytes(rng, blocks(width, height) * size)
        write(f"dx10_{name}.dds", dx10(width, height, dxgi, data, len(data)), written)
    for fourcc, size in [(b"DXT1", 8), (b"DXT3", 16), (b"DXT5", 16), (b"ATI1", 8), (b"ATI2", 16)]:
        data = random_bytes(rng, blocks(width, height) * size)
        name = fourcc.decode().lower()
        write(f"legacy_{name}.dds", header(width, height, DDSD | DDSD_LINEARSIZE, DDPF_FOURCC, fourcc, pitch=len(data)) + data, written)

    # Legacy uncompressed masks.
    width, height = 21, 13
    for name, flags, bits, masks in [
        ("a8r8g8b8", DDPF_RGB | DDPF_ALPHAPIXELS, 32, (0xFF0000, 0xFF00, 0xFF, 0xFF000000)),
        ("x8r8g8b8", DDPF_RGB, 32, (0xFF0000, 0xFF00, 0xFF, 0)),
        ("a8b8g8r8", DDPF_RGB | DDPF_ALPHAPIXELS, 32, (0xFF, 0xFF00, 0xFF0000, 0xFF000000)),
        ("r8g8b8", DDPF_RGB, 24, (0xFF0000, 0xFF00, 0xFF, 0)),
        ("r5g6b5", DDPF_RGB, 16, (0xF800, 0x7E0, 0x1F, 0)),
        ("a1r5g5b5", DDPF_RGB | DDPF_ALPHAPIXELS, 16, (0x7C00, 0x3E0, 0x1F, 0x8000)),
        ("a4r4g4b4", DDPF_RGB | DDPF_ALPHAPIXELS, 16, (0xF00, 0xF0, 0xF, 0xF000)),
        ("l8", DDPF_LUMINANCE, 8, (0xFF, 0, 0, 0)),
        ("a8l8", DDPF_LUMINANCE | DDPF_ALPHAPIXELS, 16, (0xFF, 0, 0, 0xFF00)),
    ]:
        data = random_bytes(rng, width * height * bits // 8)
        write(f"legacy_{name}.dds", header(width, height, DDSD | DDSD_PITCH, flags, bits=bits, masks=masks, pitch=width * bits // 8) + data, written)

    # TGA: bottom-left and top-left origins, 24 and 32 bit, run-length encoded, greyscale.
    width, height = 19, 11
    pixels32 = bytes(b for _ in range(width * height // 3 + 1) for b in random_bytes(rng, 4) * 3)[: width * height * 4]
    write("tga_32.tga", tga(width, height, 32, random_bytes(rng, width * height * 4), descriptor=8), written)
    write("tga_24_top.tga", tga(width, height, 24, random_bytes(rng, width * height * 3), descriptor=0x20), written)
    write("tga_32_rle_top.tga", tga(width, height, 32, pixels32, descriptor=0x28, rle=True), written)
    write("tga_grey.tga", tga(width, height, 8, random_bytes(rng, width * height), image_type=3), written)

    references = {}
    try:
        from PIL import Image, __version__ as pillow
    except ImportError:
        print("Pillow is not installed: fixtures written, references not regenerated", file=sys.stderr)
        return
    for name in written:
        target = HERE / (name.rsplit(".", 1)[0] + ".ref.png")
        if name in spec:
            rgba, width, height = spec[name]
            Image.frombytes("RGBA", (width, height), rgba).save(target)
            references[name] = {"reference": "DXGI definition (generate.py)", "size": [width, height]}
            continue
        with Image.open(HERE / name) as image:
            image.load()
            image.convert("RGBA").save(target)
            references[name] = {"reference": "Pillow", "mode": image.mode, "size": list(image.size)}
    (HERE / "references.json").write_text(json.dumps({"pillow": pillow, "references": references}, indent=2) + "\n", newline="\n")


if __name__ == "__main__":
    main()
