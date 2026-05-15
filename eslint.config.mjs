import solid from "eslint-plugin-solid"
import tseslint from "typescript-eslint"
import path from "node:path"
import { fileURLToPath } from "node:url"

const rootDir = path.dirname(fileURLToPath(import.meta.url))

const productTs = [
  "packages/app/src/**/*.{ts,tsx}",
  "packages/ui/src/**/*.{ts,tsx}",
  "packages/desktop-electron/src/**/*.{ts,tsx}",
]

const solidTsx = [
  "packages/app/src/**/*.tsx",
  "packages/ui/src/**/*.tsx",
  "packages/desktop-electron/src/renderer/**/*.tsx",
]

export default tseslint.config([
  {
    name: "pawwork/global-ignores",
    ignores: [
      "**/node_modules/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/out/**",
      "**/.artifacts/**",
      "**/*.test.ts",
      "**/*.test.tsx",
      "**/*.spec.ts",
      "**/*.spec.tsx",
      "**/*.stories.*",
      "**/__fixtures__/**",
      "**/fixtures/**",
      "**/generated/**",
      "packages/app/src/sst-env.d.ts",
      "packages/ui/src/components/app-icons/types.ts",
      "packages/ui/src/components/file-icons/types.ts",
      "packages/ui/src/components/provider-icons/types.ts",
      "packages/ui/src/storybook/fixtures.ts",
      "packages/opencode/**",
      "packages/sdk/**",
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
  {
    name: "pawwork/solid-bug-rules",
    files: solidTsx,
    plugins: {
      solid,
    },
    rules: {
      "solid/jsx-no-duplicate-props": "error",
      "solid/jsx-no-script-url": "error",
      "solid/jsx-no-undef": "error",
      "solid/no-react-deps": "error",
      "solid/no-react-specific-props": "error",
    },
  },
])
