import { describe, expect, test } from "bun:test"
import { isSystemTextPrompt } from "../../src/algorithm/classifier.ts"

describe("isSystemTextPrompt — the classifier verbatim port", () => {
  test("matches <task-notification>", () => {
    expect(isSystemTextPrompt("<task-notification>foo")).toBe(true)
  })
  test("matches <system-reminder>", () => {
    expect(isSystemTextPrompt("<system-reminder>x</system-reminder>")).toBe(
      true,
    )
  })
  test("matches 'This session is being continued from a previous conversation'", () => {
    expect(
      isSystemTextPrompt(
        "This session is being continued from a previous conversation",
      ),
    ).toBe(true)
  })
  test("matches 'Please continue the conversation'", () => {
    expect(isSystemTextPrompt("Please continue the conversation")).toBe(true)
  })
  test("matches 'Note:.*was read before'", () => {
    expect(isSystemTextPrompt("Note: foo was read before")).toBe(true)
  })

  test("ignores leading whitespace via prompt.trim()", () => {
    expect(isSystemTextPrompt(" <system-reminder>x")).toBe(true)
  })

  test("does NOT match prompt that mentions <system-reminder> mid-text", () => {
    expect(
      isSystemTextPrompt("explain how the <system-reminder> tag works"),
    ).toBe(false)
  })
  test("does NOT match a normal user prompt", () => {
    expect(isSystemTextPrompt("implement OAuth refresh flow")).toBe(false)
    expect(isSystemTextPrompt("thanks")).toBe(false)
    expect(isSystemTextPrompt("/e3 do the migration")).toBe(false)
  })
  test("case-insensitive (uses /i flag)", () => {
    expect(isSystemTextPrompt("<SYSTEM-REMINDER>x")).toBe(true)
    expect(isSystemTextPrompt("please continue the conversation")).toBe(true)
  })
})
