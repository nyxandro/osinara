/**
 * Service skills of the release.
 *
 * Constructs covered:
 * - A service skill is given where its tool is in the turn's surface, and only in its own trust zones.
 * - Every service name is reserved against family skills.
 */
import { describe, expect, it } from "vitest";

import { isServiceSkillName, isServiceSkillOf, serviceSkillsFor } from "./service-skills.js";

const names = (skills: Readonly<Record<string, unknown>>) => Object.keys(skills).sort();

describe("service skills", () => {
  it("gives a private chat the procedure skill of every tool it has", () => {
    const tools = new Set(["manage_skill", "manage_reminder", "manage_agent_schedule", "send_voice_message", "manage_telegram_group"]);

    expect(names(serviceSkillsFor("private", tools))).toEqual(["group-admin", "schedules", "skill-manager", "voice-replies"]);
  });

  it("gives the delegation procedure wherever the turn can delegate", () => {
    for (const environment of ["private", "family", "external"] as const) {
      expect(serviceSkillsFor(environment, new Set(["agent"]))).toHaveProperty("delegation");
    }
  });

  it("follows the surface: a turn without a tool gets no skill for it", () => {
    expect(names(serviceSkillsFor("private", new Set(["manage_reminder"])))).toEqual(["schedules"]);
    expect(serviceSkillsFor("private", new Set(["web_search"]))).toEqual({});
  });

  it("keeps each trust zone to its own procedures", () => {
    expect(names(serviceSkillsFor("family", new Set(["manage_reminder", "manage_agent_schedule", "send_voice_message"]))))
      .toEqual(["schedules", "voice-replies"]);
    // The same tool names in an external group get the group's own reminder procedure, never the
    // family's scenarios, administration or skill library.
    expect(names(serviceSkillsFor("external", new Set(["manage_reminder", "send_voice_message", "manage_skill", "manage_telegram_group"]))))
      .toEqual(["group-reminders", "voice-replies"]);
    expect(serviceSkillsFor("external", new Set())).toEqual({});
  });

  it("loads every package with a trigger description and a body", () => {
    const all = serviceSkillsFor("private", new Set(["manage_skill", "manage_reminder", "send_voice_message", "manage_telegram_group"]));
    const group = serviceSkillsFor("external", new Set(["manage_reminder"]));
    for (const skill of [...Object.values(all), ...Object.values(group)]) {
      expect(skill.description).toMatch(/\bLoad\b/u);
      expect(skill.markdown.length).toBeGreaterThan(200);
    }
  });

  it("reserves every service name", () => {
    for (const name of ["skill-manager", "schedules", "group-reminders", "voice-replies", "group-admin", "delegation"]) {
      expect(isServiceSkillName(name)).toBe(true);
    }
    expect(isServiceSkillName("weather")).toBe(false);
    expect(isServiceSkillOf("external", "group-reminders")).toBe(true);
    expect(isServiceSkillOf("external", "schedules")).toBe(false);
  });
});
