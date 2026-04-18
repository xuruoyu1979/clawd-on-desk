const { describe, it } = require("node:test");
const assert = require("node:assert");

const {
  normalizePermissionSuggestions,
  normalizeElicitationToolInput,
} = require("../src/server").__test;

describe("permission input normalization", () => {
  it("caps suggestions at 20 and preserves a merged addRules entry", () => {
    const rawSuggestions = [
      ...Array.from({ length: 24 }, (_, index) => ({ type: "setMode", mode: `mode-${index}` })),
      { type: "addRules", destination: "localSettings", behavior: "allow", toolName: "Read", ruleContent: "src/**" },
      { type: "addRules", destination: "localSettings", behavior: "allow", toolName: "Edit", ruleContent: "docs/**" },
    ];

    const normalized = normalizePermissionSuggestions(rawSuggestions);

    assert.strictEqual(normalized.length, 20);
    assert.strictEqual(normalized[normalized.length - 1].type, "addRules");
    assert.deepStrictEqual(normalized[normalized.length - 1].rules, [
      { toolName: "Read", ruleContent: "src/**" },
      { toolName: "Edit", ruleContent: "docs/**" },
    ]);
  });

  it("caps elicitation questions/options and truncates displayed copy", () => {
    const normalized = normalizeElicitationToolInput({
      mode: "prompt",
      questions: Array.from({ length: 7 }, (_, questionIndex) => ({
        header: `Header ${questionIndex} ${"h".repeat(80)}`,
        question: `Question ${questionIndex} ${"q".repeat(260)}`,
        options: Array.from({ length: 7 }, (_, optionIndex) => ({
          label: `Option ${optionIndex} ${"l".repeat(100)}`,
          description: `Description ${optionIndex} ${"d".repeat(200)}`,
        })),
      })),
    });

    assert.strictEqual(normalized.questions.length, 5);
    assert.strictEqual(normalized.questions[0].options.length, 5);
    assert.strictEqual(normalized.questions[0].header.endsWith("…"), true);
    assert.strictEqual(normalized.questions[0].question.endsWith("…"), true);
    assert.strictEqual(normalized.questions[0].options[0].label.length, 80);
    assert.strictEqual(normalized.questions[0].options[0].description.length, 160);
  });
});
