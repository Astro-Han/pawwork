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
  {
    // The bundled DSH plugins. They are plain JavaScript, shipped verbatim into
    // the product home and loaded by the sidecar and the renderer, so nothing
    // else looks at them: they are outside `tsconfig.json`, and until this block
    // existed the lint script walked them under an empty rule set and always
    // passed. The typed rules above need a program these files are not part of,
    // so this is the untyped subset that still finds real defects.
    name: "pawwork/bundled-plugin-js-bug-rules",
    files: ["packages/desktop-electron/resources/**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
    },
    linterOptions: {
      reportUnusedDisableDirectives: "error",
    },
    rules: {
      "no-constant-binary-expression": "error",
      "no-unsafe-optional-chaining": "error",
      "no-dupe-class-members": "error",
      "no-dupe-keys": "error",
      "no-fallthrough": "error",
      "no-self-compare": "error",
      "no-unreachable": "error",
      "no-unused-private-class-members": "error",
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
])
