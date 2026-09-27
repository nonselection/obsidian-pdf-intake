import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	{
		ignores: ["main.js", "node_modules/**", "dist/**", "coverage/**", "package-lock.json"],
	},
	eslint.configs.recommended,
	...tseslint.configs.recommendedTypeChecked.map((config) => ({
		...config,
		files: ["**/*.ts"],
	})),
	{
		files: ["**/*.ts"],
		languageOptions: {
			parserOptions: {
				projectService: true,
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			"@typescript-eslint/no-floating-promises": "error",
			"@typescript-eslint/no-misused-promises": "error",
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
			],
		},
	},
	{
		files: ["esbuild.config.mjs", "eslint.config.mjs", "scripts/**/*.mjs"],
		languageOptions: {
			globals: { process: "readonly", console: "readonly" },
		},
	},
);
