/**
 * The owner's card for a change to one of the family's own skills.
 *
 * Export:
 * - `skillApprovalPrompt`: the text of the card for `manage_skill` activate, enable, disable and
 *   delete, built from the stored skill the button will act on.
 *
 * For a version to start working the card shows what that version is: its description, whether
 * the agent wrote it or it was downloaded (and from where), and every file with its size, scripts
 * marked. Everything in a skill package is untrusted text, so every line goes through the same
 * sanitizing as other approval facts.
 */
import { AppError } from "../app-error.js";
import type { FamilySkillSummary, FamilySkillVersion } from "../family-skills/family-skill-repository.js";
import type { ManageSkillInput } from "../tools/manage_skill.js";
import { approvalFact, buildApprovalMessage, sanitizeApprovalLine } from "./approval-message.js";

type ConfirmedAction = Exclude<ManageSkillInput, { readonly action: "list" | "stage" | "view" }>;

const KIB = 1024;

function byteSize(bytes: number): string {
  if (bytes < KIB) return `${bytes} Б`;
  const [value, unit] = bytes < KIB * KIB ? [bytes / KIB, "КБ"] : [bytes / KIB / KIB, "МБ"];
  return `${value.toFixed(1).replace(".", ",")} ${unit}`;
}

function versionFacts(version: FamilySkillVersion): { facts: string[]; files: string[] } {
  return {
    facts: [
      ...approvalFact("Описание", version.description),
      ...approvalFact("Источник", version.origin.kind === "downloaded" ? `скачан с ${version.origin.url}` : "написан агентом"),
    ],
    files: [
      "SKILL.md — инструкции скилла",
      ...version.files.map((file) => sanitizeApprovalLine(`${file.path} — ${byteSize(file.size)}${file.executable ? ", скрипт" : ""}`)),
    ],
  };
}

export function skillApprovalPrompt(
  input: ConfirmedAction,
  skill: { readonly summary: FamilySkillSummary; readonly versions: readonly FamilySkillVersion[] },
): string {
  const { summary } = skill;
  const name = approvalFact("Скилл", input.name);
  if (input.action === "activate") {
    const version = skill.versions.find((candidate) => candidate.version === input.version);
    if (version === undefined) {
      throw new AppError("AGENT_SKILL_VERSION_NOT_FOUND", `У скилла ${input.name} нет версии ${input.version}`, {
        details: { name: input.name, version: input.version },
      });
    }
    const active = summary.activeVersion;
    // A disabled skill is not working: confirming a version also turns it back on.
    const working = summary.enabled && active !== null;
    const { facts, files } = versionFacts(version);
    return buildApprovalMessage({
      actionLabel: active === null
        ? "включение нового скилла семьи"
        : working ? "смена работающей версии скилла семьи" : "включение выключенного скилла семьи с выбранной версией",
      facts: [
        ...name,
        `Версия: ${input.version}${working && active !== input.version ? `, сейчас работает версия ${active}` : ""}`,
        ...facts,
      ],
      section: { lines: files, title: "Файлы:" },
      consequence: [
        working
          ? "Эта версия заработает со следующего сообщения вместо текущей. Прежние версии сохранятся, к ним можно вернуться."
          : active === null
            ? "Скилл заработает со следующего сообщения в личном и семейных чатах."
            : "Скилл снова заработает со следующего сообщения в личном и семейных чатах и во внешних группах, где он есть в списке скиллов.",
        "Скрипты скилла выполняются только в изолированном окружении.",
        ...(active === null ? ["Во внешнюю группу скилл попадёт, только если вы добавите его в её список скиллов."] : []),
      ].join(" "),
    });
  }
  if (input.action === "enable") {
    const version = skill.versions.find((candidate) => candidate.version === summary.activeVersion);
    return buildApprovalMessage({
      actionLabel: "включение скилла семьи",
      facts: [...name, ...(summary.activeVersion === null ? [] : [`Версия: ${summary.activeVersion}`]),
        ...(version === undefined ? [] : versionFacts(version).facts)],
      consequence: "Скилл снова заработает со следующего сообщения в личном и семейных чатах и во внешних группах, где он есть в списке скиллов.",
    });
  }
  if (input.action === "disable") {
    return buildApprovalMessage({
      actionLabel: "выключение скилла семьи",
      facts: name,
      consequence: "Скилл перестанет работать со следующего сообщения во всех чатах, включая внешние группы. Его версии сохранятся, включить его можно снова.",
    });
  }
  return buildApprovalMessage({
    actionLabel: "удаление скилла семьи",
    facts: [...name, `Сохранённых версий: ${skill.versions.length}`],
    consequence: "Скилл и все его версии будут удалены безвозвратно. Внешние группы перестанут его получать, остальные их скиллы не изменятся.",
  });
}
