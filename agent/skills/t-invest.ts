/**
 * Scope-aware dynamic T-Invest skill.
 *
 * Exports:
 * - `T_INVEST_SCOPE_POLICY`: personal/family-only capability flag.
 * - Dynamic `t-invest` skill resolver with scope-bound HOME and bundled CLI assets.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { defineDynamic, defineSkill } from "eve/skills";

import {
  defineSkillScopePolicy,
  resolveAllowedSkillScope,
  type TrustedSkillScope,
} from "../lib/skills/skill-scope-policy.js";

const T_INVEST_DESCRIPTION = "Access the current personal or family Т-Инвестиции / Тинькофф / T-Invest account through the bundled CLI for portfolio, positions, cash, quotes and prices, operations, dividends, commissions, yield and returns, bonds, stocks, funds, screeners, and explicitly confirmed trades. Use for the user's brokerage account or a ticker such as SBER or GAZP.";
const T_INVEST_PACKAGE_ROOT = resolve("resources/skills/t-invest");
const T_INVEST_INSTRUCTIONS = readFileSync(resolve(T_INVEST_PACKAGE_ROOT, "instructions.txt"), "utf8");
const T_INVEST_FILES = Object.freeze({
  "references/json-fields.md": readFileSync(
    resolve(T_INVEST_PACKAGE_ROOT, "references/json-fields.txt"),
    "utf8",
  ),
  "scripts/tinvest.cjs": readFileSync(resolve(T_INVEST_PACKAGE_ROOT, "scripts/tinvest.cjs"), "utf8"),
});

export const T_INVEST_SCOPE_POLICY = defineSkillScopePolicy({
  allowedScopes: ["personal", "family"],
});

function runtimeScopeInstructions(scope: TrustedSkillScope): string {
  // The model may manage this skill's token, but only inside the HOME selected by verified auth.
  return [
    "<skill_runtime_scope>",
    `scope: ${scope}`,
    "`$HOME` уже указывает на постоянное окружение этой области.",
    "Все настройки, токены, состояние и кэши T-Invest храни только под текущим `$HOME`.",
    "Не читай и не записывай T-Invest файлы за пределами текущего `$HOME`, включая соседние `/tools/*`.",
    "Основной файл токенов: `$HOME/.config/tinvest/.env`.",
    "</skill_runtime_scope>",
  ].join("\n");
}

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => {
      const scope = resolveAllowedSkillScope(ctx.session.auth, T_INVEST_SCOPE_POLICY);
      if (!scope) return null;

      // Dynamic materialization keeps the package absent from every untrusted group sandbox.
      return defineSkill({
        description: T_INVEST_DESCRIPTION,
        files: T_INVEST_FILES,
        markdown: `${runtimeScopeInstructions(scope)}\n\n${T_INVEST_INSTRUCTIONS}`,
        metadata: {
          "osinara.allowed-scopes": T_INVEST_SCOPE_POLICY.allowedScopes.join(","),
          "osinara.runtime-scope": scope,
        },
      });
    },
  },
});
