import {
	lstatSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

// cspell:ignore ustar

const encoder = new TextEncoder();
const TAR_BLOCK_SIZE = 512;
const FIXED_MTIME_SECONDS = 499162500;

function collectEntries(directory, relativeDirectory = "") {
	const entries = [];
	for (const item of readdirSync(directory, { withFileTypes: true }).sort(
		(left, right) => left.name.localeCompare(right.name),
	)) {
		const relativePath = relativeDirectory
			? `${relativeDirectory}/${item.name}`
			: item.name;
		const absolutePath = join(directory, item.name);
		if (item.isDirectory()) {
			entries.push(...collectEntries(absolutePath, relativePath));
		} else {
			entries.push({
				relativePath,
				absolutePath,
				symbolicLink: item.isSymbolicLink(),
			});
		}
	}
	return entries;
}

function writeString(target, offset, length, value) {
	const bytes = encoder.encode(value);
	if (bytes.length > length) {
		throw new Error(`Tar header field is too long: ${value}`);
	}
	target.set(bytes, offset);
}

function writeOctal(target, offset, length, value) {
	writeString(
		target,
		offset,
		length,
		`${value.toString(8).padStart(length - 1, "0")}\0`,
	);
}

function splitPath(path) {
	if (encoder.encode(path).length <= 100) return { name: path, prefix: "" };
	let separator = path.lastIndexOf("/");
	while (separator > 0) {
		const prefix = path.slice(0, separator);
		const name = path.slice(separator + 1);
		if (
			encoder.encode(prefix).length <= 155 &&
			encoder.encode(name).length <= 100
		) {
			return { name, prefix };
		}
		separator = path.lastIndexOf("/", separator - 1);
	}
	throw new Error(`Tar path is too long: ${path}`);
}

function concatenate(chunks) {
	const size = chunks.reduce((total, chunk) => total + chunk.length, 0);
	const result = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

function createHeader(path, size, mode, type, linkName = "") {
	const header = new Uint8Array(TAR_BLOCK_SIZE);
	const { name, prefix } = splitPath(path);
	writeString(header, 0, 100, name);
	writeOctal(header, 100, 8, mode);
	writeOctal(header, 108, 8, 0);
	writeOctal(header, 116, 8, 0);
	writeOctal(header, 124, 12, size);
	writeOctal(header, 136, 12, FIXED_MTIME_SECONDS);
	header.fill(32, 148, 156);
	writeString(header, 156, 1, type);
	writeString(header, 157, 100, linkName);
	writeString(header, 257, 6, "ustar\0");
	writeString(header, 263, 2, "00");
	writeString(header, 345, 155, prefix);
	const checksum = header.reduce((sum, byte) => sum + byte, 0);
	writeString(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
	return header;
}

export function createDeterministicTarball(packageDirectory, destination) {
	const chunks = [];
	for (const entry of collectEntries(packageDirectory)) {
		const archivePath = `package/${entry.relativePath}`;
		const stats = lstatSync(entry.absolutePath);
		const data = entry.symbolicLink
			? new Uint8Array()
			: readFileSync(entry.absolutePath);
		const mode = entry.symbolicLink
			? 0o777
			: stats.mode & 0o111
				? 0o755
				: 0o644;
		chunks.push(
			createHeader(
				archivePath,
				data.length,
				mode,
				entry.symbolicLink ? "2" : "0",
				entry.symbolicLink ? readlinkSync(entry.absolutePath) : "",
			),
			data,
			new Uint8Array(
				(TAR_BLOCK_SIZE - (data.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE,
			),
		);
	}
	chunks.push(new Uint8Array(TAR_BLOCK_SIZE * 2));
	const compressed = new Uint8Array(
		gzipSync(concatenate(chunks), { level: 9 }),
	);
	compressed.fill(0, 4, 8);
	compressed[9] = 255;
	writeFileSync(destination, compressed);
}
