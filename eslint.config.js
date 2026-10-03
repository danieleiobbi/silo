import js from "@eslint/js"
import tseslint from "typescript-eslint"
import hooks from "eslint-plugin-react-hooks"
export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**"] },
  {
    files: ["**/*.ts", "**/*.tsx"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] }
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": hooks },
    rules: { "react-hooks/rules-of-hooks": "error", "react-hooks/exhaustive-deps": "warn" }
  }
)
