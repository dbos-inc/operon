const { FlatCompat } = require("@eslint/eslintrc");
const typescriptEslint = require("typescript-eslint");
const typescriptEslintPlugin = require("@typescript-eslint/eslint-plugin");
const typescriptEslintParser = require("@typescript-eslint/parser");
const globals = require("globals");
const js = require("@eslint/js");

const compat = new FlatCompat({
    baseDirectory: __dirname,
    recommendedConfig: js.configs.recommended
});

module.exports = typescriptEslint.config(
  {
    ignores: [
      "**/dist/",
      "knexfile.ts", // TODO: should this still be used if there are no files with this name in the project?
      "**/migrations/*",
      "examples/", // TODO: same here?
      "packages/create/templates/"
    ]
  },

  {
    files: ["**/*.ts"],

    extends: compat.extends("plugin:@typescript-eslint/recommended", "plugin:@typescript-eslint/recommended-type-checked"),
    plugins: { "@typescript-eslint": typescriptEslintPlugin },

    languageOptions: {
        parser: typescriptEslintParser,
        parserOptions: { project: "./tsconfig.json" },
        globals: { ...globals.node }
    },

    rules: {
      "@typescript-eslint/indent": "off",
      "@typescript-eslint/unbound-method": ["error", { ignoreStatic: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrors: "none" }],
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }]
    }
  }
);
