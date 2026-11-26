import assert from "node:assert/strict";
import test from "node:test";
import { parseListingText } from "../core/matcher.mjs";

test("Dutch 'not suitable for students' means students are not allowed", () => {
  for (const text of [
    "Mooi appartement in Delft. Niet geschikt voor studenten. Huur €1.200 per maand.",
    "Kamer te huur, niet bedoeld voor studenten.",
    "Studio, studenten zijn niet welkom.",
    "Nice flat, not for students.",
  ]) {
    assert.equal(parseListingText(text).student_allowed, false, text);
  }
});

test("Positive student wording still reads as allowed", () => {
  assert.equal(parseListingText("Kamer in Delft, geschikt voor studenten.").student_allowed, true);
  assert.equal(parseListingText("Room for students near TU Delft, students welcome.").student_allowed, true);
});
