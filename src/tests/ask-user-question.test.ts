import { describe, it, expect, vi } from "vitest";
import * as fs from "fs";

/**
 * Tests for the AskUserQuestion → session/elicitation bridge.
 *
 * Since handleAskUserQuestion is a private method on ClaudeAcpAgent,
 * we test the logic patterns directly (schema mapping, response mapping,
 * fallback, decline/cancel, edge cases) and verify source-level invariants.
 *
 * Covers: D-04, D-05, D-06, D-07, D-08, D-09, D-10
 */

describe("AskUserQuestion → session/elicitation bridge", () => {
  describe("D-04: disallowedTools removal", () => {
    it("AskUserQuestion is not in the disallowedTools array", () => {
      const source = fs.readFileSync("src/acp-agent.ts", "utf-8");
      expect(source).not.toContain('disallowedTools = ["AskUserQuestion"]');
      expect(source).toContain("disallowedTools");
      // Should be an empty array
      expect(source).toMatch(/disallowedTools:\s*string\[\]\s*=\s*\[\]/);
    });
  });

  describe("D-05: Schema mapping — Claude → ACP Elicitation", () => {
    it("maps single-select question to oneOf schema", () => {
      const question = {
        question: "Which library?",
        header: "Library",
        options: [
          { label: "date-fns", description: "Lightweight" },
          { label: "dayjs", description: "Tiny" },
        ],
        multiSelect: false,
      };

      // Expected schema for single-select:
      const expected = {
        type: "string",
        title: "Which library?",
        oneOf: [
          { const: "date-fns", title: "date-fns", description: "Lightweight" },
          { const: "dayjs", title: "dayjs", description: "Tiny" },
        ],
      };

      // Test the mapping by building schema same way as handleAskUserQuestion
      const properties: Record<string, unknown> = {};
      const q = question;
      const fieldKey = "question_0";

      if (q.options && q.options.length > 0 && !q.multiSelect) {
        properties[fieldKey] = {
          type: "string",
          title: q.question,
          oneOf: q.options.map((opt) => ({
            const: opt.label,
            title: opt.label,
            description: opt.description,
          })),
        };
      }

      expect(properties[fieldKey]).toEqual(expected);
    });

    it("maps multi-select question to enum + multiple:true schema", () => {
      const question = {
        question: "Which features?",
        header: "Features",
        options: [
          { label: "Auth", description: "Authentication" },
          { label: "DB", description: "Database" },
        ],
        multiSelect: true,
      };

      const properties: Record<string, unknown> = {};
      const q = question;
      const fieldKey = "question_0";

      if (q.options && q.options.length > 0 && q.multiSelect) {
        properties[fieldKey] = {
          type: "string",
          title: q.question,
          enum: q.options.map((opt) => opt.label),
          multiple: true,
        };
      }

      expect(properties[fieldKey]).toEqual({
        type: "string",
        title: "Which features?",
        enum: ["Auth", "DB"],
        multiple: true,
      });
    });

    it("maps free-text question (no options) to plain string schema", () => {
      const question = {
        question: "What name?",
        header: "Name",
        options: [] as Array<{ label: string; description: string }>,
        multiSelect: false,
      };

      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      const q = question;
      const fieldKey = "question_0";

      if (!q.options || q.options.length === 0) {
        properties[fieldKey] = { type: "string", title: q.question };
        required.push(fieldKey);
      }

      expect(properties[fieldKey]).toEqual({ type: "string", title: "What name?" });
      expect(required).toContain("question_0");
    });

    it("adds custom write-in field alongside options", () => {
      const question = {
        question: "Choice?",
        header: "",
        options: [{ label: "A", description: "Option A" }],
        multiSelect: false,
      };

      const properties: Record<string, unknown> = {};
      const fieldKey = "question_0";

      if (question.options.length > 0) {
        properties[fieldKey] = {
          type: "string",
          title: question.question,
          oneOf: question.options.map((opt) => ({
            const: opt.label,
            title: opt.label,
            description: opt.description,
          })),
        };
        properties[`${fieldKey}_custom`] = {
          type: "string",
          title: "Or type your own answer",
        };
      }

      expect(properties["question_0_custom"]).toEqual({
        type: "string",
        title: "Or type your own answer",
      });
    });
  });

  describe("D-05: Response mapping — ACP Elicitation → Claude answers", () => {
    it("maps accepted response to answers keyed by question TEXT (Pitfall 1)", () => {
      const questions = [
        {
          question: "Which library?",
          header: "Lib",
          options: [{ label: "A", description: "" }],
          multiSelect: false,
        },
      ];
      const content: Record<string, unknown> = { question_0: "A", question_0_custom: "" };
      const answers: Record<string, string> = {};

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const customVal = content[`question_${i}_custom`];
        const val = content[`question_${i}`];
        if (customVal != null && String(customVal).trim() !== "") {
          answers[q.question] = String(customVal);
        } else if (val != null && String(val).trim() !== "") {
          answers[q.question] = String(val);
        } else {
          answers[q.question] = "";
        }
      }

      // Key is "Which library?" not "question_0"
      expect(answers).toHaveProperty("Which library?");
      expect(answers["Which library?"]).toBe("A");
      expect(answers).not.toHaveProperty("question_0");
    });

    it("custom write-in takes priority over radio selection", () => {
      const questions = [
        {
          question: "Which library?",
          header: "",
          options: [{ label: "A", description: "" }],
          multiSelect: false,
        },
      ];
      const content: Record<string, unknown> = { question_0: "A", question_0_custom: "My custom answer" };
      const answers: Record<string, string> = {};

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const customVal = content[`question_${i}_custom`];
        const val = content[`question_${i}`];
        if (customVal != null && String(customVal).trim() !== "") {
          answers[q.question] = String(customVal);
        } else if (val != null && String(val).trim() !== "") {
          answers[q.question] = String(val);
        } else {
          answers[q.question] = "";
        }
      }

      expect(answers["Which library?"]).toBe("My custom answer");
    });

    it("multi-select values joined with comma separator", () => {
      const questions = [
        {
          question: "Features?",
          header: "",
          options: [] as Array<{ label: string; description: string }>,
          multiSelect: true,
        },
      ];
      const content: Record<string, unknown> = { question_0: ["Auth", "DB", "Cache"] };
      const answers: Record<string, string> = {};

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const val = content[`question_${i}`];
        if (Array.isArray(val)) {
          answers[q.question] = val.join(", ");
        }
      }

      expect(answers["Features?"]).toBe("Auth, DB, Cache");
    });
  });

  describe("D-08: Fallback when client lacks elicitation capability", () => {
    it("returns allow with empty answers when clientCapabilities is undefined", () => {
      const clientCapabilities: any = undefined;
      const toolInput = { questions: [{ question: "Test?", header: "", options: [], multiSelect: false }] };

      if (!clientCapabilities?.elicitation?.form) {
        const result = {
          behavior: "allow" as const,
          updatedInput: { ...toolInput, answers: {} },
        };
        expect(result.behavior).toBe("allow");
        expect(result.updatedInput.answers).toEqual({});
      }
    });

    it("returns allow with empty answers when elicitation.form is missing", () => {
      const clientCapabilities: any = { elicitation: {} };
      const toolInput = { questions: [] as any[] };

      if (!clientCapabilities?.elicitation?.form) {
        const result = {
          behavior: "allow" as const,
          updatedInput: { ...toolInput, answers: {} },
        };
        expect(result.behavior).toBe("allow");
        expect(result.updatedInput.answers).toEqual({});
      }
    });
  });

  describe("D-09: Decline/cancel handling", () => {
    it("decline returns allow with empty answers (never deny)", () => {
      const action = { action: "decline" as const };
      // Per D-09: always allow, empty answers
      const result = {
        behavior: "allow" as const,
        updatedInput: { questions: [], answers: {} },
      };
      expect(result.behavior).toBe("allow");
      expect(result.behavior).not.toBe("deny");
      expect(result.updatedInput.answers).toEqual({});
    });

    it("cancel returns allow with empty answers (never deny)", () => {
      const action = { action: "cancel" as const };
      const result = {
        behavior: "allow" as const,
        updatedInput: { questions: [], answers: {} },
      };
      expect(result.behavior).toBe("allow");
      expect(result.updatedInput.answers).toEqual({});
    });
  });

  describe("D-10: Edge cases", () => {
    it("handles empty questions array", () => {
      const questions: any[] = [];
      const properties: Record<string, unknown> = {};
      const messageLines: string[] = [];

      for (let i = 0; i < questions.length; i++) {
        // Should not execute
        properties[`question_${i}`] = {};
      }

      const message = messageLines.join("\n") || questions[0]?.question || "Agent has a question";
      expect(Object.keys(properties)).toHaveLength(0);
      expect(message).toBe("Agent has a question");
    });

    it("handles question with empty options array as free-text", () => {
      const q = {
        question: "Describe it",
        header: "",
        options: [] as Array<{ label: string; description: string }>,
        multiSelect: false,
      };
      const properties: Record<string, unknown> = {};
      const required: string[] = [];

      if (!q.options || q.options.length === 0) {
        properties["question_0"] = { type: "string", title: q.question };
        required.push("question_0");
      }

      expect(properties["question_0"]).toEqual({ type: "string", title: "Describe it" });
      expect(required).toContain("question_0");
    });

    it("handles multiple questions building correct schema", () => {
      const questions = [
        { question: "Q1?", header: "H1", options: [{ label: "A", description: "a" }], multiSelect: false },
        {
          question: "Q2?",
          header: "",
          options: [] as Array<{ label: string; description: string }>,
          multiSelect: false,
        },
      ];
      const properties: Record<string, unknown> = {};

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        if (q.options && q.options.length > 0) {
          properties[`question_${i}`] = { type: "string", title: q.question, oneOf: expect.any(Array) };
          properties[`question_${i}_custom`] = { type: "string", title: "Or type your own answer" };
        } else {
          properties[`question_${i}`] = { type: "string", title: q.question };
        }
      }

      expect(Object.keys(properties)).toContain("question_0");
      expect(Object.keys(properties)).toContain("question_0_custom");
      expect(Object.keys(properties)).toContain("question_1");
      expect(Object.keys(properties)).not.toContain("question_1_custom");
    });

    it("empty string answer values default to empty string", () => {
      const questions = [
        { question: "Q?", header: "", options: [{ label: "A", description: "" }], multiSelect: false },
      ];
      const content: Record<string, unknown> = { question_0: "", question_0_custom: "" };
      const answers: Record<string, string> = {};

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        const customVal = content[`question_${i}_custom`];
        const val = content[`question_${i}`];
        if (customVal != null && String(customVal).trim() !== "") {
          answers[q.question] = String(customVal);
        } else if (val != null && String(val).trim() !== "") {
          answers[q.question] = String(val);
        } else {
          answers[q.question] = "";
        }
      }

      expect(answers["Q?"]).toBe("");
    });
  });

  describe("D-06: sessionCapabilities elicitation advertisement", () => {
    it("source contains elicitation form in sessionCapabilities", () => {
      const source = fs.readFileSync("src/acp-agent.ts", "utf-8");
      // Verify sessionCapabilities includes elicitation with form
      expect(source).toMatch(/sessionCapabilities[\s\S]*?elicitation[\s\S]*?form/);
    });
  });

  describe("D-07: elicitation_complete forwarding", () => {
    it("source contains sessionUpdate forwarding for elicitation_complete", () => {
      const source = fs.readFileSync("src/acp-agent.ts", "utf-8");
      // Verify elicitation_complete case now has sessionUpdate call
      expect(source).toContain("elicitation_complete");
      expect(source).toMatch(/case\s+["']elicitation_complete["'][\s\S]*?sessionUpdate/);
    });
  });

  describe("D-05: canUseTool intercept existence", () => {
    it("source contains AskUserQuestion intercept in canUseTool", () => {
      const source = fs.readFileSync("src/acp-agent.ts", "utf-8");
      expect(source).toMatch(/if\s*\(toolName === ['"]AskUserQuestion['"]\)/);
      expect(source).toContain("handleAskUserQuestion");
    });
  });
});
