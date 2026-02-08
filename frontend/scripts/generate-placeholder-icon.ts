/**
 * Generates a placeholder ICO file at build/icon.ico.
 * Creates a dark (#09090b) square with a purple (#a78bfa) circle center.
 * Includes 16x16, 32x32, 48x48, and 256x256 sizes.
 *
 * Usage: bun run scripts/generate-placeholder-icon.ts
 * Replace with a real icon before distribution.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const BG = { r: 0x09, g: 0x09, b: 0x0b, a: 0xff };
const FG = { r: 0xa7, g: 0x8b, b: 0xfa, a: 0xff };

function createBmpImage(size: number): Buffer {
	const headerSize = 40;
	const pixelDataSize = size * size * 4;
	const andMaskRowBytes = Math.ceil(size / 32) * 4;
	const andMaskSize = andMaskRowBytes * size;
	const totalSize = headerSize + pixelDataSize + andMaskSize;
	const buf = Buffer.alloc(totalSize);
	let offset = 0;

	// BITMAPINFOHEADER
	buf.writeUInt32LE(headerSize, offset);
	offset += 4; // biSize
	buf.writeInt32LE(size, offset);
	offset += 4; // biWidth
	buf.writeInt32LE(size * 2, offset);
	offset += 4; // biHeight (doubled for ICO)
	buf.writeUInt16LE(1, offset);
	offset += 2; // biPlanes
	buf.writeUInt16LE(32, offset);
	offset += 2; // biBitCount
	buf.writeUInt32LE(0, offset);
	offset += 4; // biCompression
	buf.writeUInt32LE(pixelDataSize + andMaskSize, offset);
	offset += 4; // biSizeImage
	buf.writeInt32LE(0, offset);
	offset += 4; // biXPelsPerMeter
	buf.writeInt32LE(0, offset);
	offset += 4; // biYPelsPerMeter
	buf.writeUInt32LE(0, offset);
	offset += 4; // biClrUsed
	buf.writeUInt32LE(0, offset);
	offset += 4; // biClrImportant

	// Pixel data (BGRA, bottom-to-top)
	const cx = size / 2;
	const cy = size / 2;
	const radius = size * 0.3;
	const radiusSq = radius * radius;

	for (let y = size - 1; y >= 0; y--) {
		for (let x = 0; x < size; x++) {
			const dx = x - cx + 0.5;
			const dy = y - cy + 0.5;
			const distSq = dx * dx + dy * dy;
			const color = distSq <= radiusSq ? FG : BG;
			buf.writeUInt8(color.b, offset);
			offset += 1;
			buf.writeUInt8(color.g, offset);
			offset += 1;
			buf.writeUInt8(color.r, offset);
			offset += 1;
			buf.writeUInt8(color.a, offset);
			offset += 1;
		}
	}

	// AND mask (all zeros = fully opaque)
	// Already zeroed from Buffer.alloc

	return buf;
}

function createIco(sizes: number[]): Buffer {
	const images = sizes.map((size) => createBmpImage(size));
	const icoHeaderSize = 6;
	const icoDirEntrySize = 16;
	const headerTotalSize = icoHeaderSize + icoDirEntrySize * sizes.length;

	let fileOffset = headerTotalSize;
	const totalSize = headerTotalSize + images.reduce((sum, img) => sum + img.length, 0);
	const buf = Buffer.alloc(totalSize);
	let offset = 0;

	// ICONDIR
	buf.writeUInt16LE(0, offset);
	offset += 2; // Reserved
	buf.writeUInt16LE(1, offset);
	offset += 2; // Type: ICO
	buf.writeUInt16LE(sizes.length, offset);
	offset += 2; // Count

	// ICONDIRENTRY for each size
	for (let i = 0; i < sizes.length; i++) {
		const s = sizes[i] as number;
		const img = images[i] as Buffer;
		buf.writeUInt8(s < 256 ? s : 0, offset);
		offset += 1; // Width (0 = 256)
		buf.writeUInt8(s < 256 ? s : 0, offset);
		offset += 1; // Height (0 = 256)
		buf.writeUInt8(0, offset);
		offset += 1; // ColorCount
		buf.writeUInt8(0, offset);
		offset += 1; // Reserved
		buf.writeUInt16LE(1, offset);
		offset += 2; // Planes
		buf.writeUInt16LE(32, offset);
		offset += 2; // BitCount
		buf.writeUInt32LE(img.length, offset);
		offset += 4; // SizeInBytes
		buf.writeUInt32LE(fileOffset, offset);
		offset += 4; // FileOffset
		fileOffset += img.length;
	}

	// Image data
	for (const img of images) {
		img.copy(buf, offset);
		offset += img.length;
	}

	return buf;
}

// Generate multi-size ICO
const icoData = createIco([16, 32, 48, 256]);
const outDir = join(import.meta.dirname, "..", "build");
const outPath = join(outDir, "icon.ico");

mkdirSync(outDir, { recursive: true });
writeFileSync(outPath, icoData);

const sizeKb = (icoData.length / 1024).toFixed(1);
console.log(`Created placeholder icon: ${outPath} (${sizeKb} KB, 4 sizes: 16/32/48/256)`);
console.log("Replace with a real icon before distribution.");
