/**
 * What the order form asks for in each country, and how it is checked.
 *
 * Two things decide it:
 *  - the country: which address fields there are, in what order, what they
 *    are called, and whether a postal code is needed and what one looks
 *    like. This comes from address-rules.json, built from the address data
 *    Shopify publishes and builds its own checkout on (see
 *    scripts/build-address-rules.mjs).
 *  - the store: whether a first name is needed, and whether a company name
 *    and a second address line are asked for. Shopify has the same options
 *    under Settings > Checkout but does not let apps read them, so the
 *    merchant sets them again in this app's settings.
 *
 * Nothing here touches Shopify, the database or an LLM.
 */
import rules from "./address-rules.json";

export const ADDRESS_FIELDS = [
  "firstName",
  "lastName",
  "company",
  "address1",
  "address2",
  "city",
  "province",
  "zip",
  "phone",
] as const;
export type AddressField = (typeof ADDRESS_FIELDS)[number];

/** The store's own choices, as in Shopify's checkout settings. */
export interface FormOptions {
  firstName: "optional" | "required";
  company: "hidden" | "optional" | "required";
  address2: "hidden" | "optional" | "required";
}

/** Shopify's defaults for a new store. */
export const DEFAULT_FORM_OPTIONS: FormOptions = {
  firstName: "optional",
  company: "hidden",
  address2: "optional",
};

export interface FormField {
  name: AddressField;
  /** Ready to show: says "(optional)" when the field can be left empty. */
  label: string;
  required: boolean;
}
/** The form's rows, top to bottom; fields in one row sit side by side. */
export type FormLayout = FormField[][];

interface Words {
  label?: string;
  optional?: string;
  blank?: string;
  invalid?: string;
}
interface CountryRules {
  name: string;
  format: number;
  zip?: { required: boolean; pattern?: string; example?: string };
  /** Set only where the country has a list of states or provinces. */
  provinceRequired?: boolean;
  words?: Partial<Record<AddressField, Words>>;
}

const DATA = rules as unknown as {
  formats: string[];
  words: Partial<Record<AddressField, Words>>;
  countries: Record<string, CountryRules>;
};

// For a country the data does not know: every field, nothing extra demanded.
const UNKNOWN_FORMAT =
  "{country}_{firstName}{lastName}_{company}_{address1}_{address2}_{city}{province}{zip}_{phone}";
const UNKNOWN_COUNTRY: CountryRules = {
  name: "",
  format: -1,
  zip: { required: false },
  provinceRequired: false,
};

const isAddressField = (name: string): name is AddressField =>
  (ADDRESS_FIELDS as readonly string[]).includes(name);

function countryRules(countryCode: string): CountryRules {
  return DATA.countries[countryCode.toUpperCase()] ?? UNKNOWN_COUNTRY;
}

function wordsFor(country: CountryRules, field: AddressField): Words {
  return { ...DATA.words[field], ...country.words?.[field] };
}

function requirement(
  field: AddressField,
  country: CountryRules,
  options: FormOptions,
): "hidden" | "optional" | "required" {
  switch (field) {
    case "firstName":
      return options.firstName;
    case "company":
      return options.company;
    case "address2":
      return options.address2;
    case "province":
      // Without a list of them there is nothing to choose from.
      if (country.provinceRequired === undefined) return "hidden";
      return country.provinceRequired ? "required" : "optional";
    case "zip":
      return country.zip?.required ? "required" : "optional";
    default:
      // Someone to hand it to, somewhere to take it, a number to call.
      return "required";
  }
}

/** The fields the order form shows for a delivery to this country. */
export function formLayout(countryCode: string, options: FormOptions): FormLayout {
  const country = countryRules(countryCode);
  const format = DATA.formats[country.format] ?? UNKNOWN_FORMAT;
  const used = new Set<AddressField>();
  const rows: FormLayout = [];

  const field = (name: AddressField): FormField | null => {
    const need = requirement(name, country, options);
    if (need === "hidden" || used.has(name)) return null;
    used.add(name);
    const words = wordsFor(country, name);
    const label = words.label ?? name;
    return {
      name,
      label: need === "required" ? label : (words.optional ?? `${label} (optional)`),
      required: need === "required",
    };
  };

  for (const part of format.split("_")) {
    const row: FormField[] = [];
    // The country has its own place at the top of the form.
    for (const [, name] of part.matchAll(/\{(\w+)\}/g)) {
      const entry = isAddressField(name) ? field(name) : null;
      if (entry) row.push(entry);
    }
    if (row.length) rows.push(row);
  }
  // A layout that leaves one of these out still gets it: an order cannot be
  // delivered without them.
  for (const name of ["lastName", "address1", "phone"] as const) {
    const entry = field(name);
    if (entry) rows.push([entry]);
  }
  return rows;
}

/**
 * Keeps what the country's form asks for and blanks the rest, so a field the
 * shopper never saw cannot reach Shopify.
 */
export function onlyFormFields<Values extends Partial<Record<AddressField, string>>>(
  countryCode: string,
  values: Values,
  options: FormOptions,
): Values {
  const shown = new Set(formLayout(countryCode, options).flat().map((entry) => entry.name));
  const kept = { ...values };
  for (const name of ADDRESS_FIELDS) {
    if (name in kept && !shown.has(name)) (kept as Record<string, string>)[name] = "";
  }
  return kept;
}

/** What is missing or wrong, by field, in Shopify's own wording. */
export function addressErrors(
  countryCode: string,
  values: Partial<Record<AddressField, string>>,
  options: FormOptions,
): Partial<Record<AddressField, string>> {
  const country = countryRules(countryCode);
  const errors: Partial<Record<AddressField, string>> = {};

  for (const entry of formLayout(countryCode, options).flat()) {
    const value = (values[entry.name] ?? "").trim();
    const words = wordsFor(country, entry.name);
    if (!value) {
      if (entry.required) errors[entry.name] = words.blank ?? "This is needed.";
      continue;
    }
    if (entry.name !== "zip" || !country.zip?.pattern) continue;
    if (!new RegExp(country.zip.pattern, "i").test(value)) {
      const message = (words.invalid ?? "Enter a valid postal code for %{country}").replace(
        "%{country}",
        country.name || "this country",
      );
      errors.zip = country.zip.example
        ? `${message}, for example ${country.zip.example}`
        : message;
    }
  }
  return errors;
}

/**
 * The layouts for a list of countries, each stored once: many countries
 * share one. `index[code]` is that country's position in `forms`.
 */
export function formLayouts(
  countryCodes: readonly string[],
  options: FormOptions,
): { forms: FormLayout[]; index: Record<string, number> } {
  const forms: FormLayout[] = [];
  const seen = new Map<string, number>();
  const index: Record<string, number> = {};
  for (const code of countryCodes) {
    const layout = formLayout(code, options);
    const key = JSON.stringify(layout);
    let position = seen.get(key);
    if (position === undefined) {
      position = forms.push(layout) - 1;
      seen.set(key, position);
    }
    index[code] = position;
  }
  return { forms, index };
}
