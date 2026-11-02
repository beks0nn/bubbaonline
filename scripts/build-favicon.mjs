import { writeFileSync } from "node:fs";

// Original 16px rune stone, with a bright blue glyph that stays legible in a tab.
const pixels = [
    "................",
    "....ooooooo.....",
    "..oohhhhhhhoo...",
    ".ohhsssssssshho.",
    ".ohssbbbbsssshho",
    ".ohssbwwbbssssho",
    ".ohssbwwwwbsssho",
    ".ohssbwwbbssssho",
    ".ohssbwwbsssssho",
    ".ohssbwwbbssssho",
    ".ohssbwwbwbsssho",
    ".ohssbwwbbwbssho",
    ".ohssbbbbbbsssho",
    "..ohsssssssshoo.",
    "...oooooooooo...",
    "................",
];
const palette = { o: "#292e36", h: "#b7b8ac", s: "#777f80", b: "#205caa", w: "#8feeff" };
if (pixels.length !== 16 || pixels.some(row => row.length !== 16)) throw new Error("Expected a 16x16 icon");
const shapes = Object.entries(palette).map(([key, color]) => {
    const path = pixels.flatMap((row, y) => [...row].flatMap((pixel, x) =>
        pixel === key ? [`M${x} ${y}h1v1h-1z`] : [])).join("");
    return `  <path fill="${color}" d="${path}"/>`;
});
writeFileSync(new URL("../public/favicon.svg", import.meta.url),
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" shape-rendering="crispEdges">\n${shapes.join("\n")}\n</svg>\n`);

// Standard ICO fallback with 16px and 32px frames, scaled without smoothing.
const sizes = [16, 32];
const frames = sizes.map(size => {
    const maskStride = Math.ceil(size / 32) * 4;
    const frame = Buffer.alloc(40 + size * size * 4 + maskStride * size);
    frame.writeUInt32LE(40, 0);
    frame.writeInt32LE(size, 4);
    frame.writeInt32LE(size * 2, 8);
    frame.writeUInt16LE(1, 12);
    frame.writeUInt16LE(32, 14);
    frame.writeUInt32LE(size * size * 4, 20);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const color = palette[pixels[Math.floor(y * 16 / size)][Math.floor(x * 16 / size)]];
        const offset = 40 + ((size - 1 - y) * size + x) * 4;
        if (color) {
            const rgb = Number.parseInt(color.slice(1), 16);
            frame[offset] = rgb & 255;
            frame[offset + 1] = (rgb >> 8) & 255;
            frame[offset + 2] = (rgb >> 16) & 255;
            frame[offset + 3] = 255;
        } else {
            frame[40 + size * size * 4 + (size - 1 - y) * maskStride + Math.floor(x / 8)] |= 128 >> (x % 8);
        }
    }
    return frame;
});
const directory = Buffer.alloc(6 + sizes.length * 16);
directory.writeUInt16LE(1, 2);
directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
frames.forEach((frame, index) => {
    const entry = 6 + index * 16;
    directory[entry] = sizes[index];
    directory[entry + 1] = sizes[index];
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frame.length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frame.length;
});
writeFileSync(new URL("../public/favicon.ico", import.meta.url), Buffer.concat([directory, ...frames]));
