import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2];
const targetVariables = {
	dev: "OBSIDIAN_DEV_VAULT",
	actual: "OBSIDIAN_ACTUAL_VAULT",
};

if (!Object.hasOwn(targetVariables, target)) {
	console.error("Usage: node scripts/deploy.mjs <dev|actual>");
	process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(repoRoot, ".env.local");

function parseEnv(contents) {
	const values = new Map();
	for (const line of contents.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
		if (!match) continue;
		let value = match[2];
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		} else {
			value = value.replace(/\s+#.*$/, "").trim();
		}
		values.set(match[1], value);
	}
	return values;
}

async function requireDirectory(directory, description) {
	let details;
	try {
		details = await stat(directory);
	} catch {
		throw new Error(`${description} does not exist: ${directory}`);
	}
	if (!details.isDirectory()) throw new Error(`${description} is not a directory: ${directory}`);
}

try {
	const env = parseEnv(await readFile(envPath, "utf8"));
	const variable = targetVariables[target];
	const vaultRoot = env.get(variable);
	if (!vaultRoot) throw new Error(`Missing ${variable} in .env.local`);
	if (!path.isAbsolute(vaultRoot)) throw new Error(`${variable} must be an absolute vault path`);

	await requireDirectory(vaultRoot, "Configured vault");
	await requireDirectory(path.join(vaultRoot, ".obsidian"), "Obsidian configuration directory");

	const artifacts = ["main.js", "manifest.json", "styles.css"];
	for (const required of artifacts.slice(0, 2)) {
		try {
			if (!(await stat(path.join(repoRoot, required))).isFile()) {
				throw new Error(`${required} is not a file`);
			}
		} catch {
			throw new Error(`Required build artifact is missing: ${required}`);
		}
	}

	const destination = path.join(vaultRoot, ".obsidian", "plugins", "pdf-intake");
	await mkdir(destination, { recursive: true });
	const copied = [];
	for (const artifact of artifacts) {
		const source = path.join(repoRoot, artifact);
		try {
			if (!(await stat(source)).isFile()) continue;
		} catch {
			if (artifact === "styles.css") continue;
			throw new Error(`Required build artifact is missing: ${artifact}`);
		}
		await copyFile(source, path.join(destination, artifact));
		copied.push(artifact);
	}

	console.log(`Deployed target: ${target}`);
	console.log(`Destination: ${destination}`);
	console.log(`Copied: ${copied.join(", ")}`);
} catch (error) {
	console.error(`Deployment failed: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
}
