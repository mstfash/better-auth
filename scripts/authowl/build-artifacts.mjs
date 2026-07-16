import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDeterministicTarball } from "./deterministic-tar.mjs";

const REQUIRED_NODE = "24.14.0";
const REQUIRED_PNPM = "11.1.1";
const MAIN_REPOSITORY = "https://github.com/mstfash/better-auth.git";
const UTILS_REPOSITORY = "https://github.com/mstfash/utils.git";

const packages = [
	["better-auth", "packages/better-auth"],
	["@better-auth/core", "packages/core"],
	["@better-auth/drizzle-adapter", "packages/drizzle-adapter"],
	["@better-auth/kysely-adapter", "packages/kysely-adapter"],
	["@better-auth/memory-adapter", "packages/memory-adapter"],
	["@better-auth/mongo-adapter", "packages/mongo-adapter"],
	["@better-auth/oauth-provider", "packages/oauth-provider"],
	["@better-auth/passkey", "packages/passkey"],
	["@better-auth/prisma-adapter", "packages/prisma-adapter"],
	["@better-auth/telemetry", "packages/telemetry"],
];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readArguments() {
	const options = {
		utilsDirectory: resolve(root, "../better-auth-utils"),
		outputDirectory: resolve(root, "artifacts/authowl"),
		allowDirty: false,
	};

	for (let index = 2; index < process.argv.length; index += 1) {
		const argument = process.argv[index];
		if (argument === "--utils-dir") {
			options.utilsDirectory = resolve(process.argv[++index] ?? "");
		} else if (argument === "--output") {
			options.outputDirectory = resolve(process.argv[++index] ?? "");
		} else if (argument === "--allow-dirty") {
			options.allowDirty = true;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	return options;
}

function run(command, args, cwd, capture = false) {
	const result = execFileSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
	});
	return capture ? result.trim() : "";
}

function assertVersion(actual, expected, tool) {
	if (actual !== expected) {
		throw new Error(`${tool} ${expected} is required, received ${actual}`);
	}
}

function gitValue(directory, args) {
	return run("git", args, directory, true);
}

function assertClean(directory) {
	const changes = gitValue(directory, [
		"status",
		"--porcelain",
		"--untracked-files=no",
	]);
	if (changes) {
		throw new Error(`Release source must be clean: ${directory}\n${changes}`);
	}
}

function sha256(path) {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sortedRecord(record) {
	return Object.fromEntries(
		Object.entries(record).sort(([left], [right]) => left.localeCompare(right)),
	);
}

function normalizeManifest(path) {
	const manifest = JSON.parse(readFileSync(path, "utf8"));
	for (const field of [
		"dependencies",
		"devDependencies",
		"optionalDependencies",
		"peerDependencies",
	]) {
		if (manifest[field]) manifest[field] = sortedRecord(manifest[field]);
	}
	writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

function onlyTarball(directory) {
	const tarballs = readdirSync(directory).filter((file) =>
		file.endsWith(".tgz"),
	);
	if (tarballs.length !== 1) {
		throw new Error(
			`Expected one tarball in ${directory}, found ${tarballs.length}`,
		);
	}
	return join(directory, tarballs[0]);
}

function packPackage(
	sourceDirectory,
	expectedName,
	outputDirectory,
	temporaryRoot,
) {
	const rawDirectory = join(
		temporaryRoot,
		`${expectedName.replaceAll("/", "-")}-raw`,
	);
	const extractedDirectory = join(
		temporaryRoot,
		`${expectedName.replaceAll("/", "-")}-extracted`,
	);
	mkdirSync(rawDirectory, { recursive: true });
	mkdirSync(extractedDirectory, { recursive: true });
	run(
		"pnpm",
		["--dir", sourceDirectory, "pack", "--pack-destination", rawDirectory],
		root,
		true,
	);
	run(
		"tar",
		["-xzf", onlyTarball(rawDirectory), "-C", extractedDirectory],
		root,
	);

	const stagedPackage = join(extractedDirectory, "package");
	const manifestPath = join(stagedPackage, "package.json");
	const manifest = normalizeManifest(manifestPath);
	if (manifest.name !== expectedName) {
		throw new Error(`Expected ${expectedName}, packed ${manifest.name}`);
	}
	if (/\b(?:workspace|catalog):/.test(readFileSync(manifestPath, "utf8"))) {
		throw new Error(`Unresolved workspace dependency in ${expectedName}`);
	}

	const tarballName = `${manifest.name.replace(/^@/, "").replaceAll("/", "-")}-${manifest.version}.tgz`;
	const destination = join(outputDirectory, tarballName);
	createDeterministicTarball(stagedPackage, destination);

	return {
		name: manifest.name,
		version: manifest.version,
		file: basename(destination),
		sha256: sha256(destination),
	};
}

function buildSources(utilsDirectory) {
	run("pnpm", ["install", "--frozen-lockfile"], utilsDirectory);
	run("pnpm", ["build"], utilsDirectory);

	const filters = packages.flatMap(([name]) => ["--filter", `${name}...`]);
	run("pnpm", ["install", "--frozen-lockfile", ...filters], root);
	run("pnpm", ["exec", "turbo", "build", ...filters], root);
}

function main() {
	const options = readArguments();
	const utilsDirectory = realpathSync(options.utilsDirectory);
	assertVersion(process.versions.node, REQUIRED_NODE, "Node.js");
	assertVersion(run("pnpm", ["--version"], root, true), REQUIRED_PNPM, "pnpm");
	if (!options.allowDirty) {
		assertClean(root);
		assertClean(utilsDirectory);
	}

	buildSources(utilsDirectory);
	rmSync(options.outputDirectory, { recursive: true, force: true });
	mkdirSync(options.outputDirectory, { recursive: true });
	const temporaryRoot = mkdtempSync(join(tmpdir(), "authowl-artifacts-"));

	try {
		const artifacts = [
			...packages.map(([name, path]) =>
				packPackage(
					join(root, path),
					name,
					options.outputDirectory,
					temporaryRoot,
				),
			),
			packPackage(
				utilsDirectory,
				"@better-auth/utils",
				options.outputDirectory,
				temporaryRoot,
			),
		].sort((left, right) => left.name.localeCompare(right.name));

		const manifest = {
			schemaVersion: 1,
			build: { node: REQUIRED_NODE, pnpm: REQUIRED_PNPM },
			sources: {
				betterAuth: {
					repository: MAIN_REPOSITORY,
					commit: gitValue(root, ["rev-parse", "HEAD"]),
					baseTag: gitValue(root, [
						"describe",
						"--tags",
						"--match",
						"v*",
						"--abbrev=0",
					]),
				},
				utils: {
					repository: UTILS_REPOSITORY,
					commit: gitValue(utilsDirectory, ["rev-parse", "HEAD"]),
					baseTag: gitValue(utilsDirectory, [
						"describe",
						"--tags",
						"--match",
						"v*",
						"--abbrev=0",
					]),
				},
			},
			artifacts,
		};
		writeFileSync(
			join(options.outputDirectory, "manifest.json"),
			`${JSON.stringify(manifest, null, 2)}\n`,
		);
		writeFileSync(
			join(options.outputDirectory, "SHA256SUMS"),
			`${artifacts.map(({ sha256: digest, file }) => `${digest}  ${file}`).join("\n")}\n`,
		);
	} finally {
		rmSync(temporaryRoot, { recursive: true, force: true });
	}

	console.log(`Wrote reproducible artifacts to ${options.outputDirectory}`);
}

main();
