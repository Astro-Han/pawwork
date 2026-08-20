import tseslint from "typescript-eslint"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

// Everything the package typechecks, so a new script or test cannot land
// outside the lint boundary by default.
const productTs = [
  "packages/desktop-electron/src/**/*.ts",
  "packages/desktop-electron/scripts/**/*.ts",
  "packages/desktop-electron/*.ts",
]

export default tseslint.config([
  {
    name: "pawwork/global-ignores",
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/.artifacts/**",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.stories.*",
      "**/__fixtures__/**",
      "**/fixtures/**",
      "**/generated/**",
    ],
  },
  {
    name: "pawwork/product-ts-bug-rules",
    files: productTs,
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: rootDir,
      },
      ecmaVersion: "latest",
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-unsafe-optional-chaining": "error",
      "@typescript-eslint/switch-exhaustiveness-check": [
        "error",
        {
          allowDefaultCaseForExhaustiveSwitch: true,
          considerDefaultExhaustiveForUnions: false,
        },
      ],
      "@typescript-eslint/no-for-in-array": "error",
      "@typescript-eslint/no-array-delete": "error",
    },
  },
])
