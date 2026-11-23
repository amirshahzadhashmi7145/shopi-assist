import { describe, expect, it } from "vitest";

import {
  addressErrors,
  DEFAULT_FORM_OPTIONS,
  formLayout,
  formLayouts,
  onlyFormFields,
} from "../app/assistant/address-rules";
import rules from "../app/assistant/address-rules.json";

const names = (countryCode: string, options = DEFAULT_FORM_OPTIONS) =>
  formLayout(countryCode, options).map((row) => row.map((field) => field.name));

describe("address rules", () => {
  it("lays the form out the way each country writes an address", () => {
    expect(names("US")).toEqual([
      ["firstName", "lastName"],
      ["address1"],
      ["address2"],
      ["city", "province", "zip"],
      ["phone"],
    ]);
    // Japan: family name first, and the address from the postal code down.
    expect(names("JP")).toEqual([
      ["lastName", "firstName"],
      ["zip", "province"],
      ["city"],
      ["address1"],
      ["address2"],
      ["phone"],
    ]);
    // No counties to pick in the United Kingdom, no postal codes in the Emirates.
    expect(names("GB").flat()).not.toContain("province");
    expect(names("AE").flat()).not.toContain("zip");
    // Lower case is the same country; an unknown one gets every field.
    expect(names("us")).toEqual(names("US"));
    expect(names("ZZ").flat()).toEqual([
      "firstName",
      "lastName",
      "address1",
      "address2",
      "city",
      "province",
      "zip",
      "phone",
    ]);
  });

  it("names the fields as the country does and says which may be left empty", () => {
    const labels = (countryCode: string) =>
      Object.fromEntries(formLayout(countryCode, DEFAULT_FORM_OPTIONS).flat().map((field) => [field.name, field.label]));
    expect(labels("US")).toMatchObject({ province: "State", zip: "ZIP code", firstName: "First name (optional)" });
    expect(labels("CA")).toMatchObject({ province: "Province", zip: "Postal code" });
    expect(labels("IN")).toMatchObject({ province: "State", zip: "PIN code" });
    expect(labels("AE")).toMatchObject({ province: "Emirate" });
    expect(labels("GB")).toMatchObject({ zip: "Postcode" });
    // Pakistan's postal code is not needed.
    expect(labels("PK")).toMatchObject({ zip: "Postal code (optional)" });
  });

  it("follows the store's choices for first name, company and the second line", () => {
    const strict = { firstName: "required", company: "required", address2: "hidden" } as const;
    const fields = formLayout("US", strict).flat();
    expect(fields.map((field) => field.name)).toEqual([
      "firstName",
      "lastName",
      "company",
      "address1",
      "city",
      "province",
      "zip",
      "phone",
    ]);
    expect(fields.every((field) => field.required)).toBe(true);
    expect(fields.find((field) => field.name === "firstName")!.label).toBe("First name");

    expect(names("US", { ...DEFAULT_FORM_OPTIONS, company: "optional" })[1]).toEqual(["company"]);
    expect(
      onlyFormFields("US", { company: "Acme", address2: "Unit 4", zip: "90210" }, strict),
    ).toEqual({ company: "Acme", address2: "", zip: "90210" });
  });

  it("checks what is missing and what a postal code looks like", () => {
    const filled = {
      lastName: "Lovelace",
      address1: "1 High Street",
      city: "Springfield",
      province: "IL",
      zip: "62704",
      phone: "+12025550143",
    };
    expect(addressErrors("US", filled, DEFAULT_FORM_OPTIONS)).toEqual({});
    expect(addressErrors("US", { ...filled, zip: "62704-1234" }, DEFAULT_FORM_OPTIONS)).toEqual({});
    expect(addressErrors("US", { ...filled, zip: " 6270 ", province: "" }, DEFAULT_FORM_OPTIONS)).toEqual({
      province: "Select a state",
      zip: "Enter a valid ZIP code for the United States, for example 90210",
    });
    expect(addressErrors("CA", { ...filled, zip: "k1a 0b1" }, DEFAULT_FORM_OPTIONS)).toEqual({});
    // An optional postal code is still checked when one is given.
    expect(Object.keys(addressErrors("NZ", { ...filled, province: "", zip: "abc" }, DEFAULT_FORM_OPTIONS))).toEqual([
      "zip",
    ]);
    // Nothing is known about an unknown country's postal codes.
    expect(addressErrors("ZZ", { ...filled, zip: "anything" }, DEFAULT_FORM_OPTIONS)).toEqual({});
  });

  it("sends each distinct form once", () => {
    const { forms, index } = formLayouts(["FR", "BE", "US", "CA"], DEFAULT_FORM_OPTIONS);
    expect(Object.keys(index)).toEqual(["FR", "BE", "US", "CA"]);
    expect(forms[index.US]).toEqual(formLayout("US", DEFAULT_FORM_OPTIONS));
    // France and Belgium ask for the same things under the same names.
    expect(index.FR).toBe(index.BE);
    expect(forms).toHaveLength(3);
  });

  it("has usable data for every country", () => {
    const data = rules as unknown as {
      formats: string[];
      countries: Record<string, { format: number; zip?: { pattern?: string; example?: string } }>;
    };
    expect(Object.keys(data.countries).length).toBeGreaterThan(200);
    for (const [code, country] of Object.entries(data.countries)) {
      expect(data.formats[country.format], code).toContain("{address1}");
      const fields = names(code).flat();
      expect(fields, code).toEqual(expect.arrayContaining(["lastName", "address1", "phone"]));
      // Shopify's own example of a postal code passes Shopify's own pattern.
      if (country.zip?.pattern && country.zip.example) {
        expect(new RegExp(country.zip.pattern, "i").test(country.zip.example), code).toBe(true);
      }
    }
  });
});
