import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createDeterministicTarball } from "./deterministic-tar.mjs";

test("creates identical valid archives regardless of file creation order", () => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "authowl-tar-test-"));
	try {
		const first = join(temporaryRoot, "first");
		const second = join(temporaryRoot, "second");
		createFixture(first, ["nested", "executable", "data", "link"]);
		createFixture(second, ["link", "data", "executable", "nested"]);

		const firstArchive = join(temporaryRoot, "first.tgz");
		const secondArchive = join(temporaryRoot, "second.tgz");
		createDeterministicTarball(first, firstArchive);
		createDeterministicTarball(second, secondArchive);
		assert.deepEqual(readFileSync(firstArchive), readFileSync(secondArchive));

		const gzipHeader = readFileSync(firstArchive).subarray(4, 10);
		assert.deepEqual([...gzipHeader], [0, 0, 0, 0, 2, 255]);
		const extracted = join(temporaryRoot, "extracted");
		mkdirSync(extracted);
		execFileSync("tar", ["-xzf", firstArchive, "-C", extracted]);
		assert.equal(
			readFileSync(join(extracted, "package/data.txt"), "utf8"),
			"data\n",
		);
		assert.equal(readlinkSync(join(extracted, "package/link.txt")), "data.txt");
		assert.equal(
			statSync(join(extracted, "package/run.sh")).mode & 0o111,
			0o111,
		);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}
});

function createFixture(directory, order) {
	mkdirSync(directory, { recursive: true });
	for (const entry of order) {
		if (entry === "nested") {
			const longDirectory = "a".repeat(90);
			mkdirSync(join(directory, longDirectory));
			writeFileSync(
				join(directory, longDirectory, "nested-file.txt"),
				"nested\n",
			);
		} else if (entry === "executable") {
			const executable = join(directory, "run.sh");
			writeFileSync(executable, "#!/bin/sh\nexit 0\n");
			chmodSync(executable, 0o755);
		} else if (entry === "data") {
			writeFileSync(join(directory, "data.txt"), "data\n");
		} else if (entry === "link") {
			symlinkSync("data.txt", join(directory, "link.txt"));
		}
	}
}
