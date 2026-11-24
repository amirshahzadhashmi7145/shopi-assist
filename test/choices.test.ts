import { describe, expect, it } from "vitest";

import {
  asksReturnReason,
  asksWhichOrder,
  asksYesOrNo,
  liftChoices,
} from "../app/assistant/choices";

describe("answers as buttons", () => {
  it("lifts a list of answers out of the question that offers them", () => {
    const reply = [
      "I can help with that! Could you please let me know which order you want to return and the reason for the return? Your options are:",
      "",
      "- changed my mind",
      "- not as described",
      "- **damaged or defective**",
      "- other",
      "",
      "Just let me know!",
    ].join("\n");

    expect(liftChoices(reply)).toEqual({
      // The announcement of the list and the closing pleasantry go with it.
      text: "I can help with that! Could you please let me know which order you want to return and the reason for the return?",
      choices: ["changed my mind", "not as described", "damaged or defective", "other"],
    });
  });

  it("takes one question at a time when a reply asks two", () => {
    const reply = [
      "Which order would you like to return? Here are your recent orders to choose from:",
      "",
      "1. #1012",
      "2. #1008",
      "",
      "Please also let me know why you want to return it. You can select from these reasons:",
      "",
      "- Changed my mind",
      "- Too big",
    ].join("\n");

    expect(liftChoices(reply)).toEqual({
      text: "Which order would you like to return?",
      choices: ["#1012", "#1008"],
    });
  });

  it("keeps what follows the list when it says something", () => {
    const reply = "Which size do you want?\n- Small\n- Large\n\nSmall fits riders under 160 cm, and Large fits everyone taller than that, as the store's notes say.";
    const lifted = liftChoices(reply)!;
    expect(lifted.choices).toEqual(["Small", "Large"]);
    expect(lifted.text).toBe(
      "Which size do you want?\n\nSmall fits riders under 160 cm, and Large fits everyone taller than that, as the store's notes say.",
    );
  });

  it("leaves lists that are not answers to a question", () => {
    // Products with prices: their cards are what the shopper picks from.
    expect(
      liftChoices("Which one would you like?\n- **Trail Mug** - $18.00\n- **Camp Kettle** - $45.00"),
    ).toBeNull();
    // Information, not a question.
    expect(liftChoices("We ship to these countries:\n- Canada\n- United States")).toBeNull();
    // Too long to be buttons, a single item, or no list at all.
    expect(
      liftChoices(
        "Which applies?\n- The item arrived damaged and the box was open when the courier handed it over\n- Other",
      ),
    ).toBeNull();
    expect(liftChoices("Which one?\n- Only this")).toBeNull();
    expect(liftChoices("How can I help you today?")).toBeNull();
    // More than a handful is a list to read, not buttons to press.
    expect(liftChoices(`Which one?\n${Array.from({ length: 9 }, (_, n) => `- Option ${n}`).join("\n")}`)).toBeNull();
    // A link is not an answer.
    expect(liftChoices("Which page?\n- [Shipping](https://x.example/a)\n- [Returns](https://x.example/b)")).toBeNull();
  });

  it("offers the same answer once", () => {
    expect(liftChoices("Pick one:\n- Yes\n- yes\n- No")!.choices).toEqual(["yes", "No"]);
  });

  it("knows a closing question that yes or no answers", () => {
    expect(asksYesOrNo("Order #1012 has not shipped yet, so it cannot be returned. Would you like to cancel it instead?")).toBe(true);
    expect(asksYesOrNo("Shall I go ahead?")).toBe(true);
    // Alternatives, open questions and statements are not yes-or-no.
    expect(asksYesOrNo("Would you like more details or to see other options?")).toBe(false);
    expect(asksYesOrNo("What is the reason for the return?")).toBe(false);
    expect(asksYesOrNo("Would you like to know how to reach them? Their page has the details.")).toBe(false);
    expect(asksYesOrNo("Your order is on its way.")).toBe(false);
  });

  it("knows when the shopper is asked which order they mean", () => {
    expect(asksWhichOrder("Could you please tell me which order you'd like to return?")).toBe(true);
    expect(asksWhichOrder("Sure. What is the order number?")).toBe(true);
    expect(asksWhichOrder("Please let me know which order you want to return and the reason.")).toBe(true);
    expect(asksWhichOrder("Your order number is #1012.")).toBe(false);
    expect(asksWhichOrder("What is the reason for the return?")).toBe(false);
  });

  it("lifts answers written into a sentence instead of a list", () => {
    const reply =
      "What is the reason for the return? Here are some options to choose from: Changed my mind, Not as described, Wrong item, Damaged or defective, Too small, or Too big. You can also provide a different reason if you'd like.";
    expect(liftChoices(reply)).toEqual({
      text: "What is the reason for the return?",
      choices: ["Changed my mind", "Not as described", "Wrong item", "Damaged or defective", "Too small", "Too big"],
    });

    // The sentence with the answers can be the question itself.
    expect(liftChoices("Which size would you like: Small, Medium, or Large?")).toEqual({
      text: "Which size would you like?",
      choices: ["Small", "Medium", "Large"],
    });
    // Information with commas in it is not a set of answers.
    expect(liftChoices("We ship to: Canada, Mexico, and the United States.")).toBeNull();
    expect(liftChoices("Your order has three items: a mug, a kettle, and a blanket. Anything else?")).toBeNull();
    expect(liftChoices("Which one: Trail Mug at $18.00, Camp Kettle at $45.00, or both?")).toBeNull();
  });

  it("knows when the shopper is asked why they want to return something", () => {
    expect(asksReturnReason("What is the reason for the return?")).toBe(true);
    expect(asksReturnReason("Could you tell me the reason you'd like to return order #1012?")).toBe(true);
    expect(asksReturnReason("Your return request has been sent with the reason you gave.")).toBe(false);
    expect(asksReturnReason("Which order would you like to return?")).toBe(false);
  });
});
